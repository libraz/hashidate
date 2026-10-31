import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { core } from '@/core';
import { SceneGraph } from '@/core/scene';
import { Director } from '@/engine/director';
import type { Rig } from '@/engine/rig';
import { CoreRig } from '@/engine/rig/core';
import { TransparentTriangleController } from '@/engine/scene/transparent-triangles';
import type { Profile } from '@/engine/types';
import { DIRECTOR_FIXTURES, prepareFixture, splitmix64 } from '../helpers/director-fixtures';
import { must } from '../helpers/must';
import { applyTriangleFrame, TRIANGLE_FIXTURES } from '../helpers/triangle-fixtures';

const ROUNDS = 100;
const SLOT_MASK = 0xffff;

const byteLength = () => core().memory.buffer.byteLength;

/** A director on a synthetic avatar with one sway group, and the graph it made. */
function mountDirector(rig?: (profile: Profile) => Rig) {
  const { root, profile } = prepareFixture(must(DIRECTOR_FIXTURES[0], 'fixture'));
  const director = new Director(profile, undefined, { random: splitmix64(), rig });
  const graph = must(SceneGraph.existing(root), 'graph');
  return { root, director, graph };
}

/** A transparent-triangle controller that has sorted one frame, so its kernel exists. */
function mountTriangles() {
  const rig = must(TRIANGLE_FIXTURES[2], 'triangle fixture').build();
  const controller = new TransparentTriangleController(rig.root);
  controller.reconcile([{ key: 'mesh', mesh: rig.mesh }]);
  const camera = new THREE.PerspectiveCamera();
  const frame = must(must(TRIANGLE_FIXTURES[2], 'triangle fixture').script[0], 'frame');
  applyTriangleFrame(rig, camera, frame);
  controller.withDraw(camera, () => undefined);
  return { root: rig.root, controller };
}

describe('scene graph lifetime', () => {
  it('returns the memory it took: 100 mounts and disposals do not grow it past the first', () => {
    const round = () => {
      const a = mountDirector();
      a.root.updateMatrixWorld(true);
      a.director.spring.update(1 / 60);
      const t = mountTriangles();
      // The order disposeAvatar uses.
      a.director.dispose();
      t.controller.dispose();
      must(SceneGraph.existing(t.root), 'triangle graph').dispose();
      a.graph.dispose();
    };
    round();
    const afterFirst = byteLength();
    for (let i = 0; i < ROUNDS - 1; i++) round();
    expect(byteLength()).toBe(afterFirst);
  });

  it('returns the memory a core rig took: 100 directors on it do not grow it past the first', () => {
    const rig = (p: Profile) => new CoreRig(p) as unknown as Rig;
    const round = () => {
      const a = mountDirector(rig);
      a.director.update(1 / 60);
      a.root.updateMatrixWorld(true);
      a.director.dispose();
      a.graph.dispose();
    };
    round();
    const afterFirst = byteLength();
    for (let i = 0; i < ROUNDS - 1; i++) round();
    expect(byteLength()).toBe(afterFirst);
  });

  it('disposes through existing() only when a graph was built', () => {
    const { root, director, graph } = mountDirector();
    expect(SceneGraph.existing(new THREE.Group())).toBeUndefined();
    director.dispose();
    graph.dispose();
    expect(SceneGraph.existing(root)).toBeUndefined();
    director.dispose();
  });

  it('frees a dependent after its graph without touching the slot that replaced it', () => {
    const { root, director, graph } = mountDirector();
    const dead = graph.handle;
    // What the finaliser does when the root is collected before its dependents.
    core().hd_scene_free_orphan(dead);
    expect(() => director.dispose()).not.toThrow();
    // The finaliser is still registered for `graph`; keeping it reachable keeps it from firing
    // on a handle that is already free.
    pinned.push(root, graph);
  });

  it('frees the graph of a root dropped without dispose, whether or not dependents survive', async () => {
    const gc = collector();
    if (gc === null) {
      // Without a collector the registry's callback cannot be provoked.
      return;
    }
    const slot = (h: number) => h & SLOT_MASK;
    const generation = (h: number) => h >>> 16;

    const orphan = (() => {
      const m = mountDirector();
      const t = mountTriangles();
      void t.controller;
      return { handle: m.graph.handle, tri: SceneGraph.existing(t.root)?.handle ?? 0 };
    })();

    for (let i = 0; i < 10; i++) {
      gc();
      await new Promise((r) => setTimeout(r, 0));
    }

    // A freed slot is handed out again under the next generation; allocate until it is.
    const probes: SceneGraph[] = [];
    const reused = new Set<number>();
    for (let i = 0; i <= slot(Math.max(orphan.handle, orphan.tri)) + 1; i++) {
      const probe = SceneGraph.of(new THREE.Group());
      probes.push(probe);
      reused.add(probe.handle);
    }
    for (const probe of probes) probe.dispose();
    for (const old of [orphan.handle, orphan.tri]) {
      expect(reused.has(((generation(old) + 1) << 16) | slot(old))).toBe(true);
    }
  });

  it('frees a dropped spring and kernel while their graph lives on', async () => {
    const gc = collector();
    if (gc === null) return;
    const roots = (() => {
      const a = mountDirector();
      const t = mountTriangles();
      return [a.root, t.root];
    })();
    for (let i = 0; i < 10; i++) {
      gc();
      await new Promise((r) => setTimeout(r, 0));
    }
    // The core traps on freeing a graph that something still depends on.
    for (const root of roots)
      expect(() => must(SceneGraph.existing(root), 'graph').dispose()).not.toThrow();
  });
});

/** Roots and graphs kept reachable on purpose. */
const pinned: unknown[] = [];

/** A forced full collection, or null when V8 will not expose one. */
function collector(): (() => void) | null {
  try {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as unknown;
    return typeof gc === 'function' ? (gc as () => void) : null;
  } catch {
    return null;
  }
}
