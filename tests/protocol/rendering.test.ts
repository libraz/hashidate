import { describe, expect, it } from 'vitest';
import { renderingSchema, transparentTrianglesSchema } from '@/protocol/rendering';

describe('embedded transparent triangle policy', () => {
  it('accepts sorted exact clothing and accessory primitive targets up to the limit', () => {
    const targets = Array.from({ length: 128 }, (_, nodeIndex) => ({
      nodeIndex,
      primitiveIndex: 0,
      category: nodeIndex % 2 === 0 ? ('clothing' as const) : ('accessory' as const),
    }));
    expect(transparentTrianglesSchema.parse({ method: 'camera-depth@1', targets }).targets).toEqual(
      targets,
    );
  });

  it('rejects unsupported categories, invalid indices, duplicates, and targets over the limit', () => {
    for (const target of [
      { nodeIndex: 0, primitiveIndex: 0, category: 'body' },
      { nodeIndex: -1, primitiveIndex: 0, category: 'clothing' },
      { nodeIndex: 0, primitiveIndex: 1.5, category: 'clothing' },
    ]) {
      expect(
        transparentTrianglesSchema.safeParse({ method: 'camera-depth@1', targets: [target] })
          .success,
      ).toBe(false);
    }

    expect(
      transparentTrianglesSchema.safeParse({
        method: 'camera-depth@1',
        targets: [
          { nodeIndex: 1, primitiveIndex: 0, category: 'clothing' },
          { nodeIndex: 0, primitiveIndex: 0, category: 'accessory' },
        ],
      }).success,
    ).toBe(false);
    expect(
      transparentTrianglesSchema.safeParse({
        method: 'camera-depth@1',
        targets: [
          { nodeIndex: 0, primitiveIndex: 0, category: 'clothing' },
          { nodeIndex: 0, primitiveIndex: 0, category: 'accessory' },
        ],
      }).success,
    ).toBe(false);
    expect(
      transparentTrianglesSchema.safeParse({
        method: 'camera-depth@1',
        targets: Array.from({ length: 129 }, (_, nodeIndex) => ({
          nodeIndex,
          primitiveIndex: 0,
          category: 'clothing',
        })),
      }).success,
    ).toBe(false);
  });

  it('keeps the embedded policy subtree strict', () => {
    expect(
      transparentTrianglesSchema.safeParse({
        method: 'camera-depth@1',
        targets: [],
        nodeIndex: 0,
      }).success,
    ).toBe(false);
  });

  it('validates only its optional rendering subtree and leaves unrelated extras opaque', () => {
    const policy = { method: 'camera-depth@1', targets: [] } as const;
    expect(
      renderingSchema.parse({ transparentTriangles: policy, futureRenderingOption: { value: 1 } }),
    ).toMatchObject({ transparentTriangles: policy, futureRenderingOption: { value: 1 } });
    expect(renderingSchema.parse({ unrelatedPhysics: { value: 1 } }).transparentTriangles).toBe(
      undefined,
    );
  });
});
