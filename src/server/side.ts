import { performanceDef } from '../engine/performance';
import type { TurnRequest } from '../engine/types';
import type { Command, Side } from '../protocol';

/** A source of numbers in [0, 1), `Math.random`'s shape, so a test can pin the draw. */
export type Random = () => number;

/**
 * Whether the movement a gesture or performance id names consults a side.
 *
 * Every gesture does: a one-handed one picks its hand and a two-handed one picks
 * which way the head turns. A performance does only if it names a gesture; one
 * the table does not know is assumed to, since a loaded one ignores the field.
 */
const performUsesSide = (id: string): boolean => {
  const def = performanceDef(id);
  return def === null || def.gesture !== undefined;
};

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

type Movement = { gesture?: string | null; perform?: string | null; side?: Side };

/** The movement a command names, in a turn's terms; null for a command with none. */
function commandMovement(command: Command): Movement | null {
  switch (command.cmd) {
    case 'gesture':
      return { gesture: command.id, side: command.side };
    case 'perform':
      return { perform: command.id, side: command.side };
    case 'say':
      return command;
    default:
      return null;
  }
}

function movementUsesSide({ gesture, perform }: Movement): boolean {
  return Boolean(gesture) || (Boolean(perform) && performUsesSide(perform as string));
}
