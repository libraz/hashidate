// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { linenMaterial } from '@/viewer/scene/backdrop/finishes';
import type { TextureBin } from '@/viewer/scene/backdrop/textures';

describe('fabric images within one bin', () => {
  it('share one decoded image and keep their own repeat', () => {
    const bin: TextureBin = [];
    const a = linenMaterial(bin, 0xffffff, { width: 0.5, height: 1 });
    const b = linenMaterial(bin, 0xffffff, { width: 2, height: 2 });

    expect(a.map).not.toBe(b.map);
    expect(a.map?.source).toBe(b.map?.source);
    expect(a.normalMap?.source).toBe(b.normalMap?.source);
    expect(a.map?.source).not.toBe(a.normalMap?.source);
    expect(a.map?.repeat.x).not.toBe(b.map?.repeat.x);
    // Three loaded originals' worth of sources plus one clone per request.
    expect(new Set(bin.map((t) => t.source)).size).toBe(3);
  });

  it('does not share across bins, so a room releases only its own', () => {
    const a = linenMaterial([], 0xffffff, { width: 1, height: 1 });
    const b = linenMaterial([], 0xffffff, { width: 1, height: 1 });
    expect(a.map?.source).not.toBe(b.map?.source);
  });
});
