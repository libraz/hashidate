import { describe, expect, it } from 'vitest';
import { D, ELEVATION, HAND_CONTACT, JOINTS, ZONES } from '@/engine/anatomy/joints';
import { zoneOf } from '@/engine/anatomy/strain';
import type { JointDof, JointSpec, StrainZone } from '@/engine/types';

const deg = (radians: number): number => radians / D;

/** Every degree of freedom in the table, flattened for row-by-row checks. */
const ALL_DOFS: Array<{ joint: string; axis: string; dof: JointDof }> = Object.entries(
  JOINTS as unknown as Record<string, JointSpec>,
).flatMap(([joint, spec]) =>
  Object.entries(spec.dofs).map(([axis, dof]) => ({ joint, axis, dof })),
);

describe('JOINTS band structure', () => {
  it('states every joint the table type promises', () => {
    expect(Object.keys(JOINTS).sort()).toEqual(
      ['elbow', 'finger', 'neck', 'shoulder', 'spine', 'thumb', 'wrist'].sort(),
    );
    expect(ALL_DOFS.length).toBeGreaterThan(0);
  });

  it.each(ALL_DOFS)('$joint.$axis keeps its free band inside its hard stop', ({ dof }) => {
    expect(dof.free[0]).toBeLessThanOrEqual(dof.free[1]);
    expect(dof.max[0]).toBeLessThanOrEqual(dof.max[1]);
    expect(dof.max[0]).toBeLessThanOrEqual(dof.free[0]);
    expect(dof.free[1]).toBeLessThanOrEqual(dof.max[1]);
  });

  it.each(ALL_DOFS)('$joint.$axis has somewhere to move and a label', ({ dof }) => {
    expect(dof.max[1]).toBeGreaterThan(dof.max[0]);
    expect(dof.label.length).toBeGreaterThan(0);
  });

  it.each(ALL_DOFS)('$joint.$axis stays inside a half turn either way', ({ dof }) => {
    // Radians on the way out, not degrees. A row that forgot the conversion
    // would show up here as a joint with hundreds of radians of travel.
    expect(Math.abs(deg(dof.max[0]))).toBeLessThanOrEqual(180);
    expect(Math.abs(deg(dof.max[1]))).toBeLessThanOrEqual(180);
  });

  it('leaves a strained band on every axis that is not already free from zero', () => {
    // The gap between functional and clinical range is what a solver spends.
    const withRoom = ALL_DOFS.filter(
      ({ dof }) => dof.max[1] > dof.free[1] || dof.max[0] < dof.free[0],
    );
    expect(withRoom.length).toBe(ALL_DOFS.length);
  });

  it('gives only the shoulder an elevation ceiling', () => {
    expect(JOINTS.shoulder.elevation).toBe(ELEVATION);
    for (const [joint, spec] of Object.entries(JOINTS as unknown as Record<string, JointSpec>)) {
      if (joint === 'shoulder') continue;
      expect(spec.elevation).toBeUndefined();
    }
  });
});

describe('JOINTS values the comments commit to', () => {
  it('takes the upper clinical figure for humeral rotation', () => {
    // Clinically 70-90 each way; reaching your own face needs most of it.
    const r = JOINTS.shoulder.dofs.rotation;
    expect(deg(r.max[0])).toBeCloseTo(-90, 9);
    expect(deg(r.max[1])).toBeCloseTo(90, 9);
  });

  it('makes elbow flexion free from zero, so a straight arm is not flagged', () => {
    const f = JOINTS.elbow.dofs.flexion;
    expect(f.free[0]).toBe(0);
    expect(f.max[0]).toBe(0);
    expect(deg(f.max[1])).toBeCloseTo(150, 9);
  });

  it('leaves elbow flexion a margin past the 145 a chin touch needs', () => {
    expect(deg(JOINTS.elbow.dofs.flexion.max[1])).toBeGreaterThan(145);
  });

  it('keeps elbow flexion unsigned so a backwards fold cannot hide in it', () => {
    expect(JOINTS.elbow.dofs.flexion.free[0]).toBe(0);
    expect(JOINTS.elbow.dofs.flexion.max[0]).toBe(0);
  });

  it('makes wrist deviation deeply asymmetric toward the little finger', () => {
    // Positive is toward the thumb, and 20 degrees that way already looks
    // strained where the same 20 the other way looks like nothing.
    const d = JOINTS.wrist.dofs.deviation;
    expect(deg(d.free[1])).toBeCloseTo(10, 9);
    expect(deg(d.free[0])).toBeCloseTo(-20, 9);
    expect(Math.abs(d.free[0])).toBeGreaterThan(Math.abs(d.free[1]));
    expect(Math.abs(d.max[0])).toBeGreaterThan(Math.abs(d.max[1]));
  });

  it('does not repeat one joint three times down the finger', () => {
    const { proximal, intermediate, distal } = JOINTS.finger.dofs;
    // The knuckle hyperextends and the middle joint does not.
    expect(proximal.max[0]).toBeLessThan(0);
    expect(intermediate.max[0]).toBe(0);
    // The middle joint has the most flexion of the three; the tip the least.
    expect(intermediate.free[1]).toBeGreaterThan(proximal.free[1]);
    expect(proximal.free[1]).toBeGreaterThan(distal.free[1]);
    expect(intermediate.max[1]).toBeGreaterThan(proximal.max[1]);
    expect(proximal.max[1]).toBeGreaterThan(distal.max[1]);
  });

  it('names all three segments on both the finger and the thumb', () => {
    for (const spec of [JOINTS.finger, JOINTS.thumb]) {
      expect(Object.keys(spec.dofs).sort()).toEqual(['distal', 'intermediate', 'proximal']);
    }
  });

  it('gives the thumb less flexion than a finger at the knuckle and mid joint', () => {
    for (const segment of ['proximal', 'intermediate'] as const) {
      expect(JOINTS.thumb.dofs[segment].free[1]).toBeLessThan(JOINTS.finger.dofs[segment].free[1]);
    }
  });

  it('holds the neck inside anatomy while the framing limits stay tighter', () => {
    const { pitch, yaw, roll } = JOINTS.neck.dofs;
    expect(deg(pitch.max[0])).toBeCloseTo(-70, 9);
    expect(deg(yaw.max[1])).toBeCloseTo(90, 9);
    expect(deg(roll.max[1])).toBeCloseTo(45, 9);
    // The neck turns further than the trunk on every axis.
    expect(yaw.max[1]).toBeGreaterThan(JOINTS.spine.dofs.yaw.max[1]);
    expect(roll.max[1]).toBeGreaterThan(JOINTS.spine.dofs.roll.max[1]);
  });

  it('lets the trunk bend forward much further than back', () => {
    const p = JOINTS.spine.dofs.pitch;
    expect(p.free[1]).toBeGreaterThan(Math.abs(p.free[0]));
    expect(p.max[1]).toBeGreaterThan(Math.abs(p.max[0]));
  });
});

describe('ELEVATION', () => {
  it('samples the whole circle in increasing plane order', () => {
    expect(ELEVATION[0][0]).toBe(-180);
    expect(ELEVATION[ELEVATION.length - 1][0]).toBe(180);
    for (let i = 1; i < ELEVATION.length; i++) {
      expect(ELEVATION[i][0]).toBeGreaterThan(ELEVATION[i - 1][0]);
    }
  });

  it.each(ELEVATION.map((row) => ({ plane: row[0], free: row[1], max: row[2] })))(
    'row $plane keeps a strained band above a positive free ceiling',
    ({ free, max }) => {
      expect(free).toBeGreaterThan(0);
      expect(max).toBeGreaterThan(free);
      expect(max).toBeLessThanOrEqual(180);
    },
  );

  it('meets itself at the wrap, so the two ends describe the same plane', () => {
    const first = ELEVATION[0];
    const last = ELEVATION[ELEVATION.length - 1];
    expect(last[1]).toBe(first[1]);
    expect(last[2]).toBe(first[2]);
  });

  it('states the three figures the comment names', () => {
    const at = (plane: number) => ELEVATION.find((row) => row[0] === plane);
    // Nearly straight up out to the side, 60 backwards, barely 45 across.
    expect(at(0)?.[2]).toBeGreaterThanOrEqual(175);
    expect(at(-90)?.[2]).toBe(60);
    expect(at(180)?.[2]).toBe(45);
  });

  it('is widest forward-and-out and narrowest behind-and-across', () => {
    const maxima = ELEVATION.map((row) => row[2]);
    const widest = ELEVATION[maxima.indexOf(Math.max(...maxima))];
    const narrowest = ELEVATION[maxima.indexOf(Math.min(...maxima))];
    expect(widest[0]).toBe(45);
    expect(narrowest[0]).toBe(-135);
  });
});

describe('ZONES', () => {
  it('labels exactly the three strain zones', () => {
    expect(Object.keys(ZONES).sort()).toEqual(['limit', 'natural', 'strained']);
    for (const label of Object.values(ZONES)) expect(label.length).toBeGreaterThan(0);
  });

  it('has a label for every zone zoneOf can return', () => {
    const seen = new Set<StrainZone>();
    for (let s = -0.5; s <= 2; s += 0.05) seen.add(zoneOf(s));
    expect(seen.size).toBe(3);
    for (const zone of seen) expect(ZONES[zone]).toBeDefined();
  });
});

describe('HAND_CONTACT', () => {
  it('sits between the wrist and the knuckles, not halfway down the hand', () => {
    // Wrist to fingertip, so half of it is already into the fingers and the
    // palm centre is nearer a third. Every centimetre past the palm comes
    // straight out of the arm's reach.
    expect(HAND_CONTACT).toBe(0.35);
    expect(HAND_CONTACT).toBeGreaterThan(0);
    expect(HAND_CONTACT).toBeLessThan(0.5);
  });
});
