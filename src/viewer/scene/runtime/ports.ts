import type { LabelledId, Scenery, Shading } from '@/engine/types';
import type { AvatarRuntime } from './index';

/**
 * The narrow doors a session may reach the renderer through.
 *
 * Free functions rather than object literals inside the class, because each has
 * a getter and a getter cannot be an arrow — and because writing them out here
 * makes the width of each door obvious at a glance.
 */

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
export function sceneryPort(runtime: AvatarRuntime): Scenery {
  return {
    get backdrops(): LabelledId[] {
      return runtime.backdrops;
    },
    setBackdrop: (id) => runtime.setBackdrop(id),
  };
}

/** The renderer's shading, as the one switch a session may reach. */
export function shadingPort(runtime: AvatarRuntime): Shading {
  return {
    get toon(): boolean {
      return runtime.toonEnabled;
    },
    setToon: (on) => runtime.setToon(on),
  };
}
