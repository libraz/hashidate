import * as THREE from 'three';
import {
  GLTFLoader,
  type GLTFParser,
  type GLTFReference,
} from 'three/addons/loaders/GLTFLoader.js';
import type { TransparentTriangleTarget } from '@/engine/scene/transparent-triangles';
import { type EmbeddedTransparentTrianglePolicy, renderingSchema } from '@/protocol/rendering';

type ParserSource = Pick<GLTFParser, 'json' | 'associations'>;
type JsonRecord = Record<string, unknown>;
type AssociationSnapshot = Readonly<{
  root: THREE.Object3D;
  associations: ReadonlyMap<THREE.Object3D, Readonly<GLTFReference>>;
}>;

const defaultSceneSnapshots = new WeakMap<GLTFParser, AssociationSnapshot>();

function record(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function own(value: JsonRecord, key: string): boolean {
  return Object.hasOwn(value, key);
}

function embeddedPolicy(parser: ParserSource): EmbeddedTransparentTrianglePolicy | undefined {
  const json = record(parser.json);
  const asset = record(json?.asset);
  const extras = record(asset?.extras);
  const mimesis = record(extras?.mimesis);
  if (!(mimesis && own(mimesis, 'rendering'))) return undefined;
  return renderingSchema.parse(mimesis.rendering).transparentTriangles;
}

function copyDefaultSceneAssociations(
  parser: GLTFParser,
  root: THREE.Object3D,
): AssociationSnapshot {
  const objects = new Set<THREE.Object3D>();
  root.traverse((object) => objects.add(object));

  const associations = new Map<THREE.Object3D, Readonly<GLTFReference>>();
  for (const [object, source] of parser.associations) {
    if (!(object instanceof THREE.Object3D && objects.has(object))) continue;
    const association: GLTFReference = {};
    if (typeof source.nodes === 'number') association.nodes = source.nodes;
    if (typeof source.meshes === 'number') association.meshes = source.meshes;
    if (typeof source.primitives === 'number') association.primitives = source.primitives;
    associations.set(object, Object.freeze(association));
  }
  return { root, associations };
}

/** Create the production loader that preserves exact default-scene provenance. */
export function createAvatarLoader(): GLTFLoader {
  return new GLTFLoader().register((parser) => ({
    name: 'mimesis-transparent-triangle-default-scene-associations',
    beforeRoot: async () => {
      const policy = embeddedPolicy(parser);
      if (!policy || policy.targets.length === 0) return;

      const sceneIndex = parser.json.scene ?? 0;
      const scenes = parser.json.scenes;
      if (
        !Number.isSafeInteger(sceneIndex) ||
        sceneIndex < 0 ||
        !Array.isArray(scenes) ||
        sceneIndex >= scenes.length ||
        record(scenes[sceneIndex]) === undefined
      ) {
        throw new Error(`Transparent triangle default scene index ${sceneIndex} is invalid.`);
      }

      const root = await parser.getDependency('scene', sceneIndex);
      if (!(root instanceof THREE.Object3D)) {
        throw new Error(
          `Transparent triangle default scene index ${sceneIndex} has no object root.`,
        );
      }
      defaultSceneSnapshots.set(parser, copyDefaultSceneAssociations(parser, root));
    },
  }));
}

function sourceMeshIndex(json: unknown, nodeIndex: number, primitiveIndex: number): number | null {
  const root = record(json);
  const nodes = root?.nodes;
  const meshes = root?.meshes;
  if (!(Array.isArray(nodes) && Array.isArray(meshes))) return null;
  const node = record(nodes[nodeIndex]);
  if (typeof node?.mesh !== 'number' || !Number.isSafeInteger(node.mesh)) return null;
  const mesh = record(meshes[node.mesh]);
  if (!Array.isArray(mesh?.primitives)) return null;
  const primitive = record(mesh.primitives[primitiveIndex]);
  if (!primitive || (primitive.mode !== undefined && primitive.mode !== 4)) return null;
  return node.mesh;
}

/** Resolve only original GLTFLoader mesh associations for explicitly named primitives. */
export function resolveTransparentTriangleTargets(
  root: THREE.Object3D,
  parser?: ParserSource,
): TransparentTriangleTarget[] {
  if (!parser) return [];
  const policy = embeddedPolicy(parser);
  if (policy === undefined) return [];
  if (policy.targets.length === 0) return [];

  const snapshot = defaultSceneSnapshots.get(parser as GLTFParser);
  if (snapshot !== undefined && snapshot.root !== root) {
    throw new Error(
      'Transparent triangle root does not match its captured default scene provenance.',
    );
  }
  const associations =
    snapshot?.associations ??
    (parser.associations as ReadonlyMap<THREE.Object3D, Readonly<GLTFReference>>);

  const sceneObjects = new Set<THREE.Object3D>();
  root.traverse((object) => sceneObjects.add(object));
  const nodes = new Map<number, THREE.Object3D>();
  for (const [object, association] of associations) {
    if (
      !(object instanceof THREE.Object3D && sceneObjects.has(object)) ||
      association.nodes === undefined
    )
      continue;
    if (Object.hasOwn(object.userData, 'sourcePartVariantId')) continue;
    if (nodes.has(association.nodes))
      throw new Error(`Transparent triangle node association ${association.nodes} is ambiguous.`);
    nodes.set(association.nodes, object);
  }

  return policy.targets.map(({ nodeIndex, primitiveIndex }) => {
    const meshIndex = sourceMeshIndex(parser.json, nodeIndex, primitiveIndex);
    if (meshIndex === null)
      throw new Error(
        `Transparent triangle target node ${nodeIndex} primitive ${primitiveIndex} is not a TRIANGLES primitive.`,
      );

    const node = nodes.get(nodeIndex);
    if (!node)
      throw new Error(
        `Transparent triangle target node ${nodeIndex} primitive ${primitiveIndex} has no original mesh association in the default scene.`,
      );

    const matches: THREE.Mesh[] = [];
    const visit = (object: THREE.Object3D): void => {
      if (object !== node) {
        const association = associations.get(object);
        if (association?.nodes !== undefined && association.nodes !== nodeIndex) return;
      }
      if (object instanceof THREE.Mesh && !Object.hasOwn(object.userData, 'sourcePartVariantId')) {
        const association = associations.get(object);
        if (association?.meshes === meshIndex && association.primitives === primitiveIndex)
          matches.push(object);
      }
      for (const child of object.children) visit(child);
    };
    visit(node);

    if (matches.length !== 1)
      throw new Error(
        `Transparent triangle target node ${nodeIndex} primitive ${primitiveIndex} resolved to ${matches.length} original meshes.`,
      );
    return {
      key: `node:${nodeIndex}:primitive:${primitiveIndex}`,
      mesh: matches[0]!,
    };
  });
}
