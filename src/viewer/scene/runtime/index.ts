import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Session } from '@/engine/session';
import type {
  AvatarDescriptor,
  CameraFrame,
  LabelledId,
  Placement,
  PlacementReport,
  Shot,
  SlidePlacement,
  SlideReport,
} from '@/engine/types';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/translate';
import type { BgmCommand, BgmReport } from '@/protocol';
import { BrowserAudioOutput } from '../../audio-output';
import { BrowserBgm } from '../../bgm';
import { StageRecorder } from '../../record';
import { stageMode } from '../../stage-mode';
import { BrowserVoice } from '../../voice';
import { BackdropStage } from '../backdrop';
import { buildFramings } from '../framing';
import {
  FULL_FRAME,
  fitInside,
  hugContent,
  type Rect,
  rectOf,
  resolvePlacement,
  type StageSize,
} from '../placement';
import { SlideStage } from '../slides';
import { FOV, ShotCamera } from './camera';
import { buildHud, HUD_INTERVAL, type Hud } from './hud';
import { disposeAvatar, mountAvatar } from './mount';
import { sceneryPort, shadingPort } from './ports';
import type { Listener, LoadedAvatar, RuntimeStatus, StageFrame } from './types';

export { FOV } from './camera';
export type { Hud } from './hud';
export type { LoadedAvatar, RuntimeStatus, StageFrame } from './types';

/**
 * The three.js side of the viewer, kept out of React entirely.
 *
 * React owns the console; this owns the renderer, the scene graph and the frame
 * loop. The two meet at two narrow places — a host element to mount into, and
 * subscriptions for the readouts — because a 60 Hz simulation is not something
 * a render tree should be reconciling, and an avatar swap is not something a
 * component's lifetime should be tied to.
 *
 * What is left in this file is the scene and the loop: the lights, the two
 * layers behind the character, what fills the frame under both of them, the
 * swap, and the tick that drives all of it. The pieces that answer a question
 * of their own are beside it — `camera.ts` for where the camera stands,
 * `mount.ts` for turning a GLB into a working avatar and letting one go,
 * `hud.ts` for the readout, `ports.ts` for the doors a session reaches this
 * through, and `types.ts` for what all of them hand out.
 */
export class AvatarRuntime {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;

  private readonly host: HTMLElement;
  private readonly loader = new GLTFLoader();
  /** The three lights the viewer ships with, together so a room can hide them. */
  private readonly defaultRig = new THREE.Group();
  private readonly backdrop: BackdropStage;
  /** The document layer, which sits behind everything the renderer draws. */
  private readonly slides: SlideStage;
  /** Where the camera stands, and how a drag on it is published. */
  private readonly shotCamera: ShotCamera;
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
  /**
   * Called at the end of every frame, with the render still on the buffer.
   *
   * A separate set from the two above because it is not a readout: the others
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

    const embedded = window.parent !== window;
    this.shotCamera = new ShotCamera(
      this.renderer.domElement,
      { pointer: stageMode().console || embedded, embedded },
      () => this.resize(),
    );

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

  /** The camera the scene is drawn through. */
  get camera(): THREE.PerspectiveCamera {
    return this.shotCamera.camera;
  }

  /** The orbit controls over it, for the console's own pointer handling. */
  get controls(): ShotCamera['controls'] {
    return this.shotCamera.controls;
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

  onCamera(fn: Listener<CameraFrame>): () => void {
    return this.shotCamera.onCamera(fn);
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
    return this.shotCamera.cameraFrame;
  }

  /** The shot as it stands: the framing, and how far it has been moved off it. */
  get shot(): Required<Shot> {
    return this.shotCamera.shot;
  }

  goto(frame: CameraFrame): void {
    this.shotCamera.goto(frame);
  }

  /** Place the camera. See `ShotCamera.setShot`. */
  setShot(shot: Shot): void {
    this.shotCamera.setShot(shot);
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
    const picture: Rect = fitInside(rectOf(this.avatarPlacement, this.stage), w / h, anchor);
    // And then the character inside that picture is put on the edge, rather
    // than the picture's own edge, which is a quarter of a frame further out.
    // See `hugContent`.
    const rect = hugContent(picture, anchor, this.shotCamera.contentWidth(picture));
    const el = this.renderer.domElement;
    el.style.position = 'absolute';
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    // `setSize` writes the element's width and height itself, so only where it
    // sits is set above.
    this.renderer.setSize(rect.width, rect.height);
    this.shotCamera.setAspect(rect.width / rect.height);
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

    const mounted = mountAvatar(root, avatar, this.toon);
    const { profile, director, wardrobe, materials, problems } = mounted;

    this.shotCamera.rebuild(buildFramings(root, profile, FOV));

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
    disposeAvatar(cur);
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
    this.shotCamera.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.statusListeners.clear();
    this.hudListeners.clear();
    this.frameListeners.clear();
  }

  // --- frame loop -----------------------------------------------------------

  private tick(): void {
    this.timer.update();
    // Capped at 50 ms whatever the frame took. Below 20 fps the simulation
    // deliberately runs slow rather than integrating a step large enough to
    // throw the sway chains, which is a far more visible failure than lag.
    const dt = Math.min(this.timer.getDelta(), 0.05);
    this.shotCamera.update();
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
        const hud = buildHud(cur, { fps: this.fps, voiceBlocked: this.voice.isBlocked });
        for (const fn of this.hudListeners) fn(hud);
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
}
