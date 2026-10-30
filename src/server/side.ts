import { parseLine } from '../engine/cues';
import { performanceDef } from '../engine/performance';
import type { TurnRequest } from '../engine/types';
import type { Command, Side } from '../protocol';

/** A source of numbers in [0, 1), `Math.random`'s shape, so a test can pin the draw. */
export type Random = () => number;

/**
 * Draw the side once for every renderer that will play this movement.
 *
 * Renderers each run the same queue, and an absent side makes each draw its own,
 * so the stage could wave left while a capture waves right. Choosing here sends
 * all of them the same explicit side. An explicit side is never touched, and
 * nothing is drawn for a command whose movement takes none.
 */
export function withSide<T extends Command | TurnRequest>(item: T, random: Random): T {
  const named: Movement | null = 'cmd' in item ? commandMovement(item) : (item as TurnRequest);
  if (named === null || named.side !== undefined || !movementUsesSide(named)) return item;
  const side: Side = random() < 0.5 ? 'L' : 'R';
  return { ...item, side };
}

type Movement = { gesture?: string | null; perform?: string | null; text?: string; side?: Side };

/** The movement a command names, in a turn's terms; null for a command with none. */
function commandMovement(command: Command): Movement | null {
  switch (command.cmd) {
    case 'gesture':
      return { gesture: command.id, side: command.side };
    case 'perform':
      return { perform: command.id, side: command.side };
    case 'idleAct':
      return { perform: command.act, side: command.side };
    case 'say':
      return command;
    default:
      return null;
  }
}

/**
 * Whether anything the movement names consults a side.
 *
 * Every gesture does: a one-handed one picks its hand and a two-handed one picks
 * which way the head turns. A performance does if it names a gesture or holds an
 * attitude, whose yaw and roll are mirrored by it; one the table does not know
 * is assumed to, since a loaded one ignores the field. A line's gesture and
 * perform cues play under the line's side, so they count as the line's own.
 */
function movementUsesSide({ gesture, perform, text }: Movement): boolean {
  const performs = (id: string): boolean => {
    const def = performanceDef(id);
    return def === null || def.gesture !== undefined || def.attitude !== undefined;
  };
  if (gesture || (perform && performs(perform))) return true;
  if (!text) return false;
  return parseLine(text).cues.some(({ action, perform: legacy }) => {
    if (action?.kind === 'gesture') return true;
    const id = action?.kind === 'perform' ? action.id : legacy;
    return id !== undefined && performs(id);
  });
}
