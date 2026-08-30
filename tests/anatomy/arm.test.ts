import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ArmAnatomy, elevationCeiling, JOINTS, zoneOf } from '@/engine/anatomy';
import { BodyVolumes } from '@/engine/anatomy/volumes';
import { buildProfile } from '@/engine/profile';
import type { Profile, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

/**
 * One arm, measured and bounded.
 *
 * Everything here goes in as world directions and comes back as a reading, so
 * the properties worth pinning are about the *frame* the reading is taken in and
 * about which quantity a given defect shows up as — not about any one number.
 */

/** Angles are built from exact trigonometry, so a reading is exact to rounding. */
const EXACT = 1e-9;

/** A clamp that has already run has nothing left to do, to within rounding. */
const IDEMPOTENT = 1e-9;

/** Half a degree: below this an angle is "near zero" for a pose stated as exact. */
const NEAR_ZERO = 0.0087;

interface Body {
  profile: Profile;
  anat: ArmAnatomy;
  up: THREE.Vector3;
  down: THREE.Vector3;
  fwd: THREE.Vector3;
  /** The character's own outside, per side. */
  outward: (side: Side) => THREE.Vector3;
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`synthetic rig has no ${what}`);
  return value;
}

function buildBody(): Body {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const anat = new ArmAnatomy(profile);
  expect(anat.update()).toBe(true);
  return {
    profile,
    anat,
    up: anat.up.clone(),
    down: anat.up.clone().negate(),
    fwd: anat.fwd.clone(),
    outward: (side) => (side === 'L' ? anat.right.clone().negate() : anat.right.clone()),
  };
}

/** A direction `angle` away from `from`, swung toward `toward`. */
const swung = (from: THREE.Vector3, toward: THREE.Vector3, angle: number): THREE.Vector3 =>
  from.clone().multiplyScalar(Math.cos(angle)).addScaledVector(toward, Math.sin(angle)).normalize();

const rowOf = (anat: ArmAnatomy, id: string) => {
  const row = anat.report().find((r) => r.id === id);
  return need(row, `report row ${id}`);
};

/** Put the arm's origin and lengths in, so the torso terms are live. */
function placeArm(body: Body, side: Side): void {
  const bone = need(body.profile.bones[`upperArm.${side}`], `upperArm.${side}`);
  bone.updateWorldMatrix(true, false);
  body.anat.setArm(
    bone.getWorldPosition(new THREE.Vector3()),
    need(body.profile.limb[`upper.${side}`], `upper.${side}`),
    need(body.profile.limb[`lower.${side}`], `lower.${side}`),
    need(body.profile.limb[`tip.${side}.middle`], `tip.${side}.middle`) * 0.35,
  );
}

describe('ArmAnatomy.measure', () => {
  it('reads a hanging arm as no elevation and a raised one as ninety degrees', () => {
    const body = buildBody();

    for (const side of ['L', 'R'] as Side[]) {
      const hanging = body.anat.measure(side, body.down, body.down, body.down, null);
      expect(hanging.elevation).toBeLessThan(NEAR_ZERO);

      const out = body.outward(side);
      const raised = body.anat.measure(side, out, out, out, null);
      expect(Math.abs(raised.elevation - Math.PI / 2)).toBeLessThan(EXACT);
      // Straight out to the side is plane 0, which is the abduction row.
      expect(Math.abs(raised.plane)).toBeLessThan(EXACT);
    }
  });

  it('measures elevation from hanging, not from the bind pose', () => {
    const body = buildBody();
    // The synthetic rig binds with the arms out to the sides, so a reading taken
    // against the bind would call that pose zero. It is ninety.
    const out = body.outward('L');
    expect(body.anat.measure('L', out, out, out, null).elevation).toBeCloseTo(Math.PI / 2, 9);
    expect(body.anat.measure('L', body.down, body.down, body.down, null).elevation).toBeCloseTo(
      0,
      9,
    );
    expect(body.anat.measure('L', body.up, body.up, body.up, null).elevation).toBeCloseTo(
      Math.PI,
      9,
    );
  });

  it('mirrors the plane, so one elevation table serves both arms', () => {
    const body = buildBody();
    const angle = 0.8;

    const left = body.anat.measure(
      'L',
      swung(body.down, body.outward('L'), angle),
      body.down,
      body.down,
      null,
    );
    const leftPlane = left.plane;
    const leftElevation = left.elevation;

    const right = body.anat.measure(
      'R',
      swung(body.down, body.outward('R'), angle),
      body.down,
      body.down,
      null,
    );
    expect(right.elevation).toBeCloseTo(leftElevation, 9);
    expect(right.plane).toBeCloseTo(leftPlane, 9);
  });

  it('leaves the plane of a hanging arm undetermined and marks it unmeasured', () => {
    const body = buildBody();
    body.anat.measure('L', body.down, body.down, body.down, null);

    // Nothing is derived from the horizontal residue, because there is none.
    expect(body.anat.m.plane).toBe(0);

    const row = rowOf(body.anat, 'plane');
    expect(row.measured).toBe(false);
    expect(row.strain).toBe(0);
    // Elevation, by contrast, is determined by this pose and is reported as such.
    expect(rowOf(body.anat, 'elevation').measured).toBe(true);
  });

  it('fades humeral rotation out on a straight arm rather than reporting noise', () => {
    const body = buildBody();
    const outward = body.outward('L');

    // An arm resting at the side carries about eleven degrees of elbow bend.
    // Whichever way that little bend happens to point, it says nothing about
    // how the humerus is rotated.
    for (const toward of [body.fwd, body.fwd.clone().negate(), outward]) {
      const fore = swung(body.down, toward, 0.192);
      const m = body.anat.measure('L', body.down, fore, fore, null);

      expect(m.elbow).toBeCloseTo(0.192, 9);
      expect(m.rotationRead).toBe(0);
      expect(m.rotation).toBe(0);
      expect(body.anat.score().rotation).toBe(0);
      expect(rowOf(body.anat, 'rotation').zone).toBe('natural');
      expect(rowOf(body.anat, 'rotation').measured).toBe(false);
    }
  });

  it('trusts the rotation reading once the elbow is bent far enough to carry it', () => {
    const body = buildBody();
    const read = (bend: number) => {
      const fore = swung(body.down, body.outward('L'), bend);
      return body.anat.measure('L', body.down, fore, fore, null).rotationRead;
    };

    // Nothing below fifteen degrees, rising to full trust by forty-five.
    expect(read(0.26 - 1e-6)).toBe(0);
    expect(read(0.26 + 0.26)).toBeCloseTo(0.5, 6);
    expect(read(0.78 + 1e-6)).toBe(1);
    expect(read(1.5)).toBe(1);
  });

  it('reports a deliberate humeral roll even on a straight arm', () => {
    const body = buildBody();
    // Applied twist is known exactly, unlike the kind inferred from the elbow,
    // so it carries its own confidence.
    const m = body.anat.measure('L', body.down, body.down, body.down, null, 0, 0.7);
    expect(m.rotation).toBeCloseTo(0.7, 9);
    expect(m.rotationRead).toBe(1);
    expect(rowOf(body.anat, 'rotation').measured).toBe(true);
  });

  it('catches a backwards-bending elbow as a shoulder rotation, not as an elbow angle', () => {
    const body = buildBody();
    const back = body.fwd.clone().negate();
    const fore = swung(body.down, back, 1.047);

    const m = body.anat.measure('L', body.down, fore, fore, null);
    const strain = body.anat.score();

    // The elbow itself is at a perfectly ordinary sixty degrees of flexion, so
    // the flexion limit has nothing to say about it.
    expect(m.elbow).toBeCloseTo(1.047, 9);
    expect(m.elbow).toBeLessThan(JOINTS.elbow.dofs.flexion.free[1]);
    expect(strain.elbow).toBe(0);
    expect(rowOf(body.anat, 'elbow').zone).toBe('natural');

    // The defect lands on the shoulder instead: a rotation no shoulder has.
    expect(Math.abs(m.rotation)).toBeGreaterThan(Math.PI - 0.01);
    expect(Math.abs(m.rotation)).toBeGreaterThan(JOINTS.shoulder.dofs.rotation.max[1]);
    expect(m.rotationRead).toBe(1);
    expect(strain.rotation).toBe(1);
    expect(rowOf(body.anat, 'rotation').zone).toBe('limit');

    // A forwards bend of the same size is the normal elbow, and is free.
    const forwards = swung(body.down, body.fwd, 1.047);
    body.anat.measure('L', body.down, forwards, forwards, null);
    expect(Math.abs(body.anat.m.rotation)).toBeLessThan(EXACT);
    expect(body.anat.score().rotation).toBe(0);
  });

  it('scores an unconstrained wrist as pure flexion and a stated palm as a split', () => {
    const body = buildBody();
    const fore = body.down;
    const hand = swung(fore, body.fwd, 0.5);

    const free = body.anat.measure('L', body.down, fore, hand, null);
    expect(free.wristFlex).toBeCloseTo(0.5, 9);
    expect(free.wristDev).toBe(0);

    // With the palm named, the same bend splits into the two planes.
    const palm = body.outward('L');
    const stated = body.anat.measure('L', body.down, fore, hand, palm);
    expect(Math.hypot(stated.wristFlex, stated.wristDev)).toBeCloseTo(0.5, 9);
    expect(Math.abs(stated.wristDev)).toBeGreaterThan(0.1);
  });
});

describe('ArmAnatomy.clamp', () => {
  it('pulls an out-of-range set of directions back inside the hard stops', () => {
    const body = buildBody();
    const anat = body.anat;
    // No arm context, so this is the angular clamp alone; the trunk escape has
    // nothing to push out of.
    anat.clearArm();

    const upper = body.up.clone();
    const fore = swung(upper, body.fwd, 2.97);
    const hand = swung(fore, body.outward('L'), 1.4);
    const palm = body.fwd.clone();

    const before = anat.measure('L', upper, fore, hand, palm);
    expect(before.elevation).toBeGreaterThan(elevationCeiling(before.plane).max);
    expect(before.elbow).toBeGreaterThan(JOINTS.elbow.dofs.flexion.max[1]);

    anat.clamp('L', upper, fore, hand, palm);
    const after = anat.measure('L', upper, fore, hand, palm);

    expect(after.elevation).toBeLessThanOrEqual(elevationCeiling(after.plane).max + EXACT);
    expect(after.elbow).toBeLessThanOrEqual(JOINTS.elbow.dofs.flexion.max[1] + EXACT);
    expect(after.wristFlex).toBeLessThanOrEqual(JOINTS.wrist.dofs.flexion.max[1] + EXACT);
    expect(after.wristFlex).toBeGreaterThanOrEqual(JOINTS.wrist.dofs.flexion.max[0] - EXACT);
    expect(after.wristDev).toBeLessThanOrEqual(JOINTS.wrist.dofs.deviation.max[1] + EXACT);
    expect(after.wristDev).toBeGreaterThanOrEqual(JOINTS.wrist.dofs.deviation.max[0] - EXACT);

    for (const v of [upper, fore, hand]) {
      expect(Math.abs(v.length() - 1)).toBeLessThan(EXACT);
    }
  });

  it('has nothing left to do on a second pass', () => {
    const body = buildBody();
    const anat = body.anat;
    anat.clearArm();

    const upper = body.up.clone();
    const fore = swung(upper, body.fwd, 2.97);
    const hand = swung(fore, body.outward('L'), 1.4);
    const palm = body.fwd.clone();

    anat.clamp('L', upper, fore, hand, palm);
    const once = [upper.clone(), fore.clone(), hand.clone()];
    anat.clamp('L', upper, fore, hand, palm);

    expect(upper.distanceTo(once[0])).toBeLessThan(IDEMPOTENT);
    expect(fore.distanceTo(once[1])).toBeLessThan(IDEMPOTENT);
    expect(hand.distanceTo(once[2])).toBeLessThan(IDEMPOTENT);
  });

  it('leaves a pose already inside the stops untouched', () => {
    const body = buildBody();
    body.anat.clearArm();

    const upper = swung(body.down, body.fwd, 0.6);
    const fore = swung(upper, body.fwd, 0.8);
    const hand = swung(fore, body.fwd, 0.2);
    const before = [upper.clone(), fore.clone(), hand.clone()];

    body.anat.clamp('L', upper, fore, hand, null);

    expect(upper.distanceTo(before[0])).toBeLessThan(IDEMPOTENT);
    expect(fore.distanceTo(before[1])).toBeLessThan(IDEMPOTENT);
    expect(hand.distanceTo(before[2])).toBeLessThan(IDEMPOTENT);
  });

  it('keeps shoulder, forearm, and hand relief outputs on their own dispatch paths', () => {
    const body = buildBody();
    const chest = need(
      body.profile.bones.chest ?? body.profile.bones.spine ?? body.profile.bones.hips,
      'chest',
    );
    const makeVolumes = () => {
      const volumes = new BodyVolumes(
        body.profile,
        body.profile.body,
        body.anat.up,
        body.anat.right,
        body.anat.fwd,
      );
      volumes.update(chest);
      const shoulder = need(body.profile.bones['upperArm.L'], 'upperArm.L');
      volumes.setArm(
        shoulder.getWorldPosition(new THREE.Vector3()),
        need(body.profile.limb['upper.L'], 'upper.L'),
        need(body.profile.limb['lower.L'], 'lower.L'),
        need(body.profile.limb['tip.L.middle'], 'tip.L.middle') * 0.35,
      );
      return volumes;
    };
    const lateral = body.outward('L');

    const shoulder = swung(body.anat.right, body.down, 0.3);
    expect(makeVolumes().clear(shoulder, null, null, lateral)).toBe(true);
    expect(shoulder.x).toBeCloseTo(0.09412242595804733, 12);
    expect(shoulder.y).toBeCloseTo(-0.9955606304649517, 12);

    const forearm = swung(body.anat.right, body.down, 0.8);
    const forearmUpper = body.down.clone();
    expect(makeVolumes().clear(forearmUpper, forearm, null, lateral)).toBe(true);
    expect(forearmUpper.distanceTo(body.down)).toBeLessThan(EXACT);
    expect(forearm.x).toBeCloseTo(0.17015888529355686, 12);
    expect(forearm.y).toBeCloseTo(-0.9854166396786965, 12);

    const handUpper = body.down.clone();
    const handForearm = swung(body.anat.right, body.down, 0.3);
    const hand = handForearm.clone();
    expect(makeVolumes().clear(handUpper, handForearm, hand, lateral, 'hand')).toBe(true);
    expect(handUpper.distanceTo(body.down)).toBeLessThan(EXACT);
    expect(handForearm.x).toBeCloseTo(0.955336489125606, 12);
    expect(handForearm.y).toBeCloseTo(-0.29552020666133955, 12);
    expect(hand.x).toBeCloseTo(0.9999999999824337, 12);
    expect(hand.y).toBeCloseTo(-0.0000059272894388501754, 12);
  });
});

describe('ArmAnatomy.cost', () => {
  it('is finite, free for a hanging arm and dearer for one held overhead', () => {
    const body = buildBody();
    placeArm(body, 'L');

    body.anat.measure('L', body.down, body.down, body.down, null);
    const hanging = body.anat.cost();
    body.anat.measure('L', body.up, body.up, body.up, null);
    const overhead = body.anat.cost();

    expect(Number.isFinite(hanging)).toBe(true);
    expect(Number.isFinite(overhead)).toBe(true);
    expect(hanging).toBeGreaterThanOrEqual(0);
    expect(overhead).toBeGreaterThan(hanging);
  });

  it('charges gravity from hanging, so a horizontal arm is not free', () => {
    const body = buildBody();
    placeArm(body, 'L');
    const outward = body.outward('L');

    const cost = (angle: number) => {
      const upper = swung(body.down, outward, angle);
      body.anat.measure('L', upper, upper, upper, null);
      return body.anat.cost();
    };

    // Straight out to the side is well inside every joint's range, so anything
    // it costs is the lift term alone.
    expect(body.anat.m.torso).toBe(0);
    expect(cost(Math.PI / 2)).toBeGreaterThan(cost(0.2));
    expect(cost(0.2)).toBeGreaterThanOrEqual(cost(0));
  });

  it('is much higher for an arm driven inside the body than for any joint strain', () => {
    const body = buildBody();
    placeArm(body, 'L');

    body.anat.measure('L', body.up, body.up, body.up, null);
    const overhead = body.anat.cost();

    // Across the midline and slightly down, which runs the upper arm through
    // the trunk while both of its ends stay outside it.
    const through = body.anat.right.clone().multiplyScalar(1).addScaledVector(body.up, -0.3);
    through.normalize();
    body.anat.measure('L', through, through, through, null);
    const buried = body.anat.cost();

    expect(body.anat.m.torso).toBeGreaterThan(0.5);
    expect(Number.isFinite(buried)).toBe(true);
    expect(buried).toBeGreaterThan(overhead * 3);
    expect(rowOf(body.anat, 'torso').zone).toBe('limit');
  });

  it('can tell a shallow penetration from a deep one', () => {
    const body = buildBody();
    placeArm(body, 'L');

    const cost = (inward: number) => {
      const dir = body.anat.right.clone().multiplyScalar(inward).addScaledVector(body.up, -1);
      dir.normalize();
      body.anat.measure('L', dir, dir, dir, null);
      return { cost: body.anat.cost(), depth: body.anat.m.torso };
    };

    const shallow = cost(0.13);
    const deep = cost(1);
    // Genuinely shallow against genuinely buried, rather than two saturated readings.
    expect(shallow.depth).toBeGreaterThan(0);
    expect(shallow.depth).toBeLessThan(0.2);
    expect(deep.depth).toBeGreaterThan(shallow.depth + 0.3);
    // A slope, not a flat charge: the search has to be able to walk out the
    // shallow side.
    expect(deep.cost).toBeGreaterThan(shallow.cost);
  });
});

describe('ArmAnatomy.report', () => {
  it('returns one row per degree of freedom, each zoned consistently with its strain', () => {
    const body = buildBody();
    placeArm(body, 'L');
    const outward = body.outward('L');

    const poses: Array<[string, THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [
      ['hanging', body.down, body.down, body.down],
      ['abducted', outward, outward, outward],
      ['overhead', body.up, body.up, body.up],
      ['folded', body.down, swung(body.down, body.fwd, 2.9), swung(body.down, body.fwd, 2.9)],
      [
        'behind',
        swung(body.down, body.fwd.clone().negate(), 2.0),
        body.down,
        swung(body.down, outward, 1.2),
      ],
    ];

    for (const [label, upper, fore, hand] of poses) {
      body.anat.measure('L', upper, fore, hand, outward);
      const rows = body.anat.report();

      expect(rows.map((r) => r.id)).toEqual([
        'elevation',
        'plane',
        'rotation',
        'elbow',
        'forearm',
        'wristFlex',
        'wristDev',
        'torso',
        'inboard',
      ]);

      for (const row of rows) {
        expect(row.zone, `${label}/${row.id} zone`).toBe(zoneOf(row.strain));
        expect(row.strain, `${label}/${row.id} strain`).toBeGreaterThanOrEqual(0);
        expect(row.strain, `${label}/${row.id} strain`).toBeLessThanOrEqual(1);
        expect(Number.isFinite(row.deg), `${label}/${row.id} deg`).toBe(true);
        expect(row.label.en.length).toBeGreaterThan(0);
        expect(row.label.ja.length).toBeGreaterThan(0);
        expect(row.range[1]).toBeGreaterThan(row.range[0]);
      }
    }
  });

  it('reports angles in degrees and the two contact rows as percentages', () => {
    const body = buildBody();
    placeArm(body, 'L');
    const outward = body.outward('L');
    body.anat.measure('L', outward, outward, outward, null);

    expect(rowOf(body.anat, 'elevation').deg).toBeCloseTo(90, 6);
    expect(rowOf(body.anat, 'elevation').unit).toBeUndefined();
    expect(rowOf(body.anat, 'torso').unit).toBe('%');
    expect(rowOf(body.anat, 'inboard').unit).toBe('%');
  });

  it('marks the torso row unmeasured until the arm has been placed', () => {
    const body = buildBody();
    body.anat.clearArm();
    body.anat.measure('L', body.down, body.down, body.down, null);
    expect(rowOf(body.anat, 'torso').measured).toBe(false);

    placeArm(body, 'L');
    body.anat.measure('L', body.down, body.down, body.down, null);
    expect(rowOf(body.anat, 'torso').measured).toBe(true);
  });
});
