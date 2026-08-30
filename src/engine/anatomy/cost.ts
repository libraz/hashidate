import type { Localized } from '../../i18n/locale';
import type { JointReading, JointTable } from '../types';
import { BODY_DEPTH, BODY_HIT, D, INBOARD_COST, LIFT_COST } from './joints';
import type { ArmMeasurement, ArmStrain } from './measurement';
import { elevationCeiling, elevationStrain, excessOf, strainOf, zoneOf } from './strain';

/**
 * What a measured arm costs.
 *
 * Three readings of the same numbers, for three different callers: `score` for
 * anything that wants strain per joint, `cost` for the elbow search, which
 * needs one number to minimise, and `report` for the panel, which needs a row
 * per joint with a range beside it.
 *
 * Every weight here was arrived at by watching two avatars reach for things,
 * and most of them carry a comment saying which pose they exist to prevent.
 */

/** How far past `deg` a raw reading is, as this file reports it. */
export function armDegrees(value: number): number {
  return value / D;
}

/**
 * Strain per degree of freedom for the last measurement.
 *
 * Returned as a shared object, deliberately: this runs inside a search loop
 * that evaluates a couple of dozen candidates per arm per frame.
 */
export function score(m: ArmMeasurement, limits: JointTable, out: ArmStrain): ArmStrain {
  const L = limits;
  const s = out;
  s.elevation = elevationStrain(m.elevation, elevationCeiling(m.plane));
  // Humeral rotation is read off where the elbow points, so a straight elbow
  // does not measure it: there is no bend to point anywhere, and what is left
  // is the direction of a vector that is almost entirely rounding error. This
  // is why the clinical test flexes the elbow to 90 first.
  //
  // Without the fade, an arm resting at the side — 11 degrees of elbow bend —
  // reported 50 degrees of rotation and was flagged strained. Every gesture
  // in the table was, including the ones that do not move the arms at all.
  s.rotation = strainOf(m.rotation, L.shoulder.dofs.rotation) * m.rotationRead;
  s.elbow = strainOf(m.elbow, L.elbow.dofs.flexion);
  s.forearm = strainOf(m.forearm, L.elbow.dofs.rotation);
  s.wristFlex = strainOf(m.wristFlex, L.wrist.dofs.flexion);
  s.wristDev = strainOf(m.wristDev, L.wrist.dofs.deviation);
  // Contact, not strain — but it belongs in the same table, because to
  // whoever is watching an elbow inside the ribcage and an elbow past its
  // rotation stop are the same defect. Any penetration at all is the limit;
  // there is no comfortable amount of being inside your own chest.
  s.torso = m.torso > 0 ? 1 : 0;
  return s;
}

/**
 * One number for how unlikely a pose is — what the elbow search minimises.
 *
 * Strain is only part of it. Range of motion says which poses are *possible*,
 * and for a fingertip target most of the elbow circle is: pointing straight
 * ahead can be done with the elbow hanging below the wrist or cocked above
 * it, and both are comfortably inside every joint's range. Scored on strain
 * alone the two are indistinguishable, and the search picked the raised elbow
 * — anatomically fine, and not what anybody does.
 *
 * So effort is scored as well. Holding an arm up costs something whether or
 * not any joint is near its limit, and that cost is what separates the pose a
 * person adopts from the set of poses a person could adopt.
 */
export function cost(m: ArmMeasurement, limits: JointTable, strain: ArmStrain): number {
  const s = score(m, limits, strain);
  let total = 0;
  // Squared, so the search spreads strain rather than concentrating it: two
  // joints slightly outside comfortable beat one joint at its stop, which is
  // both how a person distributes a reach and what stops the solver parking a
  // single joint against a hard limit while the rest of the arm idles.
  //
  // Torso contact is excluded and charged below: it is not a strain that gets
  // gradually worse, and squaring a binary would leave the search no slope to
  // follow out of the chest.
  for (const k in s) {
    if (k !== 'torso') {
      const v = s[k as keyof ArmStrain];
      total += v * v;
    }
  }
  // The hard stop is not just an expensive place to be, it is a place the
  // result will be clamped out of — so a candidate that reaches one is worse
  // than its strain suggests, because the pose that comes back is not the
  // pose that was scored.
  for (const k in s) if (k !== 'torso' && s[k as keyof ArmStrain] >= 1) total += 4;
  // And how far past it. Strain stops at the stop; this does not, so where
  // nothing on the elbow circle is reachable the search can still tell the
  // least impossible pose from the worst one instead of choosing between
  // saturated equals. Charged steeply — being outside the range at all is
  // already the flat 4 above, and this only has to break the tie.
  const L = limits;
  let over =
    excessOf(m.elbow, L.elbow.dofs.flexion) +
    excessOf(m.forearm, L.elbow.dofs.rotation) +
    excessOf(m.wristFlex, L.wrist.dofs.flexion) +
    excessOf(m.wristDev, L.wrist.dofs.deviation) +
    excessOf(m.rotation, L.shoulder.dofs.rotation) * m.rotationRead;
  const ceil = elevationCeiling(m.plane);
  if (m.elevation > ceil.max) over += (m.elevation - ceil.max) / Math.PI;
  total += 8 * over;
  // Being inside the body: a flat charge that outbids any joint, plus a slope
  // so the search can tell "just inside" from "buried" and walk out the
  // shallow side.
  //
  // The slope has to be much larger than the step, and was not. At 6 and 6, a
  // pose 83% inside the head cost 3.3 more than one 28% inside — less than a
  // single joint reaching its stop — so wherever the whole elbow circle was
  // penetrating, which is the case that matters, the search was choosing on
  // the joint terms and was very nearly blind to depth.
  if (m.torso > 0) total += BODY_HIT + BODY_DEPTH * m.torso;
  // Gravity: zero for an arm hanging, half at horizontal, one overhead.
  //
  // Charged from hanging and not from horizontal, which is the version this
  // started as. A horizontal upper arm costs a shoulder real effort, and
  // scoring it free let the search park the elbow out at shoulder height on
  // every point — anatomically fine, and a chicken wing. What holds it back
  // from the opposite mistake, tucking the elbow across the ribs to get it
  // low, is the elevation ceiling: that direction runs out of range at 45
  // degrees, so the strain term outbids the saving long before it gets there.
  const lift = (1 - Math.cos(m.elevation)) / 2;
  total += LIFT_COST * lift * lift;
  // Bringing the elbow inside the shoulder line. Anatomically available and
  // almost never used: a tucked-in elbow is a closed, guarded posture, and
  // outside of folding your arms nobody holds one to do something with their
  // hand. Everything else here is either a joint limit or gravity, and both
  // are indifferent to it — the ceiling table drops toward the midline, but
  // only bites *above* the ceiling, so an elbow tucked across the body at a
  // low elevation was free. It is what the search picked whenever a target
  // near the face made the honest solutions expensive.
  //
  // Weighted to outbid the saving it buys. Tucking the elbow in is usually
  // also tucking it *down*, so it collects a gravity discount, and at a lower
  // weight the search still took the trade.
  total += INBOARD_COST * m.inboard * m.inboard;
  return total;
}

/** A readable snapshot, for the panel. Allocates; not for the frame loop. */
export function report(
  m: ArmMeasurement,
  limits: JointTable,
  strain: ArmStrain,
  seen: { torso: boolean; arm: boolean },
): JointReading[] {
  const s = score(m, limits, strain);
  const ceil = elevationCeiling(m.plane);
  // `measured: false` marks a quantity that exists but is not determined by
  // the current pose — the plane of a hanging arm, the rotation of a straight
  // one. Showing a zone for those would be reporting noise as a judgement.
  const row = (
    id: string,
    label: Localized,
    value: number,
    strain: number,
    range: [number, number],
    measured = true,
  ): JointReading => ({
    id,
    label,
    deg: value / D,
    strain,
    zone: zoneOf(strain),
    range,
    measured,
  });
  const L = limits;
  const deg = (r: [number, number]): [number, number] => [r[0] / D, r[1] / D];
  return [
    row('elevation', { en: 'Shoulder elevation', ja: '肩 挙上' }, m.elevation, s.elevation, [
      0,
      ceil.max / D,
    ]),
    row('plane', { en: 'Shoulder plane', ja: '肩 挙上面' }, m.plane, 0, [-180, 180], false),
    row(
      'rotation',
      { en: 'Shoulder rotation', ja: '肩 回旋' },
      m.rotation,
      s.rotation,
      deg(L.shoulder.dofs.rotation.max),
      m.rotationRead > 0.01,
    ),
    row(
      'elbow',
      { en: 'Elbow flexion', ja: '肘 屈曲' },
      m.elbow,
      s.elbow,
      deg(L.elbow.dofs.flexion.max),
    ),
    row(
      'forearm',
      { en: 'Forearm rotation', ja: '前腕 回内外' },
      m.forearm,
      s.forearm,
      deg(L.elbow.dofs.rotation.max),
    ),
    row(
      'wristFlex',
      { en: 'Wrist flexion', ja: '手首 掌背屈' },
      m.wristFlex,
      s.wristFlex,
      deg(L.wrist.dofs.flexion.max),
    ),
    row(
      'wristDev',
      { en: 'Wrist deviation', ja: '手首 橈尺屈' },
      m.wristDev,
      s.wristDev,
      deg(L.wrist.dofs.deviation.max),
    ),
    // Reported as a percentage of the trunk radius rather than an angle,
    // because it is not one.
    {
      id: 'torso',
      label: { en: 'Arm inside the body', ja: '腕の身体貫通' },
      deg: m.torso * 100,
      unit: '%',
      strain: s.torso,
      zone: zoneOf(s.torso),
      range: [0, 100],
      measured: seen.torso && seen.arm,
    },
    // Not a limit — an elbow inside the shoulder line is available, it is just
    // not what people do. Reported because when a solved pose looks closed or
    // guarded, this is usually the number that says why.
    {
      id: 'inboard',
      label: { en: 'Elbow tucked in', ja: '肘の内寄り' },
      deg: m.inboard * 100,
      unit: '%',
      strain: 0,
      zone: 'natural',
      range: [0, 100],
      measured: true,
    },
  ];
}
