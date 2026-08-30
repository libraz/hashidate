import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraFrame, Shot } from '@/engine/types';
import { SHOT_LIMITS } from '@/engine/types';
import { sendMonitorShot } from '../../monitor-link';
import type { Framings } from '../framing';
import type { Rect } from '../placement';
import type { Listener } from './types';

/**
 * Where the camera stands, and how it gets told.
 *
 * A shot is a named framing plus how far the operator has moved off it, and
 * this owns both halves plus the two directions they travel: `setShot` puts the
 * camera where a command says, and a drag on an embedded page reads it back and
 * publishes it. Everything is derived from the framings, so a swap that
 * rebuilds them puts the same shot on a differently-proportioned avatar rather
 * than leaving the camera where the last one needed it.
 *
 * Where the resulting picture *sits* in the frame is deliberately not here.
 * That is a placement, it is the canvas element rather than the camera, and
 * keeping the two apart is what stops putting the character in a corner from
 * quietly changing what is in shot.
 */

export const FOV = 28;

/**
 * How often a dragged shot is published, in milliseconds.
 *
 * Every one of these is a request out of the panel and a frame back down to
 * every renderer, so a drag published per frame would put sixty round trips a
 * second on the wire to move one camera. Ten is enough for the picture going to
 * air to look like it is following the one being dragged.
 */
const SHOT_INTERVAL = 100;

export interface ShotCameraOptions {
  /** Whether the pointer may move the camera at all. */
  pointer: boolean;
  /** Whether this page is a preview inside a panel, which publishes its drags. */
  embedded: boolean;
}

export class ShotCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private framings: Framings | null = null;
  private frame: CameraFrame = 'bust';
  /** How far the camera has been moved off the framing. See `Shot`. */
  private orbit = { yaw: 0, pitch: 0, zoom: 1 };
  /** True while `place` is moving the camera, so its own change is not published. */
  private placing = false;
  private shotSentAt = 0;
  private shotTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<Listener<CameraFrame>>();

  /**
   * @param onFramed Raised when the framing changed, because how much of the
   *   picture the character fills is a property of the shot and the canvas has
   *   to be re-fitted around it.
   */
  constructor(
    domElement: HTMLElement,
    { pointer, embedded }: ShotCameraOptions,
    private readonly onFramed: () => void,
  ) {
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, domElement);
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
    this.controls.enabled = pointer;
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
  }

  /**
   * The framing is set from two places — the console's picker and the control
   * API's `camera` command — so the runtime owns it and the picker follows.
   * Held as React state instead, a shot changed by the orchestrator would move
   * the camera and leave the control showing the old framing.
   */
  onCamera(fn: Listener<CameraFrame>): () => void {
    this.listeners.add(fn);
    fn(this.frame);
    return () => this.listeners.delete(fn);
  }

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
      for (const fn of this.listeners) fn(this.frame);
    }
    if (shot.yaw !== undefined) this.orbit.yaw = shot.yaw;
    if (shot.pitch !== undefined) this.orbit.pitch = shot.pitch;
    if (shot.zoom !== undefined) this.orbit.zoom = shot.zoom;
    this.place();
    // How much of the picture the character fills is a property of the shot —
    // a full-length figure fills less of it than a face — and where the canvas
    // sits is derived from that. Without this a framing change moves the
    // character within a rectangle that stayed where the last one needed it.
    this.onFramed();
  }

  /**
   * Take the framings a newly loaded avatar produced, keeping the shot.
   *
   * `place`, not `goto`: the framings were just rebuilt for a body of another
   * size, and the shot the operator set up should survive that. The offsets
   * are relative for exactly this reason.
   */
  rebuild(framings: Framings): void {
    this.framings = framings;
    this.place();
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
   * `AvatarRuntime.resize`. A shot is what the camera can see; a placement is
   * where that picture is put afterwards, and the two are kept apart so that
   * putting the character in a corner cannot quietly change what is in shot.
   */
  place(): void {
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
   * How much of a picture of this width the character actually fills, 0 to 1.
   *
   * The framing decides the height of the world in shot and the aspect decides
   * the width, so what is left over at the sides is arithmetic rather than
   * something anybody chose. 1 before an avatar has loaded — nothing is in the
   * picture yet, so there is no gap to close and nothing to move.
   */
  contentWidth(picture: Rect): number {
    const f = this.framings?.[this.frame];
    if (!f || picture.height === 0) return 1;
    const world = (f.height / this.orbit.zoom) * (picture.width / picture.height);
    return world === 0 ? 1 : (2 * f.halfWidth) / world;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(): void {
    this.controls.update();
  }

  dispose(): void {
    if (this.shotTimer !== null) {
      clearTimeout(this.shotTimer);
      this.shotTimer = null;
    }
    this.controls.dispose();
    this.listeners.clear();
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
}
