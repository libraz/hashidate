import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MorphFrame } from '@/engine/face';
import type { Profile } from '@/engine/types';

function meshWith(count: number): THREE.Mesh {
  const mesh = new THREE.Mesh();
  mesh.morphTargetInfluences = new Array<number>(count).fill(0);
  return mesh;
}

function frameOver(shapes: Record<string, [THREE.Mesh, number][]>): MorphFrame {
  const morphTargets: Profile['morphTargets'] = new Map(
    Object.entries(shapes).map(([name, at]) => [
      name,
      at.map(([mesh, index]) => ({ mesh, index })),
    ]),
  );
  return new MorphFrame({ morphTargets });
}

describe('MorphFrame', () => {
  it('writes a shape onto every mesh that carries it, clamped to 1', () => {
    const a = meshWith(2);
    const b = meshWith(2);
    const frame = frameOver({
      blink: [
        [a, 0],
        [b, 1],
      ],
    });
    frame.begin();
    frame.set('blink', 1.5);
    frame.flush();
    expect(a.morphTargetInfluences).toEqual([1, 0]);
    expect(b.morphTargetInfluences).toEqual([0, 1]);
  });

  it('keeps the larger of two writes to the same shape', () => {
    const a = meshWith(1);
    const frame = frameOver({ smile: [[a, 0]] });
    frame.begin();
    frame.set('smile', 0.6);
    frame.set('smile', 0.2);
    frame.flush();
    expect(a.morphTargetInfluences?.[0]).toBe(0.6);
  });

  it('ignores empty and unknown names', () => {
    const a = meshWith(1);
    const frame = frameOver({ smile: [[a, 0]] });
    frame.begin();
    frame.set(null, 1);
    frame.set(undefined, 1);
    frame.set('', 1);
    frame.set('nothing', 1);
    frame.flush();
    expect(a.morphTargetInfluences).toEqual([0]);
  });

  it('clears exactly what it wrote last frame and leaves the rest alone', () => {
    const a = meshWith(3);
    const frame = frameOver({
      smile: [[a, 0]],
      blink: [[a, 1]],
    });
    // Index 2 belongs to another layer, e.g. an outfit-hide shape.
    a.morphTargetInfluences = [0, 0, 1];

    frame.begin();
    frame.set('smile', 0.5);
    frame.set('blink', 0.7);
    frame.flush();
    expect(a.morphTargetInfluences).toEqual([0.5, 0.7, 1]);

    frame.begin();
    frame.set('smile', 0.25);
    frame.flush();
    expect(a.morphTargetInfluences).toEqual([0.25, 0, 1]);

    frame.begin();
    frame.flush();
    expect(a.morphTargetInfluences).toEqual([0, 0, 1]);
  });
});
