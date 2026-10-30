import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  DoubleSide,
  InterleavedBufferAttribute,
  Material,
  type Matrix4,
  type Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  NormalBlending,
  type Object3D,
  ShadowMaterial,
  SkinnedMesh,
  type TypedArray,
} from 'three';
import { TriangleKernel } from './triangle-sort-core';

export interface TransparentTriangleTarget {
  key: string;
  mesh: Mesh;
}

export interface TransparentTriangleControllerOptions {
  /** Return a position-preserving clone whose vertex positions match mesh.getVertexPosition(); return null for unsupported vertex deformation. */
  cloneMaterial?: (source: Material) => Material | null;
}

export interface TransparentTriangleCounters {
  drawCalls: number;
  vertexEvaluations: number;
  sorts: number;
  indexUploads: number;
  materialClonesCreated: number;
  materialClonesDisposed: number;
  geometryShellsCreated: number;
  geometryShellsDisposed: number;
}

export interface TransparentTriangleTargetInspection {
  key: string;
  active: boolean;
  reason: string | null;
  triangleCount: number;
  referencedVertexCount: number;
  poseRevision: number;
}

export interface TransparentTriangleInspection {
  enabled: boolean;
  disposed: boolean;
  counters: TransparentTriangleCounters;
  targets: TransparentTriangleTargetInspection[];
}

type AttributeLike = BufferAttribute | InterleavedBufferAttribute;
type MorphAttributeMap = Record<string, AttributeLike[]>;

interface AttributeSnapshot {
  name: string;
  attribute: AttributeLike;
  array: TypedArray;
  version: number;
  count: number;
  itemSize: number;
  interleavedData: InterleavedBufferAttribute['data'] | null;
  interleavedVersion: number;
}

interface AttributeMapSnapshot {
  map: Record<string, AttributeLike>;
  entries: Map<string, AttributeSnapshot>;
}

interface MorphAttributeSnapshot {
  map: MorphAttributeMap;
  entries: Map<string, { attributes: AttributeLike[]; snapshots: AttributeSnapshot[] }>;
}

interface BoneSnapshot {
  bone: SkinnedMesh['skeleton']['bones'][number];
  worldMatrix: Matrix4;
  worldValues: Float64Array;
  inverseMatrix: Matrix4;
  inverseValues: Float64Array;
}

interface SkinSnapshot {
  skeleton: SkinnedMesh['skeleton'];
  bones: SkinnedMesh['skeleton']['bones'];
  inverses: SkinnedMesh['skeleton']['boneInverses'];
  bindMode: SkinnedMesh['bindMode'];
  bindMatrix: Matrix4;
  bindMatrixValues: Float64Array;
  bindMatrixInverse: Matrix4;
  bindMatrixInverseValues: Float64Array;
  boneSnapshots: BoneSnapshot[];
}

interface MaterialCloneEntry {
  source: Material;
  version: number;
  clone: Material | null;
  failure: string | null;
}

interface TargetRecord {
  key: string;
  mesh: Mesh;
  originalGeometry: BufferGeometry;
  reason: string | null;
  active: boolean;
  materialEntries: MaterialCloneEntry[];
  drawMaterial: Material | null;
  shell: BufferGeometry | null;
  shellIndex: BufferAttribute | null;
  shellMorphArrays: Map<string, AttributeLike[]>;
  shellSourceBoundingBox: BufferGeometry['boundingBox'] | undefined;
  shellSourceBoundingSphere: BufferGeometry['boundingSphere'] | undefined;
  sourceIndex: BufferAttribute | null;
  poseIndex: BufferAttribute | null;
  poseIndexArray: TypedArray | null;
  poseIndexVersion: number;
  poseIndexCount: number;
  kernel: TriangleKernel | null;
  appliedOrder: Uint32Array;
  appliedSourceIndex: BufferAttribute | null;
  appliedSourceIndexArray: TypedArray | null;
  appliedSourceVersion: number;
  poseDirty: boolean;
  poseRevision: number;
  attributeSnapshot: AttributeMapSnapshot | null;
  morphSnapshot: MorphAttributeSnapshot | null;
  morphInfluences: number[] | undefined;
  morphInfluenceValues: number[];
  morphTargetsRelative: boolean;
  skinSnapshot: SkinSnapshot | null;
  sortedCameraValues: Float64Array | null;
  sortedMeshValues: Float64Array | null;
  sortedPoseRevision: number;
  swapGeometry: BufferGeometry | null;
  swapMaterial: Material | Material[] | null;
  swapped: boolean;
}

const MAX_CACHED_MATERIALS_PER_TARGET = 2;

function isOwn(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}

function attributeArray(attribute: AttributeLike): TypedArray {
  if (attribute instanceof InterleavedBufferAttribute) return attribute.data.array;
  return attribute.array;
}

function attributeVersion(attribute: AttributeLike): number {
  if (attribute instanceof InterleavedBufferAttribute) return attribute.data.version;
  return attribute.version;
}

function attributeCount(attribute: AttributeLike): number {
  return attribute.count;
}

function attributeItemSize(attribute: AttributeLike): number {
  return attribute.itemSize;
}

function snapshotAttribute(name: string, attribute: AttributeLike): AttributeSnapshot {
  let interleavedData: InterleavedBufferAttribute['data'] | null = null;
  if (attribute instanceof InterleavedBufferAttribute) interleavedData = attribute.data;
  return {
    name,
    attribute,
    array: attributeArray(attribute),
    version: attributeVersion(attribute),
    count: attributeCount(attribute),
    itemSize: attributeItemSize(attribute),
    interleavedData,
    interleavedVersion: interleavedData?.version ?? -1,
  };
}

function snapshotAttributeMap(map: Record<string, AttributeLike>): AttributeMapSnapshot {
  const entries = new Map<string, AttributeSnapshot>();
  for (const name in map) {
    if (!isOwn(map, name)) continue;
    const attribute = map[name];
    if (attribute !== undefined) entries.set(name, snapshotAttribute(name, attribute));
  }
  return { map, entries };
}

function attributeMapMatches(
  map: Record<string, AttributeLike>,
  snapshot: AttributeMapSnapshot,
): boolean {
  if (map !== snapshot.map) return false;
  let count = 0;
  for (const name in map) {
    if (!isOwn(map, name)) continue;
    count += 1;
    const previous = snapshot.entries.get(name);
    const attribute = map[name];
    if (
      previous === undefined ||
      attribute !== previous.attribute ||
      attributeArray(attribute) !== previous.array ||
      attributeVersion(attribute) !== previous.version ||
      attributeCount(attribute) !== previous.count ||
      attributeItemSize(attribute) !== previous.itemSize
    ) {
      return false;
    }
    let data: InterleavedBufferAttribute['data'] | null = null;
    if (attribute instanceof InterleavedBufferAttribute) data = attribute.data;
    if (
      data !== previous.interleavedData ||
      (data?.version ?? -1) !== previous.interleavedVersion
    ) {
      return false;
    }
  }
  return count === snapshot.entries.size;
}

function snapshotMorphAttributes(map: MorphAttributeMap): MorphAttributeSnapshot {
  const entries = new Map<
    string,
    { attributes: AttributeLike[]; snapshots: AttributeSnapshot[] }
  >();
  for (const name in map) {
    if (!isOwn(map, name)) continue;
    const attributes = map[name];
    if (attributes === undefined) continue;
    entries.set(name, {
      attributes,
      snapshots: attributes.map((attribute, index) =>
        snapshotAttribute(`${name}:${index}`, attribute),
      ),
    });
  }
  return { map, entries };
}

function morphAttributesMatch(map: MorphAttributeMap, snapshot: MorphAttributeSnapshot): boolean {
  if (map !== snapshot.map) return false;
  let count = 0;
  for (const name in map) {
    if (!isOwn(map, name)) continue;
    count += 1;
    const previous = snapshot.entries.get(name);
    const attributes = map[name];
    if (previous === undefined || attributes !== previous.attributes) return false;
    if (attributes.length !== previous.snapshots.length) return false;
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes[index];
      const old = previous.snapshots[index];
      if (attribute === undefined || old === undefined) return false;
      let data: InterleavedBufferAttribute['data'] | null = null;
      let dataVersion = -1;
      if (attribute instanceof InterleavedBufferAttribute) {
        data = attribute.data;
        dataVersion = data.version;
      }
      if (
        attribute !== old.attribute ||
        attributeArray(attribute) !== old.array ||
        attributeVersion(attribute) !== old.version ||
        attributeCount(attribute) !== old.count ||
        attributeItemSize(attribute) !== old.itemSize ||
        data !== old.interleavedData ||
        dataVersion !== old.interleavedVersion
      )
        return false;
    }
  }
  return count === snapshot.entries.size;
}

function matrixValuesMatch(matrix: Matrix4, values: Float64Array): boolean {
  const elements = matrix.elements;
  if (elements.length !== values.length) return false;
  for (let index = 0; index < 16; index += 1) {
    if (elements[index] !== values[index]) return false;
  }
  return true;
}

function copyMatrixValues(matrix: Matrix4): Float64Array {
  return Float64Array.from(matrix.elements);
}

function createSkinSnapshot(mesh: SkinnedMesh): SkinSnapshot {
  const skeleton = mesh.skeleton;
  const boneSnapshots = skeleton.bones.map((bone, index) => {
    const inverseMatrix = skeleton.boneInverses[index];
    if (inverseMatrix === undefined)
      throw new Error('Skinned mesh skeleton has no matching inverse matrix.');
    return {
      bone,
      worldMatrix: bone.matrixWorld,
      worldValues: copyMatrixValues(bone.matrixWorld),
      inverseMatrix,
      inverseValues: copyMatrixValues(inverseMatrix),
    };
  });
  return {
    skeleton,
    bones: skeleton.bones,
    inverses: skeleton.boneInverses,
    bindMode: mesh.bindMode,
    bindMatrix: mesh.bindMatrix,
    bindMatrixValues: copyMatrixValues(mesh.bindMatrix),
    bindMatrixInverse: mesh.bindMatrixInverse,
    bindMatrixInverseValues: copyMatrixValues(mesh.bindMatrixInverse),
    boneSnapshots,
  };
}

function skinSnapshotMatches(mesh: Mesh, previous: SkinSnapshot | null): boolean {
  const isSkinned = mesh instanceof SkinnedMesh;
  if (!isSkinned) return previous === null;
  if (previous === null) return false;
  const skeleton = mesh.skeleton;
  if (
    skeleton !== previous.skeleton ||
    skeleton.bones !== previous.bones ||
    skeleton.boneInverses !== previous.inverses ||
    mesh.bindMode !== previous.bindMode ||
    mesh.bindMatrix !== previous.bindMatrix ||
    mesh.bindMatrixInverse !== previous.bindMatrixInverse ||
    !matrixValuesMatch(mesh.bindMatrix, previous.bindMatrixValues) ||
    !matrixValuesMatch(mesh.bindMatrixInverse, previous.bindMatrixInverseValues) ||
    skeleton.bones.length !== previous.boneSnapshots.length
  ) {
    return false;
  }
  for (let index = 0; index < skeleton.bones.length; index += 1) {
    const bone = skeleton.bones[index];
    const inverse = skeleton.boneInverses[index];
    const old = previous.boneSnapshots[index];
    if (
      bone === undefined ||
      inverse === undefined ||
      old === undefined ||
      bone !== old.bone ||
      inverse !== old.inverseMatrix ||
      bone.matrixWorld !== old.worldMatrix ||
      !matrixValuesMatch(bone.matrixWorld, old.worldValues) ||
      !matrixValuesMatch(inverse, old.inverseValues)
    ) {
      return false;
    }
  }
  return true;
}

function matricesMatch(left: Matrix4, right: Float64Array | null): boolean {
  if (right === null) return false;
  const elements = left.elements;
  for (let index = 0; index < 16; index += 1) {
    if (elements[index] !== right[index]) return false;
  }
  return true;
}

function createRecord(key: string, mesh: Mesh): TargetRecord {
  return {
    key,
    mesh,
    originalGeometry: mesh.geometry,
    reason: null,
    active: false,
    materialEntries: [],
    drawMaterial: null,
    shell: null,
    shellIndex: null,
    shellMorphArrays: new Map(),
    shellSourceBoundingBox: undefined,
    shellSourceBoundingSphere: undefined,
    sourceIndex: null,
    poseIndex: null,
    poseIndexArray: null,
    poseIndexVersion: -1,
    poseIndexCount: -1,
    kernel: null,
    appliedOrder: new Uint32Array(0),
    appliedSourceIndex: null,
    appliedSourceIndexArray: null,
    appliedSourceVersion: -1,
    poseDirty: true,
    poseRevision: 0,
    attributeSnapshot: null,
    morphSnapshot: null,
    morphInfluences: undefined,
    morphInfluenceValues: [],
    morphTargetsRelative: mesh.geometry.morphTargetsRelative,
    skinSnapshot: null,
    sortedCameraValues: null,
    sortedMeshValues: null,
    sortedPoseRevision: -1,
    swapGeometry: null,
    swapMaterial: null,
    swapped: false,
  };
}

function isSafeDefaultMaterial(source: Material): boolean {
  const materialConstructor = source.constructor;
  const standardConstructor =
    materialConstructor === MeshBasicMaterial ||
    materialConstructor === MeshDepthMaterial ||
    materialConstructor === MeshLambertMaterial ||
    materialConstructor === MeshMatcapMaterial ||
    materialConstructor === MeshNormalMaterial ||
    materialConstructor === MeshPhongMaterial ||
    materialConstructor === MeshPhysicalMaterial ||
    materialConstructor === MeshStandardMaterial ||
    materialConstructor === MeshToonMaterial ||
    materialConstructor === ShadowMaterial;
  if (!standardConstructor) return false;
  if (source.onBeforeRender !== Material.prototype.onBeforeRender) return false;
  if (source.onBeforeCompile !== Material.prototype.onBeforeCompile) return false;
  if (source.customProgramCacheKey !== Material.prototype.customProgramCacheKey) return false;
  return true;
}

function materialEligibilityReason(material: Material): string | null {
  const extended = material as Material & {
    alphaHash?: boolean;
    alphaToCoverage?: boolean;
    displacementMap?: { image?: unknown } | null;
    displacementScale?: number;
    transmission?: number;
  };
  if (material.transparent !== true) return 'not-transparent';
  if (material.blending !== NormalBlending) return 'non-standard-blending';
  if (material.side !== DoubleSide) return 'side-not-double-sided';
  if (material.depthTest !== true) return 'depth-test-disabled';
  if (material.depthWrite !== false) return 'depth-write-enabled';
  if (material.alphaTest !== 0) return 'alpha-test-enabled';
  if (extended.alphaHash === true) return 'alpha-hash-enabled';
  if (extended.alphaToCoverage === true) return 'alpha-to-coverage-enabled';
  if (extended.displacementMap != null && (extended.displacementScale ?? 1) !== 0) {
    return 'vertex-displacement-enabled';
  }
  if ((extended.transmission ?? 0) > 0) return 'transmission-enabled';
  return null;
}

function geometryEligibilityReason(mesh: Mesh): string | null {
  if ((mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh === true) {
    return 'instanced-mesh';
  }
  if (
    (mesh.geometry as BufferGeometry & { isInstancedBufferGeometry?: boolean })
      .isInstancedBufferGeometry
  ) {
    return 'instanced-geometry';
  }
  const geometry = mesh.geometry;
  if (!(geometry instanceof BufferGeometry)) return 'unsupported-geometry';
  const index = geometry.index;
  if (index === null) return 'not-indexed';
  if (!(index instanceof BufferAttribute)) return 'unsupported-index-attribute';
  if (index.itemSize !== 1) return 'unsupported-index-item-size';
  if (index.normalized) return 'normalized-index-attribute';
  if (
    !(
      index.array instanceof Uint8Array ||
      index.array instanceof Uint16Array ||
      index.array instanceof Uint32Array
    )
  ) {
    return 'unsupported-index-type';
  }
  if (index.count === 0 || index.count % 3 !== 0) return 'non-triangle-index-count';
  if (geometry.groups.length !== 0) return 'geometry-groups';
  if (
    geometry.drawRange.start !== 0 ||
    (geometry.drawRange.count !== Infinity && geometry.drawRange.count < index.count)
  ) {
    return 'partial-draw-range';
  }
  const position = geometry.getAttribute('position');
  if (position === undefined || position.count === 0 || position.itemSize < 3) {
    return 'missing-position-attribute';
  }
  return null;
}

function targetVisibilityReason(mesh: Mesh, camera: Camera): string | null {
  for (let object: Object3D | null = mesh; object !== null; object = object.parent) {
    if (!object.visible) {
      if (object === mesh) return 'hidden-mesh';
      return 'hidden-ancestor';
    }
  }
  if (!mesh.layers.test(camera.layers)) return 'camera-layer-mismatch';
  return null;
}

function clearPose(record: TargetRecord): void {
  record.sourceIndex = null;
  record.poseIndex = null;
  record.poseIndexArray = null;
  record.poseIndexVersion = -1;
  record.poseIndexCount = -1;
  record.kernel?.dispose();
  record.kernel = null;
  record.appliedOrder = new Uint32Array(0);
  record.appliedSourceIndex = null;
  record.appliedSourceIndexArray = null;
  record.appliedSourceVersion = -1;
  record.poseDirty = true;
  record.poseRevision = 0;
  record.attributeSnapshot = null;
  record.morphSnapshot = null;
  record.morphInfluences = undefined;
  record.morphInfluenceValues.length = 0;
  record.morphTargetsRelative = record.originalGeometry.morphTargetsRelative;
  record.skinSnapshot = null;
  record.sortedCameraValues = null;
  record.sortedMeshValues = null;
  record.sortedPoseRevision = -1;
}

function disposeMaterialEntry(
  entry: MaterialCloneEntry,
  counters: TransparentTriangleCounters,
): void {
  const clone = entry.clone;
  entry.clone = null;
  if (clone !== null) {
    counters.materialClonesDisposed += 1;
    clone.dispose();
  }
}

function clearClones(record: TargetRecord, counters: TransparentTriangleCounters): void {
  const entries = record.materialEntries.splice(0);
  record.drawMaterial = null;
  for (const entry of entries) disposeMaterialEntry(entry, counters);
}

function removeCloneForSource(
  record: TargetRecord,
  source: Material,
  counters: TransparentTriangleCounters,
): void {
  const index = record.materialEntries.findIndex((entry) => entry.source === source);
  if (index === -1) return;
  const [entry] = record.materialEntries.splice(index, 1);
  if (entry !== undefined) disposeMaterialEntry(entry, counters);
}

function detachAndDisposeShell(record: TargetRecord, counters: TransparentTriangleCounters): void {
  const shell = record.shell;
  record.shell = null;
  record.shellIndex = null;
  record.shellMorphArrays.clear();
  record.shellSourceBoundingBox = undefined;
  record.shellSourceBoundingSphere = undefined;
  if (shell === null) return;
  for (const name in shell.attributes) {
    if (isOwn(shell.attributes, name)) shell.deleteAttribute(name);
  }
  shell.morphAttributes = {};
  counters.geometryShellsDisposed += 1;
  shell.dispose();
  shell.setIndex(null);
}

function disposeShellIndexBuffer(shell: BufferGeometry): void {
  const borrowedAttributes = shell.attributes;
  const borrowedMorphAttributes = shell.morphAttributes;
  shell.attributes = {};
  shell.morphAttributes = {};
  shell.dispose();
  shell.setIndex(null);
  shell.attributes = borrowedAttributes;
  shell.morphAttributes = borrowedMorphAttributes;
}

function releaseOwnedResources(record: TargetRecord, counters: TransparentTriangleCounters): void {
  clearClones(record, counters);
  detachAndDisposeShell(record, counters);
  clearPose(record);
}

function ensureShell(record: TargetRecord, counters: TransparentTriangleCounters): void {
  if (record.shell !== null) return;
  const sourceGeometry = record.originalGeometry;
  const sourceIndex = sourceGeometry.index;
  if (sourceIndex === null) throw new Error('Cannot create a triangle shell without an index.');
  const shell = new BufferGeometry();
  for (const name in sourceGeometry.attributes) {
    if (isOwn(sourceGeometry.attributes, name)) {
      const attribute = sourceGeometry.attributes[name];
      if (attribute !== undefined) shell.setAttribute(name, attribute);
    }
  }
  shell.morphTargetsRelative = sourceGeometry.morphTargetsRelative;
  const sourceMorphAttributes = sourceGeometry.morphAttributes as unknown as MorphAttributeMap;
  const shellMorphAttributes = shell.morphAttributes as unknown as MorphAttributeMap;
  for (const name in sourceMorphAttributes) {
    if (!isOwn(sourceMorphAttributes, name)) continue;
    const attributes = sourceMorphAttributes[name];
    if (attributes === undefined) continue;
    shellMorphAttributes[name] = attributes;
    record.shellMorphArrays.set(name, attributes);
  }
  const indexAttribute = new BufferAttribute(sourceIndex.array.slice(), 1, sourceIndex.normalized);
  indexAttribute.setUsage(sourceIndex.usage);
  indexAttribute.gpuType = sourceIndex.gpuType;
  indexAttribute.name = sourceIndex.name;
  shell.setIndex(indexAttribute);
  shell.setDrawRange(0, sourceIndex.count);
  shell.boundingBox = sourceGeometry.boundingBox;
  shell.boundingSphere = sourceGeometry.boundingSphere;
  record.shellSourceBoundingBox = sourceGeometry.boundingBox;
  record.shellSourceBoundingSphere = sourceGeometry.boundingSphere;
  record.shell = shell;
  record.shellIndex = indexAttribute;
  record.sourceIndex = sourceIndex;
  record.appliedSourceIndex = sourceIndex;
  record.appliedSourceIndexArray = sourceIndex.array;
  record.appliedSourceVersion = sourceIndex.version;
  record.appliedOrder = Uint32Array.from(
    { length: sourceIndex.count / 3 },
    (_unused, face) => face,
  );
  counters.geometryShellsCreated += 1;
}

function syncBorrowedAttributes(record: TargetRecord): void {
  const shell = record.shell;
  const source = record.originalGeometry;
  if (shell === null) return;
  let sourceCount = 0;
  let differs = false;
  for (const name in source.attributes) {
    if (!isOwn(source.attributes, name)) continue;
    sourceCount += 1;
    const attribute = source.attributes[name];
    if (attribute !== undefined && shell.attributes[name] !== attribute) {
      shell.setAttribute(name, attribute);
      differs = true;
    }
  }
  let shellCount = 0;
  for (const name in shell.attributes) {
    if (!isOwn(shell.attributes, name)) continue;
    shellCount += 1;
    if (source.attributes[name] === undefined) {
      shell.deleteAttribute(name);
      differs = true;
    }
  }
  if (sourceCount !== shellCount) differs = true;
  if (record.shellSourceBoundingBox !== source.boundingBox) {
    shell.boundingBox = source.boundingBox;
    record.shellSourceBoundingBox = source.boundingBox;
  }
  if (record.shellSourceBoundingSphere !== source.boundingSphere) {
    shell.boundingSphere = source.boundingSphere;
    record.shellSourceBoundingSphere = source.boundingSphere;
  }
  if (shell.morphTargetsRelative !== source.morphTargetsRelative) {
    shell.morphTargetsRelative = source.morphTargetsRelative;
    differs = true;
  }

  let morphCount = 0;
  const sourceMorphAttributes = source.morphAttributes as unknown as MorphAttributeMap;
  const shellMorphAttributes = shell.morphAttributes as unknown as MorphAttributeMap;
  for (const name in sourceMorphAttributes) {
    if (!isOwn(sourceMorphAttributes, name)) continue;
    morphCount += 1;
    const attributes = sourceMorphAttributes[name];
    if (attributes === undefined) continue;
    if (record.shellMorphArrays.get(name) !== attributes) {
      shellMorphAttributes[name] = attributes;
      record.shellMorphArrays.set(name, attributes);
      differs = true;
    }
  }
  if (morphCount !== record.shellMorphArrays.size) differs = true;
  if (differs) {
    if (differs) {
      for (const name of record.shellMorphArrays.keys()) {
        if (sourceMorphAttributes[name] === undefined) {
          delete shellMorphAttributes[name];
          record.shellMorphArrays.delete(name);
        }
      }
    }
  }
  if (differs) shell.morphTargetsRelative = source.morphTargetsRelative;
}

function syncOwnedIndex(record: TargetRecord): boolean {
  const source = record.originalGeometry.index;
  const shell = record.shell;
  if (source === null || shell === null)
    throw new Error('Cannot update an incomplete triangle shell.');
  let replaced = false;
  if (
    record.shellIndex === null ||
    record.shellIndex.array.constructor !== source.array.constructor ||
    record.shellIndex.array.length !== source.array.length
  ) {
    const replacement = new BufferAttribute(source.array.slice(), 1, source.normalized);
    replacement.setUsage(source.usage);
    replacement.gpuType = source.gpuType;
    replacement.name = source.name;
    if (record.shellIndex !== null) disposeShellIndexBuffer(shell);
    shell.setIndex(replacement);
    record.shellIndex = replacement;
    record.sourceIndex = source;
    replaced = true;
  }
  record.sourceIndex = source;
  if (shell.drawRange.start !== 0 || shell.drawRange.count !== source.count) {
    shell.setDrawRange(0, source.count);
  }
  return replaced;
}

function poseDependenciesMatch(record: TargetRecord): boolean {
  const geometry = record.originalGeometry;
  const index = geometry.index;
  const attributeSnapshot = record.attributeSnapshot;
  const morphSnapshot = record.morphSnapshot;
  if (
    record.poseDirty ||
    index === null ||
    attributeSnapshot === null ||
    morphSnapshot === null ||
    record.poseIndex !== index ||
    record.poseIndexArray !== index.array ||
    record.poseIndexVersion !== index.version ||
    record.poseIndexCount !== index.count ||
    record.originalGeometry.morphTargetsRelative !== record.morphTargetsRelative ||
    !attributeMapMatches(geometry.attributes, attributeSnapshot) ||
    !morphAttributesMatch(geometry.morphAttributes as unknown as MorphAttributeMap, morphSnapshot)
  ) {
    return false;
  }
  const influences = record.mesh.morphTargetInfluences;
  if (influences !== record.morphInfluences) return false;
  const influenceCount = influences?.length ?? 0;
  if (influenceCount !== record.morphInfluenceValues.length) return false;
  for (let index = 0; index < influenceCount; index += 1) {
    if (influences![index] !== record.morphInfluenceValues[index]) return false;
  }
  return skinSnapshotMatches(record.mesh, record.skinSnapshot);
}

function markPoseDependencies(record: TargetRecord): void {
  const geometry = record.originalGeometry;
  const index = geometry.index!;
  record.attributeSnapshot = snapshotAttributeMap(geometry.attributes);
  record.morphSnapshot = snapshotMorphAttributes(
    geometry.morphAttributes as unknown as MorphAttributeMap,
  );
  record.poseIndex = index;
  record.poseIndexArray = index.array;
  record.poseIndexVersion = index.version;
  record.poseIndexCount = index.count;
  record.morphTargetsRelative = geometry.morphTargetsRelative;
  record.morphInfluences = record.mesh.morphTargetInfluences;
  record.morphInfluenceValues = record.morphInfluences?.slice() ?? [];
  if (record.mesh instanceof SkinnedMesh) {
    record.skinSnapshot = createSkinSnapshot(record.mesh);
  } else {
    record.skinSnapshot = null;
  }
  record.poseDirty = false;
}

function recordSort(
  record: TargetRecord,
  camera: Camera,
  counters: TransparentTriangleCounters,
): void {
  counters.sorts += 1;
  record.sortedCameraValues = copyMatrixValues(camera.matrixWorldInverse);
  record.sortedMeshValues = copyMatrixValues(record.mesh.matrixWorld);
  record.sortedPoseRevision = record.poseRevision;
}

/** Pose, measure and sort the target's vertices; the reason it could not, or null. */
function refreshPose(
  record: TargetRecord,
  camera: Camera,
  counters: TransparentTriangleCounters,
): string | null {
  record.kernel ??= new TriangleKernel(record.mesh);
  const kernel = record.kernel;
  const previousSource = kernel.sourceIndices;
  const reason = kernel.update(camera);
  if (kernel.sourceIndices !== previousSource) {
    record.appliedOrder = new Uint32Array(0);
    record.appliedSourceIndex = null;
    record.appliedSourceVersion = -1;
  }
  if (reason !== null && reason !== 'non-finite-depth') {
    record.poseDirty = true;
    return reason;
  }
  counters.vertexEvaluations += kernel.vertices.length;
  record.poseRevision += 1;
  markPoseDependencies(record);
  recordSort(record, camera, counters);
  return null;
}

function markIndexNeedsUpdate(record: TargetRecord, counters: TransparentTriangleCounters): void {
  record.shellIndex!.needsUpdate = true;
  counters.indexUploads += 1;
}

/** Re-sort for a moved camera or mesh, then write the shell index if the order changed. */
function applyOrder(
  record: TargetRecord,
  camera: Camera,
  counters: TransparentTriangleCounters,
): void {
  const kernel = record.kernel!;
  const matrixChanged = !(
    matricesMatch(camera.matrixWorldInverse, record.sortedCameraValues) &&
    matricesMatch(record.mesh.matrixWorld, record.sortedMeshValues)
  );
  if (matrixChanged || record.sortedPoseRevision !== record.poseRevision) {
    const reason = kernel.update(camera);
    if (reason !== null && reason !== 'non-finite-depth') throw new Error(reason);
    recordSort(record, camera, counters);
  }

  const order = kernel.order();
  let permutationChanged = record.appliedOrder.length !== order.length;
  if (!permutationChanged) {
    for (let index = 0; index < order.length; index += 1) {
      if (record.appliedOrder[index] !== order[index]) {
        permutationChanged = true;
        break;
      }
    }
  }
  const sourceIndex = record.originalGeometry.index!;
  const sourceIndexChanged =
    record.appliedSourceIndex !== sourceIndex ||
    record.appliedSourceIndexArray !== sourceIndex.array ||
    record.appliedSourceVersion !== sourceIndex.version;
  if (!(permutationChanged || sourceIndexChanged)) return;

  const output = record.shellIndex!.array;
  const sourceIndices = kernel.sourceIndices;
  let outputOffset = 0;
  let contentsChanged = false;
  for (const face of order) {
    const sourceOffset = face * 3;
    const index0 = sourceIndices[sourceOffset]!;
    const index1 = sourceIndices[sourceOffset + 1]!;
    const index2 = sourceIndices[sourceOffset + 2]!;
    if (
      output[outputOffset] !== index0 ||
      output[outputOffset + 1] !== index1 ||
      output[outputOffset + 2] !== index2
    ) {
      contentsChanged = true;
    }
    output[outputOffset] = index0;
    output[outputOffset + 1] = index1;
    output[outputOffset + 2] = index2;
    outputOffset += 3;
  }
  if (permutationChanged) record.appliedOrder = order.slice();
  record.appliedSourceIndex = sourceIndex;
  record.appliedSourceIndexArray = sourceIndex.array;
  record.appliedSourceVersion = sourceIndex.version;
  if (contentsChanged) markIndexNeedsUpdate(record, counters);
}

function createMaterialClone(
  source: Material,
  cloneMaterial: TransparentTriangleControllerOptions['cloneMaterial'],
): { clone: Material | null; reason: string | null } {
  if (!isSafeDefaultMaterial(source) && cloneMaterial === undefined) {
    return { clone: null, reason: 'custom-material-needs-clone-factory' };
  }
  try {
    let clone: Material | null;
    if (isSafeDefaultMaterial(source)) {
      clone = source.clone();
    } else if (cloneMaterial !== undefined) {
      clone = cloneMaterial(source);
    } else {
      return { clone: null, reason: 'custom-material-needs-clone-factory' };
    }
    if (clone === null) return { clone: null, reason: 'material-clone-rejected' };
    if (!(clone instanceof Material)) return { clone: null, reason: 'material-clone-invalid' };
    if (clone === source) return { clone: null, reason: 'material-clone-must-be-distinct' };
    clone.forceSinglePass = true;
    return { clone, reason: null };
  } catch {
    return { clone: null, reason: 'material-clone-failed' };
  }
}

function materialCloneEntry(
  record: TargetRecord,
  source: Material,
  cloneMaterial: TransparentTriangleControllerOptions['cloneMaterial'],
  counters: TransparentTriangleCounters,
): MaterialCloneEntry {
  const existingIndex = record.materialEntries.findIndex((entry) => entry.source === source);
  if (existingIndex !== -1) {
    const existing = record.materialEntries[existingIndex]!;
    if (existing.version === source.version) {
      if (existingIndex !== record.materialEntries.length - 1) {
        record.materialEntries.splice(existingIndex, 1);
        record.materialEntries.push(existing);
      }
      return existing;
    }
    record.materialEntries.splice(existingIndex, 1);
    disposeMaterialEntry(existing, counters);
  }

  const result = createMaterialClone(source, cloneMaterial);
  const entry: MaterialCloneEntry = {
    source,
    version: source.version,
    clone: result.clone,
    failure: result.reason,
  };
  if (result.clone !== null) counters.materialClonesCreated += 1;
  record.materialEntries.push(entry);
  if (record.materialEntries.length > MAX_CACHED_MATERIALS_PER_TARGET) {
    const evicted = record.materialEntries.shift();
    if (evicted !== undefined) disposeMaterialEntry(evicted, counters);
  }
  return entry;
}

export class TransparentTriangleController {
  private readonly cloneMaterial: TransparentTriangleControllerOptions['cloneMaterial'];
  private readonly records = new Map<string, TargetRecord>();
  private readonly recordList: TargetRecord[] = [];
  private readonly activeRecords: TargetRecord[] = [];
  private readonly counters: TransparentTriangleCounters = {
    drawCalls: 0,
    vertexEvaluations: 0,
    sorts: 0,
    indexUploads: 0,
    materialClonesCreated: 0,
    materialClonesDisposed: 0,
    geometryShellsCreated: 0,
    geometryShellsDisposed: 0,
  };
  private enabled = true;
  private disposed = false;
  private inDraw = false;

  constructor(options: TransparentTriangleControllerOptions = {}) {
    this.cloneMaterial = options.cloneMaterial;
  }

  reconcile(targets: readonly TransparentTriangleTarget[]): void {
    this.assertCanMutate();
    this.assertNotDisposed();
    const keys = new Set<string>();
    const meshes = new Set<Mesh>();
    for (const target of targets) {
      if (keys.has(target.key))
        throw new Error('TransparentTriangleController target keys must be unique.');
      if (meshes.has(target.mesh))
        throw new Error('TransparentTriangleController meshes must be unique.');
      keys.add(target.key);
      meshes.add(target.mesh);
    }

    const next = new Map<string, TargetRecord>();
    for (const target of targets) {
      const existing = this.records.get(target.key);
      if (existing !== undefined && existing.mesh === target.mesh) {
        if (existing.mesh.geometry !== existing.originalGeometry) {
          releaseOwnedResources(existing, this.counters);
          existing.originalGeometry = existing.mesh.geometry;
        }
        existing.active = false;
        existing.reason = null;
        next.set(target.key, existing);
      } else {
        next.set(target.key, createRecord(target.key, target.mesh));
      }
    }
    for (const [key, existing] of this.records) {
      if (next.get(key) !== existing) releaseOwnedResources(existing, this.counters);
    }
    this.records.clear();
    this.recordList.length = 0;
    for (const [key, record] of next) {
      this.records.set(key, record);
      this.recordList.push(record);
    }
  }

  setEnabled(enabled: boolean): void {
    this.assertCanMutate();
    this.assertNotDisposed();
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      for (const record of this.records.values()) {
        releaseOwnedResources(record, this.counters);
        record.active = false;
        record.reason = 'disabled';
      }
      return;
    }
    for (const record of this.records.values()) {
      record.active = false;
      record.reason = null;
      record.poseDirty = true;
    }
  }

  invalidateMaterials(): void {
    this.assertCanMutate();
    this.assertNotDisposed();
    for (const record of this.records.values()) clearClones(record, this.counters);
  }

  inspect(): TransparentTriangleInspection {
    const targets: TransparentTriangleTargetInspection[] = [];
    for (const record of this.records.values()) {
      const triangleCount = (record.kernel?.sourceIndices.length ?? 0) / 3;
      targets.push({
        key: record.key,
        active: record.active,
        reason: record.reason,
        triangleCount,
        referencedVertexCount: record.kernel?.vertices.length ?? 0,
        poseRevision: record.poseRevision,
      });
    }
    return {
      enabled: this.enabled,
      disposed: this.disposed,
      counters: { ...this.counters },
      targets,
    };
  }

  dispose(): void {
    this.assertCanMutate();
    if (this.disposed) return;
    for (const record of this.records.values()) releaseOwnedResources(record, this.counters);
    this.records.clear();
    this.recordList.length = 0;
    this.enabled = false;
    this.disposed = true;
  }

  withDraw<T>(camera: Camera, draw: () => T): T {
    this.assertNotDisposed();
    if (this.inDraw) {
      throw new Error('TransparentTriangleController does not allow nested withDraw calls.');
    }
    if (!this.enabled) return draw();

    this.inDraw = true;
    this.activeRecords.length = 0;
    this.counters.drawCalls += 1;
    try {
      for (let recordIndex = 0; recordIndex < this.recordList.length; recordIndex += 1) {
        const record = this.recordList[recordIndex]!;
        record.active = false;
        record.drawMaterial = null;
        if (record.mesh.geometry !== record.originalGeometry) {
          releaseOwnedResources(record, this.counters);
          record.originalGeometry = record.mesh.geometry;
        }
        const geometryReason = geometryEligibilityReason(record.mesh);
        if (geometryReason !== null) {
          releaseOwnedResources(record, this.counters);
          record.reason = geometryReason;
          continue;
        }
        if (Array.isArray(record.mesh.material)) {
          record.reason = 'multiple-materials';
          continue;
        }
        const sourceMaterial = record.mesh.material;
        if (!(sourceMaterial instanceof Material)) {
          record.reason = 'unsupported-material';
          continue;
        }
        const materialReason = materialEligibilityReason(sourceMaterial);
        if (materialReason !== null) {
          removeCloneForSource(record, sourceMaterial, this.counters);
          record.reason = materialReason;
          continue;
        }
        const visibilityReason = targetVisibilityReason(record.mesh, camera);
        if (visibilityReason !== null) {
          record.reason = visibilityReason;
          continue;
        }
        const entry = materialCloneEntry(record, sourceMaterial, this.cloneMaterial, this.counters);
        if (entry.clone === null) {
          record.reason = entry.failure ?? 'material-clone-failed';
          continue;
        }

        try {
          ensureShell(record, this.counters);
          syncBorrowedAttributes(record);
          const indexReplaced = syncOwnedIndex(record);
          if (!poseDependenciesMatch(record)) {
            record.poseDirty = true;
            const poseError = refreshPose(record, camera, this.counters);
            if (poseError !== null) {
              record.reason = poseError;
              continue;
            }
          }
          if (indexReplaced) {
            record.appliedOrder = new Uint32Array(0);
          }
          applyOrder(record, camera, this.counters);
          record.reason = null;
          record.active = true;
          record.drawMaterial = entry.clone;
          this.activeRecords.push(record);
        } catch {
          record.reason = 'geometry-update-failed';
        }
      }

      for (let index = 0; index < this.activeRecords.length; index += 1) {
        const record = this.activeRecords[index]!;
        record.swapGeometry = record.mesh.geometry;
        record.swapMaterial = record.mesh.material;
        record.swapped = true;
        record.mesh.geometry = record.shell!;
        record.mesh.material = record.drawMaterial!;
      }
      return draw();
    } finally {
      for (let index = this.activeRecords.length - 1; index >= 0; index -= 1) {
        const record = this.activeRecords[index]!;
        if (!record.swapped) continue;
        record.mesh.geometry = record.swapGeometry!;
        record.mesh.material = record.swapMaterial!;
        record.swapGeometry = null;
        record.swapMaterial = null;
        record.swapped = false;
        record.drawMaterial = null;
      }
      this.activeRecords.length = 0;
      this.inDraw = false;
    }
  }

  private assertCanMutate(): void {
    if (this.inDraw) {
      throw new Error(
        'TransparentTriangleController cannot change lifecycle state during withDraw.',
      );
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('TransparentTriangleController is disposed.');
  }
}
