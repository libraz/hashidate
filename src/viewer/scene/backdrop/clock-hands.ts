import * as THREE from 'three';

interface Hand {
  object: THREE.Object3D;
  /** Where the modelled hand points, clockwise from twelve in radians. */
  rest: number;
  /** How far round the dial this hand is at `now`, in turns. */
  turns: (now: Date) => number;
}

const TURNS: ReadonlyMap<string, Hand['turns']> = new Map<string, Hand['turns']>([
  // A quartz movement: the second hand steps, the other two follow its steps.
  ['wall_clock_second_hand', (now) => now.getSeconds() / 60],
  ['wall_clock_minute_hand', (now) => (now.getMinutes() + now.getSeconds() / 60) / 60],
  [
    'wall_clock_hours_hand',
    (now) => ((now.getHours() % 12) + now.getMinutes() / 60 + now.getSeconds() / 3600) / 12,
  ],
]);

/**
 * The wall clock's hands, turned to the viewer's local time.
 *
 * Each hand is its own node pivoting on the dial centre at the local origin,
 * with the face towards +z. The modelled pose is a showroom ten past ten, so the
 * rest angle is read off each hand's geometry rather than assumed.
 */
export class ClockHands {
  private constructor(private readonly hands: readonly Hand[]) {}

  /** Null unless all three hands are present. */
  static find(root: THREE.Object3D): ClockHands | null {
    const hands: Hand[] = [];
    root.traverse((object) => {
      const turns = TURNS.get(object.name);
      if (turns && object instanceof THREE.Mesh) {
        hands.push({ object, rest: tipAngle(object.geometry), turns });
      }
    });
    return hands.length === TURNS.size ? new ClockHands(hands) : null;
  }

  set(now: Date): void {
    for (const hand of this.hands) {
      // Positive z turns anticlockwise as seen from the room.
      hand.object.rotation.z = hand.rest - hand.turns(now) * Math.PI * 2;
    }
  }
}

/** The direction of the vertex farthest from the pivot: the hand's tip. */
function tipAngle(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  let best = -1;
  let angle = 0;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const reach = x * x + y * y;
    if (reach > best) {
      best = reach;
      angle = Math.atan2(x, y);
    }
  }
  return angle;
}
