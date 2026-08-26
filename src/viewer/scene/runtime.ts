import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { type MaterialSet, setupMaterials, Wardrobe } from '@/engine/scene';
import { Session } from '@/engine/session';
import type { AvatarDescriptor, CameraFrame, Profile } from '@/engine/types';
import { buildFramings, type Framings } from './framing';

/**
 * The three.js side of the viewer, kept out of React entirely.
 *
 * React owns the console; this owns the renderer, the scene graph and the frame
 * loop. The two meet at two narrow places — a host element to mount into, and
 * subscriptions for the readouts — because a 60 Hz simulation is not something
 * a render tree should be reconciling, and an avatar swap is not something a
 * component's lifetime should be tied to.
 */

const FOV = 28;

/** Live figures for the on-canvas readout. Sampled, not per-frame. */
export interface Hud {
  fps: number;
  channel: string;
  morphs: number;
  sway: number | null;
  breath: number;
  blink: number;
  gazeX: number;
  speaking: boolean;
  gesture: string | null;
  expression: string | null;
  auto: boolean;
}

export interface LoadedAvatar {
  avatar: AvatarDescriptor;
  root: THREE.Object3D;
  profile: Profile;
  director: Director;
  session: Session;
  wardrobe: Wardrobe;
  materials: MaterialSet;
  /** Everything the profile, wardrobe or sway layer could not resolve. */
  problems: string[];
}

export type RuntimeStatus =
  | { phase: 'idle' }
  | { phase: 'loading'; avatar: AvatarDescriptor }
  | { phase: 'ready'; loaded: LoadedAvatar }
  | { phase: 'failed'; avatar: AvatarDescriptor; message: string };

type Listener<T> = (value: T) => void;

/** How often the HUD is sampled. It is text, not an instrument; 8 Hz reads live. */
const HUD_INTERVAL = 0.125;

export class AvatarRuntime {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly host: HTMLElement;
  private readonly loader = new GLTFLoader();
  /**
   * `Timer` rather than `Clock`, which three deprecated in 0.185.
   *
   * The upgrade is worth having on its own: `Timer` hooks the Page Visibility
   * API, so a backgrounded tab does not come back with a delta measured in
   * minutes. Everything downstream integrates that delta — the spring solver
   * would try to catch up a minute of simulation, and the blink scheduler would
   * fire a burst — and the frame cap below only bounds it, it does not explain
   * where a huge delta came from.
   */
  private readonly timer = new THREE.Timer();
  private readonly camWorld = new THREE.Vector3();
  private readonly resizeObserver: ResizeObserver;

  private framings: Framings | null = null;
  private frame: CameraFrame = 'bust';
  private toon = true;

  private status: RuntimeStatus = { phase: 'idle' };
  private readonly statusListeners = new Set<Listener<RuntimeStatus>>();
  private readonly hudListeners = new Set<Listener<Hud>>();
  private readonly cameraListeners = new Set<Listener<CameraFrame>>();

  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 0;
  private hudAcc = 0;

  /**
   * The loaded avatar. Read by the frame loop, which is started once and never
   * restarted — a swap replaces what is under it.
   */
  current: LoadedAvatar | null = null;

  /**
   * A GLB takes a second or two to arrive, and during that window `current` is
   * null — so an "already on this avatar" check cannot see an in-flight load.
   * Without this, two clicks land two roots in the scene and only the second is
   * ever released.
   */
  private loading: string | null = null;

  constructor(host: HTMLElement) {
    this.host = host;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1115);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Toon materials blow out easily; these levels are tuned for MeshToonMaterial.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5160, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(1, 1.6, 2.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd2ff, 0.35);
    rim.position.set(-1.6, 0.8, -2);
    this.scene.add(rim);

    // The console is a fixed-width panel beside a flexible stage, so the canvas
    // resizes when the window does and also when the panel is shown or hidden.
    // Observing the host covers both without a window listener that fires for
    // changes this element never saw.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();

    // Opt into the Page Visibility API. Without this the timer is just a clock.
    this.timer.connect(document);
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // --- subscriptions --------------------------------------------------------

  onStatus(fn: Listener<RuntimeStatus>): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  onHud(fn: Listener<Hud>): () => void {
    this.hudListeners.add(fn);
    return () => this.hudListeners.delete(fn);
  }

  /**
   * The framing is set from two places — the console's picker and the control
   * API's `camera` command — so the runtime owns it and the picker follows.
   * Held as React state instead, a shot changed by the orchestrator would move
   * the camera and leave the control showing the old framing.
   */
  onCamera(fn: Listener<CameraFrame>): () => void {
    this.cameraListeners.add(fn);
    fn(this.frame);
    return () => this.cameraListeners.delete(fn);
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status;
    for (const fn of this.statusListeners) fn(status);
  }

  // --- camera ---------------------------------------------------------------

  get cameraFrame(): CameraFrame {
    return this.frame;
  }

  goto(frame: CameraFrame): void {
    this.frame = frame;
    for (const fn of this.cameraListeners) fn(frame);
    const f = this.framings?.[frame];
    if (!f) return;
    this.controls.target.copy(f.target);
    this.camera.position.copy(f.position);
    this.controls.update();
  }

  get toonEnabled(): boolean {
    return this.toon;
  }

  setToon(on: boolean): void {
    this.toon = on;
    this.current?.materials.apply(on);
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // --- loading --------------------------------------------------------------

  /**
   * Swap the avatar in place.
   *
   * A reload would be simpler and is the wrong shape: the point of the exercise
   * is that the engine holds no avatar state, and a swap that survives a live
   * control connection is what demonstrates it. Anything left behind from the
   * previous avatar — a morph still driven, a panel timer still polling a dead
   * director — shows up here rather than in production.
   */
  async load(avatar: AvatarDescriptor): Promise<void> {
    if (this.loading || avatar.id === this.current?.avatar.id) return;
    this.loading = avatar.id;
    this.setStatus({ phase: 'loading', avatar });

    let gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>;
    try {
      gltf = await this.loader.loadAsync(avatar.url);
    } catch (e) {
      this.loading = null;
      this.setStatus({
        phase: 'failed',
        avatar,
        message: `GLB の読み込みに失敗 (${avatar.url}): ${e instanceof Error ? e.message : e}`,
      });
      return;
    }

    this.unmount();
    this.loading = null;

    const root = gltf.scene;
    this.scene.add(root);

    const materials = setupMaterials(root, avatar);
    materials.apply(this.toon);

    const profile = buildProfile(root, avatar);
    const problems: string[] = [];
    if (profile.missing.length) problems.push(`プロファイル未解決: ${profile.missing.join(', ')}`);

    const director = new Director(profile, avatar);
    const wardrobe = new Wardrobe(root, profile, avatar.wardrobe);
    if (wardrobe.missing.length) problems.push(`衣装未解決: ${wardrobe.missing.join(' / ')}`);
    if (director.spring.missing.length) {
      problems.push(`揺れもの未解決: ${director.spring.missing.join(' / ')}`);
    }
    if (director.tail.missing.length) {
      problems.push(`尻尾の駆動未解決: ${director.tail.missing.join(' / ')}`);
    }

    this.framings = buildFramings(root, profile, FOV);
    this.goto(this.frame);

    const session = new Session(director, {
      wardrobe,
      camera: (frame) => this.goto(frame),
    });

    this.current = { avatar, root, profile, director, session, wardrobe, materials, problems };
    this.resize();
    this.setStatus({ phase: 'ready', loaded: this.current });
  }

  /** Release a loaded avatar: scene graph and every GPU resource it brought. */
  private unmount(): void {
    const cur = this.current;
    if (!cur) return;
    this.scene.remove(cur.root);
    // Materials and their textures belong to the material layer, which holds
    // both the imported set and the toon set; only the geometry is ours.
    cur.materials.dispose();
    // Geometry, and the two GPU resources that hang off a skinned mesh rather
    // than off its material: the skeleton's bone texture and the morph-target
    // array texture. Neither is reachable by walking materials, and neither
    // shows up as anything but a slowly climbing texture count.
    const skeletons = new Set<THREE.Skeleton>();
    cur.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry?.dispose();
      o.geometry?.morphTexture?.dispose();
      if (o instanceof THREE.SkinnedMesh && o.skeleton) skeletons.add(o.skeleton);
    });
    for (const s of skeletons) s.dispose();
    this.current = null;
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.timer.dispose();
    this.unmount();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.statusListeners.clear();
    this.hudListeners.clear();
    this.cameraListeners.clear();
  }

  // --- frame loop -----------------------------------------------------------

  private tick(): void {
    this.timer.update();
    // Capped at 50 ms whatever the frame took. Below 20 fps the simulation
    // deliberately runs slow rather than integrating a step large enough to
    // throw the sway chains, which is a far more visible failure than lag.
    const dt = Math.min(this.timer.getDelta(), 0.05);
    this.controls.update();

    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    const cur = this.current;
    if (cur) {
      this.camera.getWorldPosition(this.camWorld);
      // Before the director: a turn started this frame has to have its emotion
      // and gesture in place before the director composes the frame.
      cur.session.update(dt);
      cur.director.update(dt, { headWorldTarget: this.camWorld });

      this.hudAcc += dt;
      if (this.hudAcc >= HUD_INTERVAL && this.hudListeners.size > 0) {
        this.hudAcc = 0;
        this.publishHud(cur);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  private publishHud(cur: LoadedAvatar): void {
    const { director, profile, avatar } = cur;
    const channel = profile.arkit.supported
      ? `ARKit ${profile.arkit.count}/52`
      : avatar.emotionShapes
        ? '固有シェイプ合成'
        : 'VRM プリセット';
    const hud: Hud = {
      fps: this.fps,
      channel,
      morphs: Object.keys(profile.dict).length,
      sway: director.spring.enabled ? director.spring.count : null,
      breath: director.body.breath,
      blink: director.blink,
      gazeX: director.body.gaze.x,
      speaking: director.mouth.speaking,
      gesture: director.body.gesture?.def.label ?? null,
      expression: director.expression,
      auto: director.auto,
    };
    for (const fn of this.hudListeners) fn(hud);
  }
}
