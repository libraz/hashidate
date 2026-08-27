import { describe, expect, it } from 'vitest';
import { D, ELEVATION, JOINTS } from '@/engine/anatomy/joints';
import {
  clampDof,
  type ElevationCeiling,
  elevationCeiling,
  elevationStrain,
  excessOf,
  fingerCurl,
  rollRoom,
  strainOf,
  zoneOf,
} from '@/engine/anatomy/strain';
import type { JointDof, JointSpec } from '@/engine/types';
import { same } from '@/i18n/locale';

/**
 * The strain functions, in degrees.
 *
 * Everything the module takes and returns is radians, so the tests build their
 * fixtures the same way the joint table does — authored in degrees, converted
 * once — and compare in radians. `deg` is only for reading a result back out.
 */
const dof = (freeLo: number, freeHi: number, maxLo: number, maxHi: number): JointDof => ({
  label: same('test'),
  free: [freeLo * D, freeHi * D],
  max: [maxLo * D, maxHi * D],
});

const deg = (radians: number): number => radians / D;

/** free -20..40, strained down to -50 and up to 60. Asymmetric on purpose. */
const BAND = dof(-20, 40, -50, 60);

describe('strainOf', () => {
  it('is zero everywhere inside the free band, including both of its edges', () => {
    expect(strainOf(0, BAND)).toBe(0);
    expect(strainOf(-20 * D, BAND)).toBe(0);
    expect(strainOf(40 * D, BAND)).toBe(0);
    expect(strainOf(39.999 * D, BAND)).toBe(0);
  });

  it('rises linearly from the free edge to exactly 1 at the hard stop', () => {
    // Upper strained band is 40..60, so half of it is 50.
    expect(strainOf(50 * D, BAND)).toBeCloseTo(0.5, 12);
    expect(strainOf(45 * D, BAND)).toBeCloseTo(0.25, 12);
    expect(strainOf(60 * D, BAND)).toBeCloseTo(1, 12);
  });

  it('has a corner rather than an ease at the edge of the free band', () => {
    // The comment states the ramp is linear precisely so the first degrees past
    // comfortable are not free. A smooth ramp would leave the slope near zero
    // here; linear makes it the full band slope from the first step out.
    const step = 0.001 * D;
    const slope = (strainOf(40 * D + step, BAND) - strainOf(40 * D, BAND)) / step;
    const bandSlope = 1 / (20 * D);
    expect(slope).toBeCloseTo(bandSlope, 6);
  });

  it('saturates at 1 past the hard stop, however far past', () => {
    expect(strainOf(61 * D, BAND)).toBe(1);
    expect(strainOf(150 * D, BAND)).toBe(1);
    expect(strainOf(-51 * D, BAND)).toBe(1);
    expect(strainOf(-500 * D, BAND)).toBe(1);
  });

  it('ramps on the low side against the low bands, not the high ones', () => {
    // Lower strained band is -20..-50, three times the width used above.
    expect(strainOf(-35 * D, BAND)).toBeCloseTo(0.5, 12);
    expect(strainOf(-50 * D, BAND)).toBeCloseTo(1, 12);
  });

  it('reports 1 for any excursion when the strained band is degenerate', () => {
    const pinned = dof(10, 20, 10, 20);
    expect(strainOf(20 * D, pinned)).toBe(0);
    expect(strainOf(20.0001 * D, pinned)).toBe(1);
    expect(strainOf(10 * D, pinned)).toBe(0);
    expect(strainOf(9.9999 * D, pinned)).toBe(1);
  });

  it('reads a real asymmetric joint on both sides of its free band', () => {
    // Wrist deviation: free -20..10, stop -30..20. The thumb side has a third
    // of the free travel the little-finger side has.
    const d = JOINTS.wrist.dofs.deviation;
    expect(strainOf(15 * D, d)).toBeCloseTo(0.5, 12);
    expect(strainOf(-25 * D, d)).toBeCloseTo(0.5, 12);
  });
});

describe('excessOf', () => {
  it('is zero anywhere inside the hard stop, including the strained band', () => {
    expect(excessOf(0, BAND)).toBe(0);
    expect(excessOf(50 * D, BAND)).toBe(0);
    expect(excessOf(60 * D, BAND)).toBe(0);
    expect(excessOf(-50 * D, BAND)).toBe(0);
  });

  it('keeps growing past the stop where strainOf saturates', () => {
    // This is the difference the elbow search runs on: a degree over and ninety
    // degrees over must not score the same. If excessOf ever gained a cap, both
    // of these would collapse onto one value and nothing else would notice.
    const oneOver = excessOf(61 * D, BAND);
    const ninetyOver = excessOf(150 * D, BAND);
    expect(oneOver).toBeGreaterThan(0);
    expect(ninetyOver).toBeGreaterThan(oneOver * 50);
    expect(strainOf(61 * D, BAND)).toBe(strainOf(150 * D, BAND));
  });

  it('measures the overshoot in units of the whole hard-stop band', () => {
    // Band is -50..60, so 110 degrees; one band over the top is 170.
    expect(excessOf(170 * D, BAND)).toBeCloseTo(1, 12);
    expect(excessOf(115 * D, BAND)).toBeCloseTo(0.5, 12);
    expect(excessOf(-160 * D, BAND)).toBeCloseTo(1, 12);
  });

  it('is monotone in the overshoot on both sides', () => {
    for (let over = 1; over < 90; over += 7) {
      expect(excessOf((60 + over + 1) * D, BAND)).toBeGreaterThan(excessOf((60 + over) * D, BAND));
      expect(excessOf((-50 - over - 1) * D, BAND)).toBeGreaterThan(
        excessOf((-50 - over) * D, BAND),
      );
    }
  });

  it('stays finite when the joint has no travel at all', () => {
    const pinned = dof(0, 0, 0, 0);
    expect(Number.isFinite(excessOf(1 * D, pinned))).toBe(true);
    expect(excessOf(1 * D, pinned)).toBeGreaterThan(0);
  });
});

describe('clampDof', () => {
  it('pulls to the hard stop and leaves the strained band reachable', () => {
    // The elbow's free flexion ends at 130 and its stop at 150. Clamping to the
    // free band instead would make every effortful pose unreachable.
    const d = JOINTS.elbow.dofs.flexion;
    expect(deg(clampDof(160 * D, d))).toBeCloseTo(150, 9);
    expect(deg(clampDof(140 * D, d))).toBeCloseTo(140, 9);
    expect(deg(clampDof(-10 * D, d))).toBeCloseTo(0, 9);
  });

  it('is the identity inside the hard stop', () => {
    expect(clampDof(0, BAND)).toBe(0);
    expect(clampDof(55 * D, BAND)).toBe(55 * D);
  });
});

describe('zoneOf', () => {
  it.each([
    { strain: -1, zone: 'natural' },
    { strain: 0, zone: 'natural' },
    { strain: Number.MIN_VALUE, zone: 'strained' },
    { strain: 0.5, zone: 'strained' },
    { strain: 0.999999, zone: 'strained' },
    { strain: 1, zone: 'limit' },
    { strain: 4, zone: 'limit' },
  ])('places strain $strain in $zone', ({ strain, zone }) => {
    expect(zoneOf(strain)).toBe(zone);
  });
});

describe('rollRoom', () => {
  const forearm = JOINTS.elbow.dofs.rotation; // free -55..55, stop -80..80

  it('reports the room either side of what the pose already spends', () => {
    const [lo, hi] = rollRoom(0, forearm);
    expect(deg(lo)).toBeCloseTo(-80, 9);
    expect(deg(hi)).toBeCloseTo(80, 9);
  });

  it('still has room to lend past the free band, which is the point', () => {
    // 60 degrees is already past the free 55. Measured against the free band
    // this would be zero and the shoulder would decline to help exactly where
    // the alternative is a forearm past its own stop.
    const [lo, hi] = rollRoom(60 * D, forearm);
    expect(deg(hi)).toBeCloseTo(20, 9);
    expect(deg(lo)).toBeCloseTo(-140, 9);
    expect(hi).toBeGreaterThan(0);
  });

  it('is signed both ways and never reports the wrong sign', () => {
    for (let used = -120; used <= 120; used += 5) {
      const [lo, hi] = rollRoom(used * D, forearm);
      expect(lo).toBeLessThanOrEqual(0);
      expect(hi).toBeGreaterThanOrEqual(0);
    }
  });

  it('offers nothing in the direction already past the stop', () => {
    expect(rollRoom(90 * D, forearm)[1]).toBe(0);
    expect(rollRoom(-90 * D, forearm)[0]).toBe(0);
  });
});

describe('elevationCeiling', () => {
  it.each(ELEVATION.map((row) => ({ plane: row[0], free: row[1], max: row[2] })))(
    'returns the table row exactly at plane $plane',
    ({ plane, free, max }) => {
      const c = elevationCeiling(plane * D);
      expect(deg(c.free)).toBeCloseTo(free, 9);
      expect(deg(c.max)).toBeCloseTo(max, 9);
    },
  );

  it('interpolates linearly between two rows', () => {
    // Halfway from [0, 100, 175] to [45, 105, 178].
    const c = elevationCeiling(22.5 * D);
    expect(deg(c.free)).toBeCloseTo(102.5, 9);
    expect(deg(c.max)).toBeCloseTo(176.5, 9);
  });

  it('closes the circle at the wrap-around', () => {
    const plus = elevationCeiling(180 * D);
    const minus = elevationCeiling(-180 * D);
    expect(plus.free).toBeCloseTo(minus.free, 12);
    expect(plus.max).toBeCloseTo(minus.max, 12);
    expect(deg(plus.max)).toBeCloseTo(45, 9);
  });

  it.each([
    { plane: 190, same: -170 },
    { plane: -190, same: 170 },
    { plane: 405, same: 45 },
    { plane: -405, same: -45 },
  ])('normalises plane $plane onto $same', ({ plane, same }) => {
    const a = elevationCeiling(plane * D);
    const b = elevationCeiling(same * D);
    expect(a.free).toBeCloseTo(b.free, 12);
    expect(a.max).toBeCloseTo(b.max, 12);
  });

  it('is widest forward-and-out, which is the shape the table describes', () => {
    const widest = elevationCeiling(45 * D);
    for (const row of ELEVATION) {
      if (row[0] === 45) continue;
      expect(deg(widest.max)).toBeGreaterThan(row[2]);
    }
  });

  it('is narrow across the midline and narrow behind', () => {
    const across = elevationCeiling(180 * D);
    const behind = elevationCeiling(-90 * D);
    const side = elevationCeiling(0);
    const forward = elevationCeiling(90 * D);
    expect(across.max).toBeLessThan(behind.max);
    expect(behind.max).toBeLessThan(side.max);
    expect(behind.max).toBeLessThan(forward.max);
    // Reaching across the chest gets a quarter of the lift the side does.
    expect(deg(across.max)).toBeCloseTo(45, 9);
    expect(deg(behind.max)).toBeCloseTo(60, 9);
  });

  it('always leaves a strained band above the free one', () => {
    for (let plane = -180; plane <= 180; plane += 3) {
      const c = elevationCeiling(plane * D);
      expect(c.max).toBeGreaterThan(c.free);
      expect(c.free).toBeGreaterThan(0);
    }
  });
});

describe('elevationStrain', () => {
  const ceiling: ElevationCeiling = { free: 100 * D, max: 175 * D };

  it.each([
    { theta: 0, strain: 0 },
    { theta: 90, strain: 0 },
    { theta: 100, strain: 0 },
    { theta: 137.5, strain: 0.5 },
    { theta: 175, strain: 1 },
    { theta: 220, strain: 1 },
  ])('scores elevation $theta as $strain against a 100/175 ceiling', ({ theta, strain }) => {
    expect(elevationStrain(theta * D, ceiling)).toBeCloseTo(strain, 12);
  });

  it('reports any excursion as the limit when the ceiling has no strained band', () => {
    const flat: ElevationCeiling = { free: 40 * D, max: 40 * D };
    expect(elevationStrain(40 * D, flat)).toBe(0);
    expect(elevationStrain(40.001 * D, flat)).toBe(1);
  });

  it('matches the free-band corner that strainOf uses', () => {
    // Zero right up to the free edge, then straight onto the ramp.
    expect(elevationStrain(ceiling.free, ceiling)).toBe(0);
    const step = 0.001 * D;
    expect(elevationStrain(ceiling.free + step, ceiling)).toBeCloseTo(
      step / (ceiling.max - ceiling.free),
      12,
    );
  });
});

describe('fingerCurl', () => {
  const finger = JOINTS.finger;
  const thumb = JOINTS.thumb;

  it.each([
    { segment: 'proximal', index: 0, free: 90 },
    { segment: 'intermediate', index: 1, free: 100 },
    { segment: 'distal', index: 2, free: 70 },
  ])('puts curl 1 at the top of $segment free band ($free deg)', ({ index, free }) => {
    expect(deg(fingerCurl(finger, index, 1))).toBeCloseTo(free, 9);
  });

  it('does not take curl 1 to the hard stop', () => {
    // A fist closes to a real fist, not to the end of the strained band. The
    // three stops are 100, 115 and 90, none of which curl 1 may reach.
    expect(deg(fingerCurl(finger, 0, 1))).toBeLessThan(deg(finger.dofs.proximal.max[1]));
    expect(deg(fingerCurl(finger, 1, 1))).toBeLessThan(deg(finger.dofs.intermediate.max[1]));
    expect(deg(fingerCurl(finger, 2, 1))).toBeLessThan(deg(finger.dofs.distal.max[1]));
  });

  it('gives the three segments different ranges from one curl number', () => {
    const [p, i, d] = [0, 1, 2].map((n) => fingerCurl(finger, n, 0.5));
    expect(deg(p)).toBeCloseTo(45, 9);
    expect(deg(i)).toBeCloseTo(50, 9);
    expect(deg(d)).toBeCloseTo(35, 9);
    expect(i).toBeGreaterThan(p);
    expect(p).toBeGreaterThan(d);
  });

  it('is straight at curl 0 and linear in between', () => {
    expect(fingerCurl(finger, 0, 0)).toBe(0);
    expect(fingerCurl(finger, 1, 0.25)).toBeCloseTo(fingerCurl(finger, 1, 0.5) / 2, 12);
  });

  it('reaches into the strained band only above curl 1, and stops at the stop', () => {
    expect(deg(fingerCurl(finger, 0, 1.1))).toBeCloseTo(99, 9);
    expect(deg(fingerCurl(finger, 0, 1.2))).toBeCloseTo(100, 9);
    expect(deg(fingerCurl(finger, 0, 9))).toBeCloseTo(100, 9);
  });

  it('hyperextends below zero only where the joint allows it', () => {
    // The knuckle bends back 30 degrees; the middle joint does not bend back
    // at all, so a negative curl there is clamped to straight.
    expect(deg(fingerCurl(finger, 0, -0.2))).toBeCloseTo(-18, 9);
    expect(deg(fingerCurl(finger, 0, -1))).toBeCloseTo(-30, 9);
    expect(fingerCurl(finger, 1, -0.2)).toBe(0);
    expect(fingerCurl(finger, 1, -5)).toBe(0);
    expect(deg(fingerCurl(finger, 2, -1))).toBeCloseTo(-10, 9);
  });

  it.each([3, 4, 17])('falls back to distal for segment index %i', (index) => {
    expect(fingerCurl(finger, index, 0.6)).toBe(fingerCurl(finger, 2, 0.6));
    expect(fingerCurl(thumb, index, 0.6)).toBe(fingerCurl(thumb, 2, 0.6));
  });

  it('reads the thumb from its own table, not the finger one', () => {
    expect(deg(fingerCurl(thumb, 0, 1))).toBeCloseTo(45, 9);
    expect(deg(fingerCurl(thumb, 1, 1))).toBeCloseTo(50, 9);
    expect(deg(fingerCurl(thumb, 2, 1))).toBeCloseTo(70, 9);
    expect(fingerCurl(thumb, 0, 1)).not.toBe(fingerCurl(finger, 0, 1));
  });

  it('returns zero for a joint spec that names no segment at all', () => {
    const boneless: JointSpec = { label: same('none'), dofs: {} };
    expect(fingerCurl(boneless, 0, 1)).toBe(0);
    expect(fingerCurl(boneless, 2, 1)).toBe(0);
  });
});
