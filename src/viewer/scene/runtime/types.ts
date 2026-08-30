import type * as THREE from 'three';
import type { Director } from '@/engine/director';
import type { MaterialSet, Wardrobe } from '@/engine/scene';
import type { Session } from '@/engine/session';
import type { AvatarDescriptor, Profile } from '@/engine/types';
import type { Rect, StageSize } from '../placement';

/**
 * What the runtime hands out: the avatar it has standing, the picture it is
 * drawing, and where it is in the business of getting there.
 */

export type Listener<T> = (value: T) => void;

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
