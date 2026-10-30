import { z } from 'zod';

const transparentTriangleTargetSchema = z.strictObject({
  nodeIndex: z.number().int().nonnegative().safe(),
  primitiveIndex: z.number().int().nonnegative().safe(),
  category: z.enum(['clothing', 'accessory']),
});

function compareTargets(
  left: z.output<typeof transparentTriangleTargetSchema>,
  right: z.output<typeof transparentTriangleTargetSchema>,
): number {
  if (left.nodeIndex !== right.nodeIndex) return left.nodeIndex - right.nodeIndex;
  return left.primitiveIndex - right.primitiveIndex;
}

/** Exact source primitives an embedded Mimesis rendering hint may sort. */
export const transparentTrianglesSchema = z
  .strictObject({
    method: z.literal('camera-depth@1'),
    targets: z.array(transparentTriangleTargetSchema).max(128),
  })
  .superRefine((policy, context) => {
    for (let index = 1; index < policy.targets.length; index += 1) {
      if (compareTargets(policy.targets[index - 1]!, policy.targets[index]!) >= 0) {
        context.addIssue({
          code: 'custom',
          path: ['targets', index],
          message: 'Transparent triangle targets must be sorted and unique.',
        });
      }
    }
  });

/** Optional schema subtree consumed from glTF asset extras; other profile fields stay opaque. */
export const renderingSchema = z
  .object({ transparentTriangles: transparentTrianglesSchema.optional() })
  .passthrough();

export type EmbeddedTransparentTrianglePolicy = z.output<typeof transparentTrianglesSchema>;
export type EmbeddedTransparentTriangleTarget =
  EmbeddedTransparentTrianglePolicy['targets'][number];
