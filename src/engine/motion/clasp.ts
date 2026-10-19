import * as THREE from 'three';
import { INTERLACE_GAP, SPLAY_CAP } from '../anatomy';
import type { FingerSpec, Side } from '../types';

/**
 * Interlaced-finger clasp built from the rig's own measurements.
 *
 * The follower hand is the leader's mirror image across a plane between the two
 * knuckle rows, shifted half a pitch along the row so its fingers fall in the
 * leader's gaps. Pure and allocation-free; all scratch is module-level.
 */

/** Rig lengths a clasp is sized from, in world units. */
export interface ClaspMeasure {
  pitch: number;
  proximal: number;
}

/** The leader's posed hand, world space; `palm` is a unit normal. */
export interface ClaspLeader {
  wrist: THREE.Vector3;
  index: THREE.Vector3;
  middle: THREE.Vector3;
  ring: THREE.Vector3;
  little: THREE.Vector3;
  palm: THREE.Vector3;
}

/** Where the follower's wrist goes and how its hand points; `hand` and `palm` are unit. */
export interface ClaspPlacement {
  wrist: THREE.Vector3;
  hand: THREE.Vector3;
  palm: THREE.Vector3;
}

const EPS = 1e-9;

const _l = new THREE.Vector3();
const _haRaw = new THREE.Vector3();
const _ha = new THREE.Vector3();
const _na = new THREE.Vector3();
const _m = new THREE.Vector3();
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Measured pitch and proximal length for a side, or null when the rig lacks them. */
export function claspMeasure(limb: Record<string, number>, side: Side): ClaspMeasure | null {
  const pitch = limb[`pitch.${side}`];
  const proximal = limb[`proximal.${side}`];
  if (!(pitch > 0 && proximal > 0)) return null;
  return { pitch, proximal };
}

/** Remove the component of `v` along unit `axis`. */
function reject(v: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 {
  return v.addScaledVector(axis, -v.dot(axis));
}

/**
 * Place the follower against the leader's posed hand.
 *
 * @param dihedral Half the opening angle of the two palm planes, toward the wrists.
 * @returns false on a degenerate frame, leaving `out` untouched.
 */
export function placeFollower(
  leader: ClaspLeader,
  lead: ClaspMeasure,
  dihedral: number,
  out: ClaspPlacement,
): boolean {
  _l.subVectors(leader.little, leader.index);
  if (_l.lengthSq() < EPS) return false;
  _l.normalize();

  _haRaw.subVectors(leader.middle, leader.wrist);
  if (_haRaw.lengthSq() < EPS) return false;
  _haRaw.normalize();
  _ha.copy(_haRaw);
  reject(_ha, _l);
  if (_ha.lengthSq() < EPS) return false;
  _ha.normalize();

  _na.copy(leader.palm);
  reject(_na, _l);
  reject(_na, _ha);
  if (_na.lengthSq() < EPS) return false;
  _na.normalize();

  _m.copy(_na).multiplyScalar(Math.cos(dihedral)).addScaledVector(_ha, Math.sin(dihedral));
  _m.normalize();

  // Plane point Pa = centroid + (g / 2) m, held in _p.
  _p.copy(leader.index).add(leader.middle).add(leader.ring).add(leader.little).multiplyScalar(0.25);
  _p.addScaledVector(_m, 0.5 * INTERLACE_GAP * lead.pitch);

  // Wf = reflect(Wa) + (pitch / 2) l
  _t.subVectors(leader.wrist, _p);
  out.wrist
    .copy(leader.wrist)
    .addScaledVector(_m, -2 * _t.dot(_m))
    .addScaledVector(_l, 0.5 * lead.pitch);

  out.hand
    .copy(_haRaw)
    .addScaledVector(_m, -2 * _haRaw.dot(_m))
    .normalize();
  out.palm
    .copy(_na)
    .addScaledVector(_m, -2 * _na.dot(_m))
    .normalize();
  return true;
}

/** Per-finger spread for one hand of a clasp; thumbs stay at 0. */
export function claspSpread(m: ClaspMeasure, role: 'lead' | 'follow', out: FingerSpec): FingerSpec {
  const step = Math.min((0.5 * m.pitch) / m.proximal, SPLAY_CAP / 2);
  const lead = role === 'lead';
  out.thumb = 0;
  out.index = (lead ? -1.5 : -1) * step;
  out.middle = (lead ? -0.5 : 0) * step;
  out.ring = (lead ? 0.5 : 1) * step;
  out.little = (lead ? 1.5 : 2) * step;
  return out;
}
