import { describe, expect, it } from 'vitest';
import {
  CROUCH_T,
  type JumpArc,
  MAX_CROUCH,
  planJump,
  RECOVER_T,
  sampleJump,
} from '@/engine/motion/jump';

const G = 9.81;

/** Where each phase ends, measured from the start of the hop. */
const boundaries = (arc: JumpArc): Array<{ name: string; t: number }> => {
  const push = CROUCH_T + arc.push;
  const flight = push + arc.flight;
  const brake = flight + arc.brake;
  return [
    { name: 'crouch to push', t: CROUCH_T },
    { name: 'push to flight', t: push },
    { name: 'flight to absorb', t: flight },
    { name: 'absorb to recover', t: brake },
    { name: 'recover to done', t: brake + RECOVER_T },
  ];
};

const total = (arc: JumpArc): number => CROUCH_T + arc.push + arc.flight + arc.brake + RECOVER_T;

const riseAt = (arc: JumpArc, t: number): number => sampleJump(arc, t).rise;

/**
 * One-sided numeric derivative of the hips, taken entirely within one phase.
 *
 * Both samples sit on the same side of the boundary, so the estimate belongs to
 * the phase being measured and never mixes the two formulas. Truncation error is
 * about `1.5 · h · |accel|`, and the stiffest acceleration in the hop is the push
 * off the floor at a few hundred m/s², so at this step it stays near 1e-4 m/s.
 * The step cannot shrink indefinitely: below roughly 1e-9 the difference of two
 * rises falls into the last bits of a double and the estimate turns to noise.
 */
const velocityNear = (arc: JumpArc, t: number, side: -1 | 1): number => {
  const h = 1e-7;
  const near = t + side * h;
  const far = t + side * 2 * h;
  return (side * (riseAt(arc, far) - riseAt(arc, near))) / h;
};

describe('planJump', () => {
  it.each([
    { height: 0.2, gravity: G },
    { height: 0.05, gravity: G },
    { height: 0.6, gravity: 6 },
    { height: 0.3, gravity: 1.62 },
  ])('derives v0 and hang time from height $height and gravity $gravity alone', (c) => {
    const arc = planJump(c.height, c.gravity);
    expect(arc.g).toBe(c.gravity);
    expect(arc.v0).toBeCloseTo(Math.sqrt(2 * c.gravity * c.height), 12);
    expect(arc.flight).toBeCloseTo((2 * arc.v0) / arc.g, 12);
  });

  it('caps the dip at MAX_CROUCH however high the hop', () => {
    expect(planJump(1, G).dip).toBe(MAX_CROUCH);
    expect(planJump(10, G).dip).toBe(MAX_CROUCH);
    for (const h of [0.02, 0.05, 0.1, 0.4, 2]) {
      expect(planJump(h, G).dip).toBeLessThanOrEqual(MAX_CROUCH);
    }
  });

  it('scales the dip with the hop while it is under the cap', () => {
    // 55% of the height, until the rig with no legs runs out of floor.
    expect(planJump(0.04, G).dip).toBeCloseTo(0.022, 12);
    expect(planJump(0.08, G).dip).toBeCloseTo(0.044, 12);
  });

  it('derives the push duration from the depth and the take-off speed', () => {
    const arc = planJump(0.2, G);
    expect(arc.push).toBeCloseTo((2 * arc.dip) / arc.v0, 12);
    expect(arc.brake).toBeCloseTo((arc.dip * Math.PI) / (2 * arc.v0), 12);
  });

  it('floors gravity and height rather than producing a degenerate arc', () => {
    const noGravity = planJump(0.2, 0);
    expect(noGravity.g).toBe(0.5);
    expect(Number.isFinite(noGravity.flight)).toBe(true);
    const noHeight = planJump(0, G);
    expect(noHeight.v0).toBeCloseTo(Math.sqrt(2 * G * 0.005), 12);
    expect(noHeight.v0).toBeGreaterThan(0);
    expect(planJump(-3, G).v0).toBe(noHeight.v0);
  });

  it('keeps the height and lengthens the hang time as gravity drops', () => {
    const earth = planJump(0.25, G);
    const moon = planJump(0.25, 1.62);
    const apex = (arc: JumpArc) => riseAt(arc, CROUCH_T + arc.push + arc.flight / 2);
    expect(apex(earth)).toBeCloseTo(0.25, 9);
    expect(apex(moon)).toBeCloseTo(0.25, 9);
    expect(moon.flight).toBeGreaterThan(earth.flight * 2);
    expect(moon.v0).toBeLessThan(earth.v0);
  });
});

describe('sampleJump phase joins', () => {
  const cases = [
    { label: 'a normal hop', arc: planJump(0.2, G) },
    { label: 'a hop past the dip cap', arc: planJump(1.2, G) },
    { label: 'a tiny hop under the cap', arc: planJump(0.03, G) },
    { label: 'low gravity', arc: planJump(0.3, 1.62) },
  ];

  it.each(cases)('holds position continuous across every boundary of $label', ({ arc }) => {
    const h = 1e-8;
    for (const b of boundaries(arc)) {
      const before = riseAt(arc, b.t - h);
      const after = riseAt(arc, b.t + h);
      // A step here would be the hips teleporting between two frames. The two
      // samples are 2h apart in time, so a continuous arc can differ only by
      // `2 · h · speed`, which is under 1e-7 m at the fastest join.
      expect(Math.abs(after - before)).toBeLessThan(1e-6);
    }
  });

  it.each(cases)('holds velocity continuous across every boundary of $label', ({ arc }) => {
    // This is the property the whole arc is built around: a step in the hips'
    // velocity is an impulse the spring chains report as a snap the animation
    // invented rather than one the jump earned.
    for (const b of boundaries(arc)) {
      const before = velocityNear(arc, b.t, -1);
      const after = velocityNear(arc, b.t, 1);
      expect(Math.abs(after - before)).toBeLessThan(1e-3);
    }
  });

  it('joins the phases at the speeds the arc table states', () => {
    const arc = planJump(0.2, G);
    const [crouch, push, flight, brake] = boundaries(arc);
    expect(velocityNear(arc, crouch.t, -1)).toBeCloseTo(0, 4);
    expect(velocityNear(arc, push.t, -1)).toBeCloseTo(arc.v0, 4);
    expect(velocityNear(arc, flight.t, -1)).toBeCloseTo(-arc.v0, 4);
    expect(velocityNear(arc, brake.t, 1)).toBeCloseTo(0, 4);
    // Take-off and touchdown are the same speed, which is what makes the hop
    // symmetric about its apex.
    expect(velocityNear(arc, push.t, 1)).toBeCloseTo(-velocityNear(arc, flight.t, -1), 4);
  });

  it('would notice a phase duration picked by eye rather than derived', () => {
    // A negative control for the two continuity tests above: stretching the
    // landing without restretching the sine that fills it leaves the absorb
    // phase entering at the wrong speed, and the check has to see it.
    const good = planJump(0.2, G);
    const bad: JumpArc = { ...good, brake: good.brake * 1.5 };
    const touchdown = CROUCH_T + good.push + good.flight;
    const step = Math.abs(velocityNear(bad, touchdown, 1) - velocityNear(bad, touchdown, -1));
    expect(step).toBeGreaterThan(0.3 * good.v0);
  });

  it('reaches the dip depth at each end of the flight and stands at both ends of the hop', () => {
    const arc = planJump(0.2, G);
    expect(Math.abs(riseAt(arc, 0))).toBe(0);
    expect(riseAt(arc, CROUCH_T)).toBeCloseTo(-arc.dip, 9);
    expect(riseAt(arc, CROUCH_T + arc.push)).toBeCloseTo(0, 9);
    expect(riseAt(arc, CROUCH_T + arc.push + arc.flight + arc.brake)).toBeCloseTo(-arc.dip, 9);
    expect(riseAt(arc, total(arc))).toBe(0);
  });
});

describe('sampleJump arc', () => {
  const arc = planJump(0.2, G);

  it('reaches the requested height at the apex and nowhere higher', () => {
    let peak = Number.NEGATIVE_INFINITY;
    for (let t = 0; t <= total(arc); t += 0.0005) peak = Math.max(peak, riseAt(arc, t));
    expect(peak).toBeCloseTo(0.2, 4);
    expect(peak).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it.each([0.05, 0.2, 0.9])('reaches height %f for any hop', (height) => {
    const a = planJump(height, G);
    expect(riseAt(a, CROUCH_T + a.push + a.flight / 2)).toBeCloseTo(height, 9);
  });

  it('is done past the end, and standing again rather than mid-arc', () => {
    const end = total(arc);
    for (const t of [end, end + 1e-6, end + 0.5, end + 100]) {
      const s = sampleJump(arc, t);
      expect(s.done).toBe(true);
      expect(s.rise).toBe(0);
      expect(s.load).toBe(0);
    }
    expect(sampleJump(arc, end - 1e-4).done).toBe(false);
  });

  it('loads only while the body is below rest', () => {
    for (let t = 0; t < total(arc); t += 0.001) {
      const s = sampleJump(arc, t);
      if (s.rise >= 0) expect(s.load).toBe(0);
      else expect(s.load).toBeGreaterThan(0);
      expect(s.load).toBeGreaterThanOrEqual(0);
      expect(s.load).toBeLessThanOrEqual(1);
    }
  });

  it('reads full load at the bottom of the crouch and none in the air', () => {
    expect(sampleJump(arc, CROUCH_T - 1e-9).load).toBeCloseTo(1, 6);
    expect(sampleJump(arc, CROUCH_T + arc.push + arc.flight / 2).load).toBe(0);
  });

  it('is airborne for exactly the flight window', () => {
    const takeOff = CROUCH_T + arc.push;
    expect(riseAt(arc, takeOff + 1e-4)).toBeGreaterThan(0);
    expect(riseAt(arc, takeOff + arc.flight - 1e-4)).toBeGreaterThan(0);
    expect(riseAt(arc, takeOff + arc.flight + 1e-4)).toBeLessThan(0);
  });

  it('never drops the hips further than the plan allows', () => {
    for (let t = 0; t < total(arc); t += 0.001) {
      expect(riseAt(arc, t)).toBeGreaterThanOrEqual(-arc.dip - 1e-12);
    }
  });
});
