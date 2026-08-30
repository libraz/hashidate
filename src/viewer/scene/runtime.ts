import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { type MaterialSet, setupMaterials, Wardrobe } from '@/engine/scene';
import { Session } from '@/engine/session';
import type {
  AvatarDescriptor,
  CameraFrame,
  LabelledId,
  Placement,
  PlacementReport,
  Profile,
  Scenery,
  Shading,
  Shot,
  SlidePlacement,
  SlideReport,
} from '@/engine/types';
import { SHOT_LIMITS } from '@/engine/types';
import { getLocale, pick } from '@/i18n/locale';
import type { MessageKey } from '@/i18n/messages';
import { translate } from '@/i18n/translate';
import type { BgmCommand, BgmReport } from '@/protocol';
import { BrowserAudioOutput } from '../audio-output';
import { BrowserBgm } from '../bgm';
import { sendMonitorShot } from '../monitor-link';
import { StageRecorder } from '../record';
import { stageMode } from '../stage-mode';
import { BrowserVoice } from '../voice';
import { BackdropStage } from './backdrop';
import { buildFramings, type Framings } from './framing';
import {
  FULL_FRAME,
  fitInside,
  hugContent,
  type Rect,
  rectOf,
  resolvePlacement,
  type StageSize,
} from './placement';
import { SlideStage } from './slides';

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
  /** The browser refusing this page an audio device. See `BrowserVoice.isBlocked`. */
  voiceBlocked: boolean;
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

/**
 * The composed picture, described so that something else can draw it.
 *
 * What is on screen is not one canvas and cannot be captured as one: the
 * document layer is DOM canvases the browser composites *behind* a WebGL canvas
 * — see `SlideStage` for why the page is not a textured quad — and the flat
 * colour behind both is CSS. Anything that has to produce a single frame of
 * this, which so far means the recorder, has to be told where the pieces are.
 *
 * Every rectangle is in the stage's own CSS pixels, so a consumer drawing at
 * some other size scales all of them by one factor and nothing moves relative
 * to anything else.
 */
export interface StageFrame {
  /** The box every rectangle here is stated against. */
  stage: StageSize;
  /** The character's picture: the WebGL canvas, and where it sits. */
  avatar: { canvas: HTMLCanvasElement; rect: Rect };
  /** The document layer, or null when none is up. See `SlideStage.layers`. */
  slides: {
    rect: Rect;
    canvases: Array<{ canvas: HTMLCanvasElement; opacity: number }>;
    /** Moves when a page is painted, so a held composite knows it is stale. */
    revision: number;
  } | null;
  /**
   * What fills the frame under both layers, as a CSS colour.
   *
   * `rgba(0, 0, 0, 0)` on a source opened transparent, which is the honest
   * answer: there is nothing behind it here, and what a recording puts there is
   * whatever it started the frame with. See `StageMode.transparent`.
   */
  background: string;
}

export type RuntimeStatus =
  | { phase: 'idle' }
  | { phase: 'loading'; avatar: AvatarDescriptor }
  | { phase: 'ready'; loaded: LoadedAvatar }
  | { phase: 'failed'; avatar: AvatarDescriptor; message: string };

type Listener<T> = (value: T) => void;

/** How often the HUD is sampled. It is text, not an instrument; 8 Hz reads live. */
const HUD_INTERVAL = 0.125;

/**
 * How often a dragged shot is published, in milliseconds.
 *
 * Every one of these is a request out of the panel and a frame back down to
 * every renderer, so a drag published per frame would put sixty round trips a
 * second on the wire to move one camera. Ten is enough for the picture going to
 * air to look like it is following the one being dragged.
 */
const SHOT_INTERVAL = 100;

export class AvatarRuntime {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly host: HTMLElement;
  private readonly loader = new GLTFLoader();
  /** The three lights the viewer ships with, together so a room can hide them. */
  private readonly defaultRig = new THREE.Group();
  private readonly backdrop: BackdropStage;
  /** The document layer, which sits behind everything the renderer draws. */
  private readonly slides: SlideStage;
  /**
   * The flat background, held rather than built where it is set.
   *
   * It goes on and off the scene as a document comes up and down, and the
   * colour is the one thing about that which must not drift — a second literal
   * somewhere would eventually be a different grey on either side of a slide.
   */
  private readonly flat = new THREE.Color(0x0f1115);
  /**
   * Whether "no room" means nothing at all rather than that flat colour.
   *
   * Off by default, because the default is a page somebody opened to look at and
   * a transparent one is a checkerboard. On, it is a source stacked over a game
   * capture in OBS — see `StageMode.transparent`, where what it is for is
   * written down.
   */
  private transparent = false;
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
  /**
   * One page-owned graph. The final master is where the URL-selected mute is
   * applied, and both the voice and BGM survive avatar swaps below it.
   */
  private readonly audio = new BrowserAudioOutput({ muted: stageMode().muted });
  private readonly voice = new BrowserVoice({ output: this.audio });
  private readonly bgm = new BrowserBgm({ output: this.audio });

  /**
   * One recorder for the page, on the same reasoning the voice is one.
   *
   * It lives here rather than beside the control channel because it needs both
   * halves of what this class owns and nothing else has either: the frame, at
   * the one moment in the loop it can be read, and the node the voice is coming
   * out of. See `src/viewer/record.ts`.
   */
  private readonly recorder = new StageRecorder({
    onFrame: (fn) => this.onFrame(fn),
    openAudio: () => this.audio.captureStream(),
  });

  private framings: Framings | null = null;
  private frame: CameraFrame = 'bust';
  /** How far the camera has been moved off the framing. See `Shot`. */
  private orbit = { yaw: 0, pitch: 0, zoom: 1 };
  /** True while `place` is moving the camera, so its own change is not published. */
  private placing = false;
  private shotSentAt = 0;
  private shotTimer: ReturnType<typeof setTimeout> | null = null;
  private toon = true;

  /** Where the picture of the character goes in the frame. See `Placement`. */
  private avatarPlacement: Required<Placement> = FULL_FRAME;
  /** The host's size in CSS pixels, which both layers are placed against. */
  private stage: StageSize = { width: 0, height: 0 };
  /**
   * Whether a document was up the last time the background was settled.
   *
   * A deck is opened asynchronously and may fail, so "is something behind the
   * character" is not known at the moment it was asked for. Sampled in the
   * frame loop against this rather than pushed from the slide layer: it is one
   * boolean compare a frame, and it keeps `updateBackground` the only thing
   * that decides what the renderer clears to.
   */
  private documentUp = false;

  private status: RuntimeStatus = { phase: 'idle' };
  private readonly statusListeners = new Set<Listener<RuntimeStatus>>();
  private readonly hudListeners = new Set<Listener<Hud>>();
  private readonly cameraListeners = new Set<Listener<CameraFrame>>();
  /**
   * Called at the end of every frame, with the render still on the buffer.
   *
   * A separate set from the three above because it is not a readout: the others
   * are sampled and this one is not allowed to miss a frame. A WebGL canvas is
   * only readable between the draw and the browser's next composite, so a
   * listener that wanted to copy the picture and was told about it a moment
   * later would get an empty one — which is why this is called from inside the
   * loop rather than promised on a timer, and why nothing here is throttled.
   */
  private readonly frameListeners = new Set<Listener<StageFrame>>();

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

  /** A swap asked for while another was in flight. Started when that one lands. */
  private queued: AvatarDescriptor | null = null;

  constructor(host: HTMLElement) {
    this.host = host;

    // `alpha` can only be decided when the context is made, and a document
    // behind the character needs the frame to be clearable to nothing. With
    // none up the scene's background paints every pixel opaque, so this costs
    // an alpha channel nothing ever reads.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Above the document layer. Both are stated, because an absolutely
    // positioned canvas paints over a static sibling whatever the order is.
    this.renderer.domElement.style.zIndex = '1';
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = this.flat;

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    /**
     * The pointer moves the camera on a page that is a tool, and not on one
     * that is an output.
     *
     * A bare page is what OBS opens, and a shot nudged there by a stray drag is
     * a shot the panel no longer agrees with — silently, because nothing tells
     * the panel it happened. The console has the pointer because it is the
     * development view, and an embedded preview has it because that is now how
     * the shot is set: the panel frames this page and publishes what the drag
     * produced. See `readShot` and `monitor-link.ts`.
     */
    const embedded = window.parent !== window;
    this.controls.enabled = stageMode().console || embedded;
    if (embedded) {
      // Panning moves the target off the framing, and there is no pan axis in a
      // `Shot` to say so — a shot read back from a panned camera would be a
      // bearing around the wrong point.
      this.controls.enablePan = false;
      // Slower than the default, because the picture being dragged is a monitor
      // a few hundred pixels tall and three.js measures a rotation against that
      // height. At 1.0 a short drag swings the camera round behind the
      // character; the operator here is nudging a shot, not exploring a model.
      this.controls.rotateSpeed = 0.4;
      this.controls.zoomSpeed = 0.5;
      // Stopped where the wire stops. A drag that could push the camera past
      // what the schema accepts would produce a command that is dropped on
      // arrival, and the preview would be the only picture that moved.
      this.controls.minPolarAngle = Math.PI / 2 - THREE.MathUtils.degToRad(SHOT_LIMITS.pitch.max);
      this.controls.maxPolarAngle = Math.PI / 2 - THREE.MathUtils.degToRad(SHOT_LIMITS.pitch.min);
      this.controls.addEventListener('change', () => this.shotMoved());
    }

    // Toon materials blow out easily; these levels are tuned for MeshToonMaterial.
    //
    // Held in a group so a backdrop can hide the whole rig with one flag. A room
    // brings its own light — that is most of what distinguishes one room from
    // another — and the alternative to switching this off is scaling it, which
    // would mean these numbers being read and multiplied somewhere else.
    this.defaultRig.add(new THREE.HemisphereLight(0xffffff, 0x4a5160, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(1, 1.6, 2.5);
    this.defaultRig.add(key);
    const rim = new THREE.DirectionalLight(0xbcd2ff, 0.35);
    rim.position.set(-1.6, 0.8, -2);
    this.defaultRig.add(rim);
    this.scene.add(this.defaultRig);

    this.backdrop = new BackdropStage(this.scene, this.renderer, [this.defaultRig]);
    // Read here rather than passed in, because the room is not something any
    // caller of this class decides — it is on the URL the source was opened
    // with, and the same reader that answers "is this a stage" answers it.
    this.backdrop.setBackdrop(stageMode().backdrop);

    // The document and the layout are on the URL for the same reason the room
    // is: they are properties of the source OBS holds, and a scene configured
    // to open on a deck should open on it after every reload.
    const mode = stageMode();
    this.transparent = mode.transparent;
    this.applyTransparent();
    this.slides = new SlideStage(host);
    if (mode.deck) this.slides.setDeck(mode.deck);
    this.avatarPlacement = resolvePlacement(this.avatarPlacement, mode.place.avatar);
    this.slides.setPlacement(mode.place.slide);
    this.updateBackground();

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

  /**
   * Every frame, immediately after it is drawn. See `frameListeners`.
   *
   * Nothing subscribes to this in the ordinary course of a broadcast; it exists
   * for the recorder, and costs one empty loop a frame while nobody is
   * recording.
   */
  onFrame(fn: Listener<StageFrame>): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /**
   * Where the pieces of the picture are, right now. See `StageFrame`.
   *
   * Built per call rather than kept, because every field of it is derived from
   * something that moves — a placement command, a page turn, a resize — and a
   * cached copy would be a fourth thing that has to be invalidated by all
   * three.
   */
  stageFrame(): StageFrame {
    const el = this.renderer.domElement;
    return {
      stage: { ...this.stage },
      avatar: {
        canvas: el,
        // Read off the element rather than recomputed: `resize` is the one path
        // that places it, and asking it twice is how the two answers come to
        // differ. See `resize`.
        rect: {
          left: Number.parseFloat(el.style.left) || 0,
          top: Number.parseFloat(el.style.top) || 0,
          width: el.clientWidth,
          height: el.clientHeight,
        },
      },
      slides: this.slides.layers(),
      // Read off the element rather than restated from `flat`. What is behind
      // both layers is CSS — `--bg`, or nothing at all on a transparent source
      // — and this is the same string the browser is painting with, including
      // the `rgba(0, 0, 0, 0)` that a transparent source computes to and that a
      // 2D context correctly draws as nothing.
      background: getComputedStyle(this.host).backgroundColor,
    };
  }

  /**
   * Start or stop recording this renderer's composed frame.
   *
   * Whether this page should be the one recording is settled before the call
   * gets here; see `RendererControls.setRecording`.
   */
  setRecording(
    on: boolean,
    take: { session: string; width: number; height: number; fps: number },
  ): void {
    if (on) void this.recorder.start(take);
    else void this.recorder.stop();
  }

  /** Why the last take would not start, or null. Rides on the report. */
  get recordingError(): string | null {
    return this.recorder.error;
  }

  /** Apply a server-canonical BGM command without involving the avatar session. */
  setBgm(command: BgmCommand): void {
    this.bgm.apply(command);
  }

  /** The BGM state sent with the control heartbeat. */
  get bgmReport(): BgmReport {
    return this.bgm.report();
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status;
    for (const fn of this.statusListeners) fn(status);
  }

  // --- camera ---------------------------------------------------------------

  get cameraFrame(): CameraFrame {
    return this.frame;
  }

  /** The shot as it stands: the framing, and how far it has been moved off it. */
  get shot(): Required<Shot> {
    return { frame: this.frame, ...this.orbit };
  }

  goto(frame: CameraFrame): void {
    this.setShot({ frame });
  }

  /**
   * Place the camera.
   *
   * An absent field is left where it was, which is what lets a drag send two
   * numbers: the framing decides how much of the character is in shot, and the
   * three offsets say where the operator is standing to see it. See `Shot`.
   */
  setShot(shot: Shot): void {
    if (shot.frame !== undefined && shot.frame !== this.frame) {
      this.frame = shot.frame;
      for (const fn of this.cameraListeners) fn(this.frame);
    }
    if (shot.yaw !== undefined) this.orbit.yaw = shot.yaw;
    if (shot.pitch !== undefined) this.orbit.pitch = shot.pitch;
    if (shot.zoom !== undefined) this.orbit.zoom = shot.zoom;
    this.place();
    // How much of the picture the character fills is a property of the shot —
    // a full-length figure fills less of it than a face — and where the canvas
    // sits is derived from that. Without this a framing change moves the
    // character within a rectangle that stayed where the last one needed it.
    this.resize();
  }

  /**
   * Put the camera where the framing and the offsets say, in world space.
   *
   * The framing gives a target and a straight-on distance; the offsets turn that
   * into a bearing around the target. Everything is derived, so a swap that
   * rebuilds the framings puts the same shot on a differently-proportioned
   * avatar rather than leaving the camera where the last one needed it.
   *
   * Where the picture *sits* in the frame is not here and must not be: see
   * `resize`. A shot is what the camera can see; a placement is where that
   * picture is put afterwards, and the two are kept apart so that putting the
   * character in a corner cannot quietly change what is in shot.
   */
  private place(): void {
    const f = this.framings?.[this.frame];
    if (!f) return;
    const base = f.position.distanceTo(f.target);
    // The dolly stops where the wire does, and the framing decides in metres
    // what that means — so it is set here, where the framing is known, rather
    // than once in the constructor when there is no avatar yet.
    this.controls.minDistance = base / SHOT_LIMITS.zoom.max;
    this.controls.maxDistance = base / SHOT_LIMITS.zoom.min;
    const spherical = new THREE.Spherical(
      base / this.orbit.zoom,
      // `phi` is measured from straight up, so level is a right angle and a
      // positive pitch tilts the camera above the target — looking down.
      Math.PI / 2 - THREE.MathUtils.degToRad(this.orbit.pitch),
      THREE.MathUtils.degToRad(this.orbit.yaw),
    );
    this.controls.target.copy(f.target);
    this.camera.position.copy(f.target).add(new THREE.Vector3().setFromSpherical(spherical));
    // `update` dispatches a change, and on an embedded page a change is what
    // publishes the shot. Without the flag, a shot arriving from the panel
    // would be sent straight back to it.
    this.placing = true;
    this.controls.update();
    this.placing = false;
  }

  /**
   * The pointer moved the camera on an embedded page. Tell whoever framed us.
   *
   * Throttled with a trailing send rather than published per frame: a drag is
   * sixty changes a second and every one of them would be an HTTP request out
   * of the panel and an SSE frame back to every renderer. The trailing send is
   * the one that matters — damping keeps the camera moving after the pointer
   * has stopped, so the last change is the only one that says where the shot
   * actually ended up.
   */
  private shotMoved(): void {
    if (this.placing) return;
    const since = Date.now() - this.shotSentAt;
    if (since >= SHOT_INTERVAL) {
      this.publishShot();
      return;
    }
    if (this.shotTimer !== null) return;
    this.shotTimer = setTimeout(() => {
      this.shotTimer = null;
      this.publishShot();
    }, SHOT_INTERVAL - since);
  }

  private publishShot(): void {
    const shot = this.readShot();
    if (!shot) return;
    this.shotSentAt = Date.now();
    sendMonitorShot(shot);
  }

  /**
   * Read the shot back off the camera, after the pointer has moved it.
   *
   * The inverse of `place`, and only meaningful while the target is still the
   * framing's — which is why panning is switched off wherever this is used.
   */
  private readShot(): Required<Shot> | null {
    const f = this.framings?.[this.frame];
    if (!f) return null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (spherical.radius < 1e-4) return null;
    return {
      frame: this.frame,
      yaw: THREE.MathUtils.radToDeg(spherical.theta),
      pitch: 90 - THREE.MathUtils.radToDeg(spherical.phi),
      zoom: f.position.distanceTo(f.target) / spherical.radius,
    };
  }

  get toonEnabled(): boolean {
    return this.toon;
  }

  setToon(on: boolean): void {
    this.toon = on;
    this.current?.materials.apply(on);
  }

  get backdropId(): string | null {
    return this.backdrop.current;
  }

  /** The rooms this renderer can show. See `sceneryPort`. */
  get backdrops(): LabelledId[] {
    return this.backdrop.backdrops;
  }

  /**
   * Put the avatar in a room, or take it out.
   *
   * Survives an avatar swap, because the room is a property of the stream and
   * not of who is on it — rebuilding it on every switch would mean a visible
   * rebuild of the geometry and a second of flat grey in the middle of what is
   * otherwise a seamless change.
   */
  setBackdrop(id: string | null): void {
    this.backdrop.setBackdrop(id);
    // A room taken down restores the background the scene was built with, which
    // is the flat colour — right for a page somebody is looking at and wrong for
    // a source over a game capture. Re-deciding here is what keeps the two
    // answers from depending on which order the operator clicked them in.
    this.updateBackground();
  }

  get isTransparent(): boolean {
    return this.transparent;
  }

  /**
   * Switch between the flat colour and nothing, for when there is no room.
   *
   * Live rather than read once, because the operator composing a source URL has
   * to be able to see what they are about to paste. On the page itself the
   * result is a checkerboard, which reads as "there is nothing here" — which is
   * the point, and is what the game underneath will fill in OBS.
   */
  setTransparent(on: boolean): void {
    if (this.transparent === on) return;
    this.transparent = on;
    this.applyTransparent();
    this.updateBackground();
  }

  /**
   * The half of transparency that is not the renderer's.
   *
   * A browser source is transparent where the *page* is, and clearing the WebGL
   * canvas to zero alpha only uncovers whatever CSS painted underneath it. The
   * page has two opaque layers below the canvas — the document body and the
   * stage element the canvas sits in — and both have to go with it or the result
   * is the same flat colour arriving by a different route, which is exactly the
   * kind of bug that looks fine in the browser and is only wrong in OBS.
   *
   * An attribute on the root rather than inline styles, so the two rules live
   * next to the colours they override instead of as strings in here. It is set
   * on the document because that is what a capture sees; a page with two of
   * these renderers on it does not exist.
   */
  private applyTransparent(): void {
    const root = this.host.ownerDocument.documentElement;
    if (this.transparent) root.dataset.transparent = '1';
    else delete root.dataset.transparent;
  }

  // --- the document, and where both layers sit ------------------------------

  /** What the document layer is doing, for the report and the console. */
  get slideReport(): SlideReport {
    return this.slides.report();
  }

  /**
   * Both layers as they stand, resolved.
   *
   * Read off what each layer is applying rather than off the patches that got
   * them there: the character's rectangle is what `resize` last used and the
   * document's is what `SlideStage` last laid out, so a placement that came off
   * the URL is reported exactly like one that arrived as a command.
   */
  get placement(): PlacementReport {
    return { avatar: this.avatarPlacement, slide: this.slides.slidePlacement };
  }

  setDeck(id: string | null, page?: number): void {
    this.slides.setDeck(id, page);
  }

  setSlide(page: number): void {
    this.slides.setSlide(page);
  }

  turnSlide(by: number): void {
    this.slides.turnSlide(by);
  }

  /**
   * Lay out the frame.
   *
   * Both halves are partials landing on what is set, so a slider under the
   * pointer sends one number. The character's half goes through `resize`, which
   * stays the only thing that sizes the canvas — the shot is untouched, and
   * what changes is how much of the frame the picture of it occupies.
   */
  setPlacement(placement: { avatar?: Placement; slide?: SlidePlacement }): void {
    if (placement.avatar) {
      this.avatarPlacement = resolvePlacement(this.avatarPlacement, placement.avatar);
      this.resize();
    }
    if (placement.slide) this.slides.setPlacement(placement.slide);
  }

  /**
   * What is behind everything, decided in one place.
   *
   * The answers are mutually exclusive and each is made of three settings that
   * have to agree — a scene background, a clear alpha and a room. Split across
   * the places that change them, the failure is a room drawn over the document,
   * or a transparent frame with nothing behind it, and neither is visible until
   * a segment is live.
   *
   * There are two ways to reach transparent and they are not the same thing. A
   * document is up, so the room has to get out of the way and come back the
   * moment it comes down; or the source was opened knowing something is
   * underneath it, and then transparent is the resting state and there is
   * nothing to restore. Only the first suspends the room, which is why the two
   * are not folded into one condition.
   */
  private updateBackground(): void {
    this.documentUp = this.slides.up;
    if (this.documentUp) {
      this.backdrop.suspend();
      this.scene.background = null;
      this.renderer.setClearAlpha(0);
      return;
    }
    this.backdrop.resume();
    // A room puts its own background back as it comes up; what happens with no
    // room is the flat colour, or nothing, and the source says which.
    if (this.backdrop.current !== null) {
      this.renderer.setClearAlpha(1);
      return;
    }
    this.scene.background = this.transparent ? null : this.flat;
    this.renderer.setClearAlpha(this.transparent ? 0 : 1);
  }

  /**
   * The one path that sizes anything.
   *
   * The character is put in a corner by shrinking the canvas element rather
   * than by moving the camera. The camera is where the shot is, and a shot is
   * not a property of where the picture lands: moving it to put the character
   * in a corner would re-frame every line of a segment and would put the
   * gestures, which are authored against a framing, somewhere they were never
   * drawn for. Here the shot is untouched and the picture of it is smaller.
   */
  /**
   * How much of a picture of this width the character actually fills, 0 to 1.
   *
   * The framing decides the height of the world in shot and the aspect decides
   * the width, so what is left over at the sides is arithmetic rather than
   * something anybody chose. 1 before an avatar has loaded — nothing is in the
   * picture yet, so there is no gap to close and nothing to move.
   */
  private contentWidth(picture: Rect): number {
    const f = this.framings?.[this.frame];
    if (!f || picture.height === 0) return 1;
    const world = (f.height / this.orbit.zoom) * (picture.width / picture.height);
    return world === 0 ? 1 : (2 * f.halfWidth) / world;
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.stage = { width: w, height: h };
    this.slides.resize(this.stage);
    // The placement gives an *area*; the canvas is the largest frame-shaped box
    // inside it. That is what keeps a rectangle from deciding the shot — see
    // `fitInside`, where the two answers that do let it are written down. The
    // shape asked for is the stage's own rather than 16:9, so a source of any
    // proportion shows a scaled copy of what it would have shown full frame.
    const anchor = this.avatarPlacement.anchor;
    const picture = fitInside(rectOf(this.avatarPlacement, this.stage), w / h, anchor);
    // And then the character inside that picture is put on the edge, rather
    // than the picture's own edge, which is a quarter of a frame further out.
    // See `hugContent`.
    const rect = hugContent(picture, anchor, this.contentWidth(picture));
    const el = this.renderer.domElement;
    el.style.position = 'absolute';
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    // `setSize` writes the element's width and height itself, so only where it
    // sits is set above.
    this.renderer.setSize(rect.width, rect.height);
    this.camera.aspect = rect.width / rect.height;
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
    // Asked for during another load, the request waits rather than being
    // dropped. That case used to be theoretical and is now the ordinary one:
    // the control server hands a viewer the setup the moment its stream
    // connects, and the stream connects while the first model is still coming
    // down. Dropped, the avatar the operator chose would silently not appear.
    if (this.loading) {
      this.queued = avatar.id === this.loading ? null : avatar;
      return;
    }
    if (avatar.id === this.current?.avatar.id) return;
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
        message: translate('console.problem.load', getLocale(), {
          url: avatar.url,
          reason: String(e instanceof Error ? e.message : e),
        }),
      });
      this.drainQueued();
      return;
    }

    this.unmount();
    this.loading = null;

    const root = gltf.scene;
    this.scene.add(root);

    // Casts, but does not receive. The shadow the avatar throws on the wall
    // behind it is what puts it in the room rather than in front of a picture of
    // one, and costs a second pass over geometry that is already skinned.
    // Receiving is the other half and is deliberately left off: a skinned mesh
    // self-shadowing at these bone counts stipples the face at exactly the
    // framing the stream spends all its time at.
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });

    const materials = setupMaterials(root, avatar);
    materials.apply(this.toon);

    const profile = buildProfile(root, avatar);
    const problems: string[] = [];
    // Worded in the language in force when the model came up. These are read
    // off the console beside the model they describe, and a swap is what
    // rebuilds them, so following a later switch would mean carrying every
    // finding as a pair for a line nobody re-reads.
    const say = (key: MessageKey, names: string[], separator: string) =>
      problems.push(translate(key, getLocale(), { names: names.join(separator) }));
    if (profile.missing.length) say('console.problem.profile', profile.missing, ', ');

    const director = new Director(profile, avatar);
    const wardrobe = new Wardrobe(root, profile, avatar.wardrobe);
    if (wardrobe.missing.length) say('console.problem.wardrobe', wardrobe.missing, ' / ');
    if (director.spring.missing.length) {
      say('console.problem.sway', director.spring.missing, ' / ');
    }
    if (director.tail.missing.length) {
      say('console.problem.tail', director.tail.missing, ' / ');
    }

    this.framings = buildFramings(root, profile, FOV);
    // `place`, not `goto`: the framings were just rebuilt for a body of another
    // size, and the shot the operator set up should survive that. The offsets
    // are relative for exactly this reason.
    this.place();

    const session = new Session(director, {
      wardrobe,
      camera: (shot) => this.setShot(shot),
      // A port rather than the stage itself, narrow enough that a session
      // cannot reach anything else here — and routed through `setBackdrop` so
      // that a room changed by a line settles the background the same way a
      // room changed from the console does. See `sceneryPort`. A new session is
      // built on every avatar swap and the room it is handed is the one already
      // standing — the set does not change because the actor did.
      scenery: sceneryPort(this),
      voice: this.voice,
      // The renderer's own switch, narrowed to a port for the same reason the
      // backdrop is: a session tuning the shading has to be able to say so
      // without being handed everything else that draws.
      shading: shadingPort(this),
      // The document layer directly, on the same footing as the backdrop: it is
      // already exactly the port, and it survives an avatar swap because what
      // is being presented has nothing to do with who is presenting it.
      slides: this.slides,
      // The frame's layout, which is neither of the two above — it moves both
      // of them, and the character's half is the canvas rather than the scene.
      // It answers from what is being drawn rather than from what it was told,
      // which is the only version a panel can be drawn at.
      composition: {
        setPlacement: (placement) => this.setPlacement(placement),
        report: () => this.placement,
      },
    });

    this.current = { avatar, root, profile, director, session, wardrobe, materials, problems };
    this.resize();
    this.setStatus({ phase: 'ready', loaded: this.current });
    this.drainQueued();
  }

  /**
   * Which avatar is on screen, on its way, or waiting behind the one on its way.
   *
   * The answer a caller needs before asking for a swap: matching it means the
   * request would do nothing at all, and a control channel holding commands
   * behind a load that is never going to happen goes quiet for good.
   */
  get avatarId(): string | null {
    return this.queued?.id ?? this.loading ?? this.current?.avatar.id ?? null;
  }

  private drainQueued(): void {
    const next = this.queued;
    this.queued = null;
    if (next) void this.load(next);
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
    // Before the voice, which is where the take's audio track comes from, and
    // before the loop stops feeding it frames. A page closed mid-take still
    // posts its last chunk, so the file on the server is closed rather than
    // left for the watchdog.
    void this.recorder.stop();
    this.bgm.dispose();
    this.voice.dispose();
    this.audio.dispose();
    this.unmount();
    this.slides.dispose();
    this.backdrop.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.statusListeners.clear();
    this.hudListeners.clear();
    this.cameraListeners.clear();
    this.frameListeners.clear();
  }

  // --- frame loop -----------------------------------------------------------

  private tick(): void {
    this.timer.update();
    // Capped at 50 ms whatever the frame took. Below 20 fps the simulation
    // deliberately runs slow rather than integrating a step large enough to
    // throw the sway chains, which is a far more visible failure than lag.
    const dt = Math.min(this.timer.getDelta(), 0.05);
    this.controls.update();
    // A document is opened asynchronously and may never open at all, so the
    // moment it is actually up is not the moment it was asked for.
    if (this.slides.up !== this.documentUp) this.updateBackground();
    this.backdrop.update(dt);

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

    // After the render and inside the same frame, which is the whole contract:
    // the drawing buffer is readable here and is gone by the next tick. See
    // `frameListeners`. The frame is built only when somebody is listening,
    // because assembling it reads a computed style.
    if (this.frameListeners.size > 0) {
      const frame = this.stageFrame();
      for (const fn of this.frameListeners) fn(frame);
    }
  }

  private publishHud(cur: LoadedAvatar): void {
    const { director, profile, avatar } = cur;
    const channel = profile.arkit.supported
      ? `ARKit ${profile.arkit.count}/52`
      : avatar.emotionShapes
        ? translate('console.hud.channel.custom', getLocale())
        : translate('console.hud.channel.vrm', getLocale());
    // Resolved here rather than carried as a pair: the HUD is this page's own
    // instrument, so the locale in force on this page is the right answer.
    const gestureLabel = director.body.gesture?.def.label ?? null;
    const hud: Hud = {
      fps: this.fps,
      channel,
      morphs: Object.keys(profile.dict).length,
      sway: director.spring.enabled ? director.spring.count : null,
      breath: director.body.breath,
      blink: director.blink,
      gazeX: director.body.gaze.x,
      speaking: director.mouth.speaking,
      gesture: gestureLabel ? pick(gestureLabel, getLocale()) : null,
      expression: director.expression,
      auto: director.auto,
      voiceBlocked: this.voice.isBlocked,
    };
    for (const fn of this.hudListeners) fn(hud);
  }
}

/**
 * The room, as a session may reach it.
 *
 * Deliberately not `BackdropStage` itself, which is the same object and the
 * wrong door. Changing a room takes the standing one down, and what is behind
 * the character afterwards depends on the document layer and on how the source
 * was opened — neither of which a room knows. A `backdrop` on a line that went
 * straight to the stage would leave the character's canvas opaque over a page
 * until the document came down and the frame loop noticed. `updateBackground`
 * is the only thing allowed to decide what is behind both layers, and this is
 * what keeps every route to a room going past it.
 */
function sceneryPort(runtime: AvatarRuntime): Scenery {
  return {
    get backdrops(): LabelledId[] {
      return runtime.backdrops;
    },
    setBackdrop: (id) => runtime.setBackdrop(id),
  };
}

/**
 * The renderer's shading, as the one switch a session may reach.
 *
 * A free function rather than an object literal inside the class, because the
 * getter has to close over the runtime and a getter cannot be an arrow.
 */
function shadingPort(runtime: AvatarRuntime): Shading {
  return {
    get toon(): boolean {
      return runtime.toonEnabled;
    },
    setToon: (on) => runtime.setToon(on),
  };
}
