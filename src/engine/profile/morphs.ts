/**
 * Shape-key discovery.
 *
 * Where a shape name lands (which mesh, which index), which meshes carry the
 * face, and how the author's own shape list is grouped.
 */

import * as THREE from 'three';
import type { MorphTarget } from '../types';
import { isExpressionShape } from './candidates';

/** Everything the morph pass found on one scene. */
export interface MorphRouting {
  /** Shape name → every place it lands. */
  morphTargets: Map<string, MorphTarget[]>;
  faceMeshes: THREE.Mesh[];
  /** Flat name → index view. A report, not a route. */
  dict: Record<string, number>;
}

/**
 * Morph routing.
 *
 * One shape name may live on several meshes — the engine design calls for the
 * profile to hold (mesh, index) pairs rather than a single face mesh, and
 * picking "the mesh with the most morphs" is actively wrong: the body carries
 * one outfit-hide shape per region, which can easily outnumber the face's
 * expression shapes and steal the role.
 */
export function routeMorphs(root: THREE.Object3D): MorphRouting {
  const morphTargets = new Map<string, MorphTarget[]>(); // shape name -> [{ mesh, index }]
  const faceMeshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const d = o.morphTargetDictionary;
    if (!d) return;
    let expressive = false;
    for (const [name, index] of Object.entries(d)) {
      let list = morphTargets.get(name);
      if (!list) {
        list = [];
        morphTargets.set(name, list);
      }
      list.push({ mesh: o, index });
      if (isExpressionShape(name)) expressive = true;
    }
    if (expressive) faceMeshes.push(o);
  });

  // Flat name -> index view, kept for the HUD and for hand-editing a profile.
  // Resolution goes through morphTargets; this is a report, not a route.
  const dict: Record<string, number> = {};
  for (const [name, list] of morphTargets) dict[name] = list[0].index;

  return { morphTargets, faceMeshes, dict };
}

export function readGroups(root: THREE.Object3D, separator: RegExp): Map<string, string[]> {
  const groups = new Map<string, string[]>(); // label -> shape names, in authored order
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const d = o.morphTargetDictionary;
    if (!d) return;
    // A shape belongs to the last separator above it, so the authored order has
    // to be rebuilt from the indices rather than read off the dictionary.
    const ordered = Object.entries(d).sort((a, b) => a[1] - b[1]);
    let label: string | null = null;
    for (const [name] of ordered) {
      const m = name.match(separator);
      if (m) {
        label = m[1];
        if (!groups.has(label)) groups.set(label, []);
      } else if (label) {
        // The face arrives split across several meshes, each carrying the whole
        // shape list, so the same name shows up once per split.
        const list = groups.get(label);
        if (list && !list.includes(name)) list.push(name);
      }
    }
  });
  return groups;
}
