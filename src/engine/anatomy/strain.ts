import type { JointDof, JointSpec, StrainZone } from '../types';
import { D, ELEVATION } from './joints';

/**
 * The elevation ceiling at one plane, in radians: where the free band ends and
 * where the hard stop is.
 */
export interface ElevationCeiling {
  free: number;
  max: number;
}

/**
 * Where a value sits in its range: 0 anywhere inside the free band, rising
 * linearly to 1 at the hard stop, and 1 beyond it.
 *
 * Linear, not smooth. A smooth ramp starts flat, which means the first few
 * degrees past comfortable are free — and those are exactly the degrees a
 * search will spend, because they cost nothing. The corner at the edge of the
 * free band is the point.
 */
export function strainOf(v: number, d: JointDof): number {
  const [fl, fh] = d.free;
  const [ml, mh] = d.max;
  if (v > fh) return mh > fh ? Math.min(1, (v - fh) / (mh - fh)) : 1;
  if (v < fl) return ml < fl ? Math.min(1, (fl - v) / (fl - ml)) : 1;
  return 0;
}

export const clampDof = (v: number, d: JointDof): number =>
  Math.min(d.max[1], Math.max(d.max[0], v));

export const zoneOf = (s: number): StrainZone =>
  s <= 0 ? 'natural' : s < 1 ? 'strained' : 'limit';

/**
 * How far past the hard stop a value is, in units of the strained band.
 *
 * `strainOf` caps at 1, which is right for reporting — past the stop is past the
 * stop, and there is no darker shade of impossible to show. It is wrong for
 * searching. Capped, a candidate 90 degrees beyond a ceiling scores exactly the
 * same as one a degree beyond, so where a target cannot be reached at all *every*
 * candidate saturates and the choice between them falls to whatever small terms
 * are left. That is how a hand asked for the chin came back with the elbow
 * behind the back: not because the search preferred it, but because the search
 * could not see any difference.
 */
export function excessOf(v: number, d: JointDof): number {
  const [ml, mh] = d.max;
  const band = Math.max(mh - ml, 1e-6);
  if (v > mh) return (v - mh) / band;
  if (v < ml) return (ml - v) / band;
  return 0;
}

/**
 * How much of a rotation a joint still has, given what the pose already spends.
 *
 * Against the hard stop, not the free band. Lending rotation past comfortable
 * normally just moves strain from one joint to another and is not worth doing —
 * but this is only ever called when the alternative is a joint past *impossible*,
 * and a strained shoulder beats a forearm pronated half again as far as a
 * forearm goes. Capping at the free band instead made the shoulder decline to
 * help in exactly the poses that needed it: a hand at the mouth has the humerus
 * near the top of its comfortable rotation already, so there was nothing to give
 * and the whole roll fell back onto the forearm.
 *
 * Signed both ways, since a roll can go either.
 */
export function rollRoom(used: number, d: JointDof): [number, number] {
  return [Math.min(0, d.max[0] - used), Math.max(0, d.max[1] - used)];
}

/** Interpolate the elevation ceiling for a plane angle, in radians. */
export function elevationCeiling(plane: number): ElevationCeiling {
  let deg = (plane / D) % 360;
  if (deg > 180) deg -= 360;
  if (deg < -180) deg += 360;
  for (let i = 1; i < ELEVATION.length; i++) {
    const a = ELEVATION[i - 1];
    const b = ELEVATION[i];
    if (deg <= b[0]) {
      const t = (deg - a[0]) / (b[0] - a[0]);
      return {
        free: (a[1] + (b[1] - a[1]) * t) * D,
        max: (a[2] + (b[2] - a[2]) * t) * D,
      };
    }
  }
  const last = ELEVATION[ELEVATION.length - 1];
  return { free: last[1] * D, max: last[2] * D };
}

/** Strain for elevation, which carries its ceiling rather than a fixed band. */
export function elevationStrain(theta: number, ceiling: ElevationCeiling): number {
  if (theta <= ceiling.free) return 0;
  if (ceiling.max <= ceiling.free) return 1;
  return Math.min(1, (theta - ceiling.free) / (ceiling.max - ceiling.free));
}

/**
 * Finger curl limits, as a curl fraction rather than an angle.
 *
 * The rig drives fingers by a single 0..1 curl per finger, which is the right
 * control — nobody flexes one interphalangeal joint on purpose — but the three
 * segments do not share a range, and driving them from one number through a
 * hand-guessed taper gets the ratios wrong. Curl 1 is the top of each joint's
 * *free* band, so a fist closes to a real fist; the strained band above it is
 * reachable only by asking for more than 1, which nothing does by accident.
 */
export function fingerCurl(joints: JointSpec, index: number, amount: number): number {
  const d = joints.dofs[['proximal', 'intermediate', 'distal'][index] ?? 'distal'];
  if (!d) return 0;
  const a = amount * d.free[1];
  return Math.min(d.max[1], Math.max(d.max[0], a));
}
