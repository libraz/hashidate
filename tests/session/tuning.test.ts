import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Session } from '@/engine/session';
import { TUNING_RANGES } from '@/engine/tuning';
import type { Shading } from '@/engine/types';
import { buildRig } from '../helpers/scene';

/**
 * The set-once layer, reached as a value rather than by writing onto the engine.
 *
 * The whole point of naming it is that a surface which is not on the same page
 * as the renderer can move it, so what matters here is the two properties that
 * makes possible: a patch touches only what it names, and what comes back is the
 * value that is actually in force rather than the last one somebody sent.
 */

function build({ arkit = false }: { arkit?: boolean } = {}) {
  const rig = buildRig({ arkit });
  const profile = buildProfile(rig.root, rig.descriptor);
  const director = new Director(profile);
  let toon = true;
  const shading: Shading = {
    get toon() {
      return toon;
    },
    setToon: (on) => {
      toon = on;
    },
  };
  const session = new Session(director, { shading });
  return { session, director, profile, shading };
}

describe('Session.tuning', () => {
  it('reports the engine objects rather than a copy kept beside them', () => {
    const { session, director } = build();
    director.body.breathDepth = 1.7;
    director.spring.stiffnessScale = 2.2;
    director.tail.amount = 3;
    expect(session.tuning()).toMatchObject({
      idle: { breathDepth: 1.7 },
      sway: { stiffness: 2.2 },
      tail: { amount: 3 },
    });
  });

  it('says which groups this avatar actually has', () => {
    // A synthetic rig has no spring bones and no tail, so both are absent — and
    // the difference between "off" and "not there" is what a panel draws from.
    const { session } = build();
    expect(session.tuning().has).toEqual({ sway: false, tail: false, arkit: false });
  });

  it('reports arkit support separately from whether it is being used', () => {
    const { session, director } = build({ arkit: true });
    expect(session.tuning().has.arkit).toBe(true);
    director.useArkit = false;
    expect(session.tuning().render.arkit).toBe(false);
    expect(session.tuning().has.arkit).toBe(true);
  });

  it('reports the shading the renderer is drawing with', () => {
    const { session, shading } = build();
    expect(session.tuning().render.toon).toBe(true);
    shading.setToon(false);
    expect(session.tuning().render.toon).toBe(false);
  });

  it('reports toon as on where the renderer has no shading to ask', () => {
    // Every test, and any headless embedding. A readout that said "off" would
    // describe a switch that does not exist.
    const rig = buildRig({ arkit: false });
    const profile = buildProfile(rig.root, rig.descriptor);
    const session = new Session(new Director(profile));
    expect(session.tuning().render.toon).toBe(true);
  });
});

describe('Session.tune', () => {
  it('moves only the fields it names', () => {
    const { session, director } = build();
    const before = session.tuning();
    session.tune({ idle: { breathDepth: 0.4 } });
    const after = session.tuning();
    expect(after.idle.breathDepth).toBe(0.4);
    expect(after.idle.breathPeriod).toBe(before.idle.breathPeriod);
    expect(after.idle.weightShift).toBe(before.idle.weightShift);
    expect(director.body.breathPeriod).toBe(before.idle.breathPeriod);
  });

  it('leaves every other group alone', () => {
    const { session } = build();
    const before = session.tuning();
    session.tune({ hop: { height: 0.2 } });
    const after = session.tuning();
    expect(after.hop.height).toBe(0.2);
    expect(after.sway).toEqual(before.sway);
    expect(after.tail).toEqual(before.tail);
    expect(after.render).toEqual(before.render);
  });

  it('accepts an empty patch, which asks for nothing', () => {
    const { session } = build();
    const before = session.tuning();
    session.tune({});
    expect(session.tuning()).toEqual(before);
  });

  it('scales the gaze limits off the measured ones, so two drags do not square', () => {
    const { session, profile } = build();
    const measured = profile.gaze.eyeYaw;
    session.tune({ idle: { eyeLimit: 0.5 } });
    expect(profile.gaze.eyeYaw).toBeCloseTo(measured * 0.5, 6);
    session.tune({ idle: { eyeLimit: 0.5 } });
    expect(profile.gaze.eyeYaw).toBeCloseTo(measured * 0.5, 6);
    session.tune({ idle: { eyeLimit: 1 } });
    expect(profile.gaze.eyeYaw).toBeCloseTo(measured, 6);
  });

  it('reports the eye limit back as the multiplier it was given', () => {
    const { session } = build();
    expect(session.tuning().idle.eyeLimit).toBe(1);
    session.tune({ idle: { eyeLimit: 1.4 } });
    expect(session.tuning().idle.eyeLimit).toBe(1.4);
  });

  it('drives the renderer shading through the port rather than the director', () => {
    const { session, shading } = build();
    session.tune({ render: { toon: false } });
    expect(shading.toon).toBe(false);
  });

  it('refuses to switch to arkit composition on an avatar that has no arkit shapes', () => {
    // The director reads the flag together with `arkit.supported`, so setting it
    // would advertise a mode the face cannot be driven in.
    const { session, director } = build();
    expect(director.useArkit).toBe(false);
    session.tune({ render: { arkit: true } });
    expect(director.useArkit).toBe(false);
    expect(session.tuning().render.arkit).toBe(false);
  });

  it('switches composition on an avatar that does have them', () => {
    const { session, director } = build({ arkit: true });
    expect(director.useArkit).toBe(true);
    session.tune({ render: { arkit: false } });
    expect(director.useArkit).toBe(false);
    session.tune({ render: { arkit: true } });
    expect(director.useArkit).toBe(true);
  });

  it('does nothing at all on a group this avatar does not have', () => {
    const { session } = build();
    session.tune({ sway: { stiffness: 2 }, tail: { amount: 1 } });
    // The scales land — they are plain numbers on layers that exist but hold
    // nothing — and the report still says there is nothing to apply them to.
    expect(session.tuning().has).toMatchObject({ sway: false, tail: false });
  });

  it('round-trips every group through a full patch', () => {
    const { session } = build({ arkit: true });
    const patch = {
      idle: {
        breathDepth: 1.1,
        breathPeriod: 5,
        idleAmount: 0.3,
        weightShift: 1.4,
        gazeAmount: 0.2,
        eyeLimit: 1.5,
        blink: false,
      },
      sway: { enabled: false, stiffness: 2.5, inertia: 1.2, gravity: 3 },
      hop: { height: 0.25, gravity: 12 },
      tail: { amount: 3.5 },
      render: { toon: false, arkit: false },
    };
    session.tune(patch);
    const { has: _has, ...running } = session.tuning();
    expect(running).toEqual(patch);
  });

  it('takes every value at both ends of the range the wire accepts', () => {
    // The bounds a fader sweeps and the bounds the schema allows are one table,
    // so a value at either end has to be one the engine will take.
    const { session } = build();
    for (const [group, fields] of Object.entries(TUNING_RANGES)) {
      for (const [field, range] of Object.entries(fields)) {
        for (const value of [range.min, range.max]) {
          session.tune({ [group]: { [field]: value } });
          const running = session.tuning() as unknown as Record<string, Record<string, number>>;
          expect(running[group][field]).toBe(value);
        }
      }
    }
  });
});
