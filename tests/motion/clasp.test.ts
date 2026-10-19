import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { INTERLACE_GAP, SPLAY_CAP } from '@/engine/anatomy';
import {
  type ClaspLeader,
  type ClaspMeasure,
  type ClaspPlacement,
  claspMeasure,
  claspSpread,
  placeFollower,
} from '@/engine/motion/clasp';

const PITCH = 0.012;
const BETA = 0.3;
const MEASURE: ClaspMeasure = { pitch: PITCH, proximal: 0.025 };

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A hand with its row along +x, fingers along +y and palm facing +z; the middle MCP is 3 mm off the perpendicular. */
function leader(): ClaspLeader {
  return {
    wrist: v(0, 0, 0),
    index: v(-1.5 * PITCH, 0.09, 0),
    middle: v(-0.5 * PITCH + 0.003, 0.09, 0),
    ring: v(0.5 * PITCH, 0.09, 0),
    little: v(1.5 * PITCH, 0.09, 0),
    palm: v(0, 0.2, 1).normalize(),
  };
}

function place(l: ClaspLeader): ClaspPlacement {
  const out = { wrist: v(0, 0, 0), hand: v(0, 0, 0), palm: v(0, 0, 0) };
  expect(placeFollower(l, MEASURE, BETA, out)).toBe(true);
  return out;
}

/** The mirror normal for the frame `leader()` builds (row +x, fingers +y, palm +z). */
function normal(): THREE.Vector3 {
  const na = v(0, 0, 1);
  const ha = v(0, 1, 0);
  return na.multiplyScalar(Math.cos(BETA)).addScaledVector(ha, Math.sin(BETA)).normalize();
}

const reflectDir = (x: THREE.Vector3, m: THREE.Vector3) =>
  x.clone().addScaledVector(m, -2 * x.dot(m));

describe('placeFollower', () => {
  it('mirrors the hand axis and palm across the plane, which opens toward the wrists', () => {
    const l = leader();
    const m = normal();
    const out = place(l);
    expect(m.dot(v(0, 1, 0))).toBeCloseTo(Math.sin(BETA), 12);

    const haRaw = l.middle.clone().sub(l.wrist).normalize();
    expect(out.hand.distanceTo(reflectDir(haRaw, m))).toBeLessThan(1e-12);
    expect(out.hand.length()).toBeCloseTo(1, 12);
    expect(out.palm.distanceTo(reflectDir(v(0, 0, 1), m))).toBeLessThan(1e-12);
    expect(out.palm.length()).toBeCloseTo(1, 12);
  });

  it('puts the follower knuckles a row gap away along the normal and half a pitch along the row', () => {
    const l = leader();
    const m = normal();
    const out = place(l);
    const mcps = [l.index, l.middle, l.ring, l.little];
    const ell = v(1, 0, 0);

    for (const [i, mcp] of mcps.entries()) {
      // The follower's own MCP, carried by its wrist and the reflected wrist-to-MCP offset.
      const f = out.wrist.clone().add(reflectDir(mcp.clone().sub(l.wrist), m));
      const d = f.clone().sub(mcp);
      expect(Math.abs(d.dot(m))).toBeCloseTo(INTERLACE_GAP * PITCH, 12);
      expect(d.dot(ell)).toBeCloseTo(0.5 * PITCH, 12);
      if (i < 3) {
        const next = mcps[i + 1].dot(ell);
        expect(f.dot(ell)).toBeGreaterThan(mcp.dot(ell));
        expect(f.dot(ell)).toBeLessThan(next);
      }
    }
  });

  it('keeps the follower row parallel to the leader row', () => {
    const l = leader();
    const m = normal();
    const row = reflectDir(l.little.clone().sub(l.index), m);
    expect(row.distanceTo(l.little.clone().sub(l.index))).toBeLessThan(1e-12);
  });

  it('refuses a degenerate frame and leaves the output alone', () => {
    const out = { wrist: v(1, 2, 3), hand: v(1, 0, 0), palm: v(0, 1, 0) };
    const flat = leader();
    flat.little.copy(flat.index);
    expect(placeFollower(flat, MEASURE, BETA, out)).toBe(false);
    const noReach = leader();
    noReach.middle.copy(noReach.wrist);
    expect(placeFollower(noReach, MEASURE, BETA, out)).toBe(false);
    expect(out.wrist.toArray()).toEqual([1, 2, 3]);
  });
});

describe('claspSpread', () => {
  it('fans the leader and offsets the follower by half a step, capped at the splay limit', () => {
    // 0.5 * 0.012 / 0.025 = 0.24 rad exceeds half of 25 degrees, so the cap acts.
    const step = SPLAY_CAP / 2;
    const lead = claspSpread(MEASURE, 'lead', {});
    expect(lead.thumb).toBe(0);
    expect(lead.index).toBeCloseTo(-1.5 * step, 12);
    expect(lead.middle).toBeCloseTo(-0.5 * step, 12);
    expect(lead.ring).toBeCloseTo(0.5 * step, 12);
    expect(lead.little).toBeCloseTo(1.5 * step, 12);

    const follow = claspSpread(MEASURE, 'follow', {});
    expect(follow.thumb).toBe(0);
    expect(follow.index).toBeCloseTo(-step, 12);
    expect(follow.middle).toBeCloseTo(0, 12);
    expect(follow.ring).toBeCloseTo(step, 12);
    expect(follow.little).toBeCloseTo(2 * step, 12);
    expect(Math.abs(lead.little ?? 0)).toBeLessThan(SPLAY_CAP);
  });

  it('follows the pitch to proximal ratio when it is under the cap', () => {
    const step = 0.5 * (0.006 / 0.025);
    const out = claspSpread({ pitch: 0.006, proximal: 0.025 }, 'lead', {});
    expect(out.ring).toBeCloseTo(0.5 * step, 12);
    expect(out.little).toBeCloseTo(1.5 * step, 12);
  });

  it('writes into and returns the object it was given', () => {
    const out = {};
    expect(claspSpread(MEASURE, 'lead', out)).toBe(out);
  });
});

describe('claspMeasure', () => {
  it('reads the side own keys', () => {
    expect(claspMeasure({ 'pitch.L': 0.012, 'proximal.L': 0.025 }, 'L')).toEqual(MEASURE);
  });

  it('is null when a key is absent or not positive', () => {
    expect(claspMeasure({ 'pitch.L': 0.012 }, 'L')).toBeNull();
    expect(claspMeasure({ 'pitch.L': 0.012, 'proximal.L': 0.025 }, 'R')).toBeNull();
    expect(claspMeasure({ 'pitch.L': 0, 'proximal.L': 0.025 }, 'L')).toBeNull();
    expect(claspMeasure({ 'pitch.L': 0.012, 'proximal.L': -1 }, 'L')).toBeNull();
  });
});
