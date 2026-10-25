import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraFrame, Shot } from '@/engine/types';
import { SHOT_LIMITS } from '@/engine/types';
import type { Framings } from '../framing';
import type { Rect } from '../placement';
import type { Listener } from './types';

/**
 * Where the camera stands, and how it gets told.
 *
 * A shot is a named framing plus how far the operator has moved off it, and
 * this owns both halves: `setShot` puts the camera where a command says. A drag
 * in the panel's preview is turned into that command by the panel itself (see
 * `src/panel/preview/shot-drag.ts`), so nothing here reads a shot back. Everything is derived from the framings, so a swap that
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
 * Move the picture across the lens, by a fraction of its width; positive moves
 * what is in shot to the right.
 *
 * A film offset rather than a turned or moved camera: the projection slides
 * sideways and nothing else does, so the framing's height, its perspective and
 * every gesture authored against it stay exactly as they were.
 */
export function lensShift(camera: THREE.PerspectiveCamera, shift: number): void {
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom;
  camera.filmOffset = -shift * 2 * halfHeight * camera.aspect * camera.getFilmWidth();
  camera.updateProjectionMatrix();
}

export interface ShotCameraOptions {
  /** Whether the pointer may move the camera at all. */
  pointer: boolean;
}

export class ShotCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private framings: Framings | null = null;
  private frame: CameraFrame = 'bust';
  /** How far the camera has been moved off the framing. See `Shot`. */
  private orbit = { yaw: 0, pitch: 0, zoom: 1 };
  /** Set when `place` moved the camera, until the frame loop takes it. See `takeCut`. */
  private cut = false;
  private readonly listeners = new Set<Listener<CameraFrame>>();

  /**
   * @param onFramed Raised when the framing changed, because how much of the
   *   picture the character fills is a property of the shot and the canvas has
   *   to be re-fitted around it.
   */
  constructor(
    domElement: HTMLElement,
    { pointer }: ShotCameraOptions,
    private readonly onFramed: () => void,
  ) {
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    /**
     * The pointer moves the camera on the console, which is the development
     * view, and nowhere else.
     *
     * A bare page is what OBS opens and the stage window shows, and a shot
     * nudged there by a stray drag is a shot the panel no longer agrees with —
     * silently, because nothing tells the panel it happened. The panel's
     * preview sets the shot by sending the `camera` command instead.
     */
    this.controls.enabled = pointer;
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
    this.controls.update();
    this.cut = true;
  }

  /**
   * Whether the camera was placed since the last call: a cut, as opposed to the
   * pointer and its damping moving it over frames. Every placement is one,
   * because `place` puts the camera down in a single step — so is each shot
   * of a drag relayed from the panel, which this page draws as a step too.
   */
  takeCut(): boolean {
    const cut = this.cut;
    this.cut = false;
    return cut;
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

  /** Fit the lens to the picture: its shape, and how far across it the figure stands. */
  setLens(aspect: number, shift: number): void {
    this.camera.aspect = aspect;
    lensShift(this.camera, shift);
  }

  update(): void {
    this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
    this.listeners.clear();
  }
}
