import * as THREE from 'three';
import { WebGLAttributes } from 'three/src/renderers/webgl/WebGLAttributes.js';
import { WebGLGeometries } from 'three/src/renderers/webgl/WebGLGeometries.js';
import { describe, expect, it } from 'vitest';
import { TransparentTriangleController } from '../../src/engine/scene/transparent-triangles';

function transparentMaterial() {
  return new THREE.MeshStandardMaterial({
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
  });
}

function triangleGeometry(depths: readonly number[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  for (const [face, depth] of depths.entries()) {
    const offset = face * 3;
    positions.push(
      -0.4 + face * 0.03,
      -0.3,
      depth,
      0.4 + face * 0.02,
      -0.2,
      depth,
      -0.1,
      0.4 + face * 0.01,
      depth,
    );
    indices.push(offset, offset + 1, offset + 2);
    for (let vertex = 0; vertex < 3; vertex += 1) {
      skinIndices.push(0, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  return geometry;
}

function skinnedTarget(depths: readonly number[], morphDepthDelta = 0) {
  const geometry = triangleGeometry(depths);
  if (morphDepthDelta !== 0) {
    const deltas = new Float32Array(geometry.getAttribute('position').count * 3);
    deltas[2] = morphDepthDelta;
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(deltas, 3)];
    geometry.morphTargetsRelative = true;
  }
  const material = transparentMaterial();
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  if (morphDepthDelta !== 0) mesh.morphTargetInfluences = [0];
  return { geometry, material, mesh, bone };
}

function updateWorld(...objects: THREE.Object3D[]) {
  for (const object of objects) object.updateMatrixWorld(true);
}

function withIndexOrder(
  controller: TransparentTriangleController,
  camera: THREE.Camera,
  mesh: THREE.Mesh,
) {
  let index: number[] = [];
  const returned = controller.withDraw(camera, () => {
    index = Array.from(mesh.geometry.index!.array);
    return 'drawn';
  });
  expect(returned).toBe('drawn');
  return index;
}

function faceOrder(index: readonly number[]) {
  const order: number[] = [];
  for (let offset = 0; offset < index.length; offset += 3) {
    order.push(Math.floor((index[offset] ?? 0) / 3));
  }
  return order;
}

function trackedWebGLResources() {
  const createdBuffers: object[] = [];
  const deletedBuffers: object[] = [];
  const gl = {
    ARRAY_BUFFER: 34962,
    ELEMENT_ARRAY_BUFFER: 34963,
    FLOAT: 5126,
    HALF_FLOAT: 5131,
    UNSIGNED_BYTE: 5121,
    UNSIGNED_SHORT: 5123,
    UNSIGNED_INT: 5125,
    BYTE: 5120,
    SHORT: 5122,
    INT: 5124,
    createBuffer: () => {
      const buffer = { id: createdBuffers.length + 1 };
      createdBuffers.push(buffer);
      return buffer;
    },
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    bufferSubData: () => undefined,
    deleteBuffer: (buffer: object) => deletedBuffers.push(buffer),
  } as unknown as WebGLRenderingContext;
  const attributes = new WebGLAttributes(gl);
  const info = { memory: { geometries: 0 } };
  const createGeometries = WebGLGeometries as unknown as (
    context: WebGLRenderingContext,
    webglAttributes: WebGLAttributes,
    webglInfo: typeof info,
    bindingStates: { releaseStatesOfGeometry: (geometry: THREE.BufferGeometry) => void },
  ) => {
    get: (object: THREE.Object3D, geometry: THREE.BufferGeometry) => THREE.BufferGeometry;
    update: (geometry: THREE.BufferGeometry) => void;
  };
  const geometries = createGeometries(gl, attributes, info, {
    releaseStatesOfGeometry: () => undefined,
  });
  return { attributes, geometries, gl, createdBuffers, deletedBuffers };
}

function cameraAt(z: number, type: 'perspective' | 'orthographic' = 'perspective') {
  const camera =
    type === 'perspective'
      ? new THREE.PerspectiveCamera(45, 1, 0.1, 100)
      : new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 100);
  camera.position.z = z;
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('TransparentTriangleController', () => {
  it('interleaves four skinned sleeve layers by current camera depth and preserves each face', () => {
    const { geometry, material, mesh } = skinnedTarget([-1, -5, -2, -4]);
    const camera = cameraAt(10);
    const originalIndex = geometry.index;
    const originalIndexValues = Array.from(originalIndex!.array);
    const controller = new TransparentTriangleController(mesh);
    controller.reconcile([{ key: 'sleeve', mesh }]);

    const sorted = withIndexOrder(controller, camera, mesh);
    expect(faceOrder(sorted)).toEqual([1, 3, 2, 0]);
    expect(sorted).toEqual([3, 4, 5, 9, 10, 11, 6, 7, 8, 0, 1, 2]);
    expect(geometry.index).toBe(originalIndex);
    expect(Array.from(geometry.index!.array)).toEqual(originalIndexValues);
    expect(mesh.material).toBe(material);

    const counters = controller.inspect().counters;
    expect(counters.vertexEvaluations).toBe(12);
    expect(counters.sorts).toBe(1);
    expect(counters.indexUploads).toBe(1);
    controller.dispose();
  });

  it('uses camera-space depth for perspective and orthographic views, and keeps ordinal ties stable', () => {
    for (const type of ['perspective', 'orthographic'] as const) {
      const { mesh } = skinnedTarget([-3, -3, -1, -5]);
      const controller = new TransparentTriangleController(mesh);
      controller.reconcile([{ key: type, mesh }]);

      expect(faceOrder(withIndexOrder(controller, cameraAt(10, type), mesh))).toEqual([3, 0, 1, 2]);
      expect(faceOrder(withIndexOrder(controller, cameraAt(-10, type), mesh))).toEqual([
        2, 0, 1, 3,
      ]);
      expect(controller.inspect().counters.vertexEvaluations).toBe(12);
      expect(controller.inspect().counters.sorts).toBe(2);
      controller.dispose();
    }
  });

  it('reuses posed centroids for camera changes and skips all work on an identical frame', () => {
    const { mesh } = skinnedTarget([-1, -5, -2, -4]);
    const controller = new TransparentTriangleController(mesh);
    controller.reconcile([{ key: 'sleeve', mesh }]);
    const firstCamera = cameraAt(10);
    const reverseCamera = cameraAt(-10);

    withIndexOrder(controller, firstCamera, mesh);
    const first = controller.inspect().counters;
    withIndexOrder(controller, firstCamera, mesh);
    const repeated = controller.inspect().counters;
    expect(repeated.vertexEvaluations).toBe(first.vertexEvaluations);
    expect(repeated.sorts).toBe(first.sorts);
    expect(repeated.indexUploads).toBe(first.indexUploads);

    expect(faceOrder(withIndexOrder(controller, reverseCamera, mesh))).toEqual([0, 2, 3, 1]);
    const cameraChanged = controller.inspect().counters;
    expect(cameraChanged.vertexEvaluations).toBe(12);
    expect(cameraChanged.sorts).toBe(2);
    expect(cameraChanged.indexUploads).toBe(2);
    controller.dispose();
  });

  it('refreshes pose for morph-only and bone-only changes without camera movement', () => {
    const { mesh, bone } = skinnedTarget([-1, -5, -2, -4], -12);
    const camera = cameraAt(10);
    const controller = new TransparentTriangleController(mesh);
    controller.reconcile([{ key: 'sleeve', mesh }]);
    withIndexOrder(controller, camera, mesh);

    mesh.morphTargetInfluences![0] = 1;
    expect(faceOrder(withIndexOrder(controller, camera, mesh))).toEqual([0, 1, 3, 2]);
    expect(controller.inspect().counters.vertexEvaluations).toBe(24);
    expect(controller.inspect().counters.sorts).toBe(2);

    bone.position.z = -5;
    updateWorld(mesh);
    withIndexOrder(controller, camera, mesh);
    expect(controller.inspect().counters.vertexEvaluations).toBe(36);
    expect(controller.inspect().counters.sorts).toBe(3);
    controller.dispose();
  });

  it('tracks interleaved buffer versions and index attribute identity', () => {
    const { geometry, mesh } = skinnedTarget([-1, -5]);
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    const interleavedData = new THREE.InterleavedBuffer(positions.array.slice(), 3);
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(interleavedData, 3, 0));
    const controller = new TransparentTriangleController(mesh);
    const camera = cameraAt(10);
    controller.reconcile([{ key: 'interleaved', mesh }]);

    withIndexOrder(controller, camera, mesh);
    expect(controller.inspect().counters.vertexEvaluations).toBe(6);
    interleavedData.array[2] += 5;
    interleavedData.needsUpdate = true;
    withIndexOrder(controller, camera, mesh);
    expect(controller.inspect().counters.vertexEvaluations).toBe(12);
    expect(controller.inspect().counters.sorts).toBe(2);

    const previousIndex = geometry.index;
    if (previousIndex === null) throw new Error('Test fixture must have an index.');
    geometry.setIndex(new THREE.BufferAttribute(previousIndex.array, 1));
    withIndexOrder(controller, camera, mesh);
    expect(geometry.index).not.toBe(previousIndex);
    expect(controller.inspect().counters.vertexEvaluations).toBe(18);
    expect(controller.inspect().counters.sorts).toBe(3);
    expect(controller.inspect().counters.indexUploads).toBe(1);
    controller.dispose();
  });

  it('shares source attributes safely with an unselected mesh and restores references after errors', () => {
    const { geometry, material, mesh } = skinnedTarget([-1, -5, -2, -4]);
    const unselected = new THREE.Mesh(geometry, material);
    const camera = cameraAt(10);
    const sourcePosition = geometry.getAttribute('position');
    const sourceMorph = geometry.morphAttributes.position;
    const sourceIndex = geometry.index;
    const controller = new TransparentTriangleController(mesh);
    controller.reconcile([{ key: 'selected', mesh }]);

    let shell: THREE.BufferGeometry | undefined;
    let clone: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      shell = mesh.geometry;
      clone = mesh.material as THREE.Material;
      expect(shell).not.toBe(geometry);
      expect(shell.getAttribute('position')).toBe(sourcePosition);
      expect(shell.morphAttributes.position).toBe(sourceMorph);
      expect(clone).not.toBe(material);
      expect(clone.forceSinglePass).toBe(true);
      expect(unselected.geometry).toBe(geometry);
      expect(unselected.material).toBe(material);
    });
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    expect(geometry.index).toBe(sourceIndex);

    expect(() =>
      controller.withDraw(camera, () => {
        expect(mesh.geometry).toBe(shell);
        throw new Error('draw failed');
      }),
    ).toThrow('draw failed');
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    controller.dispose();
  });

  it('releases uploaded owned index buffers while retaining uploaded borrowed buffers', () => {
    const { attributes, geometries, gl, createdBuffers, deletedBuffers } = trackedWebGLResources();
    const { geometry, mesh } = skinnedTarget([-1, -5, -2, -4]);
    const sourcePosition = geometry.getAttribute('position');
    attributes.update(sourcePosition, gl.ARRAY_BUFFER);
    const controller = new TransparentTriangleController(mesh);
    const camera = cameraAt(10);
    controller.reconcile([{ key: 'gpu-index', mesh }]);
    const ownedIndices: THREE.BufferAttribute[] = [];
    const registerAndUpload = () => {
      controller.withDraw(camera, () => {
        const shell = mesh.geometry;
        geometries.get(mesh, shell);
        geometries.update(shell);
        const index = shell.index;
        if (index === null) throw new Error('The temporary shell must have an owned index.');
        attributes.update(index, gl.ELEMENT_ARRAY_BUFFER);
        ownedIndices.push(index);
      });
    };

    registerAndUpload();
    expect(createdBuffers).toHaveLength(4);
    const firstIndex = ownedIndices[0];
    if (firstIndex === undefined) throw new Error('The first owned index upload was not recorded.');
    const firstIndexBuffer = attributes.get(firstIndex)?.buffer;
    expect(firstIndexBuffer).toBeDefined();
    expect(attributes.get(sourcePosition)).toBeDefined();

    const deletesBeforeDisable = deletedBuffers.length;
    controller.setEnabled(false);
    expect(attributes.get(firstIndex)).toBeUndefined();
    expect(attributes.get(sourcePosition)).toBeDefined();
    expect(deletedBuffers.length - deletesBeforeDisable).toBe(1);
    expect(deletedBuffers).toContain(firstIndexBuffer);

    controller.setEnabled(true);
    registerAndUpload();
    const replaceableIndex = ownedIndices[1];
    if (replaceableIndex === undefined)
      throw new Error('The replacement test index was not recorded.');
    const replaceableBuffer = attributes.get(replaceableIndex)?.buffer;
    expect(replaceableBuffer).toBeDefined();
    geometry.setIndex(new THREE.Uint32BufferAttribute([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 1));

    const deletesBeforeIndexReplacement = deletedBuffers.length;
    registerAndUpload();
    const replacementIndex = ownedIndices[2];
    if (replacementIndex === undefined) throw new Error('The updated index was not recorded.');
    const replacementBuffer = attributes.get(replacementIndex)?.buffer;
    expect(replacementBuffer).toBeDefined();
    expect(replacementIndex).not.toBe(replaceableIndex);
    expect(attributes.get(replaceableIndex)).toBeUndefined();
    expect(deletedBuffers.length - deletesBeforeIndexReplacement).toBe(1);
    expect(deletedBuffers).toContain(replaceableBuffer);

    const deletesBeforeDispose = deletedBuffers.length;
    controller.dispose();
    expect(attributes.get(replacementIndex)).toBeUndefined();
    expect(attributes.get(sourcePosition)).toBeDefined();
    for (const attribute of Object.values(geometry.attributes)) {
      if (attribute !== undefined) expect(attributes.get(attribute)).toBeDefined();
    }
    expect(deletedBuffers.length - deletesBeforeDispose).toBe(1);
    expect(deletedBuffers).toContain(replacementBuffer);
    expect(createdBuffers).toHaveLength(6);
    expect(deletedBuffers).toHaveLength(3);

    const controlGeometry = triangleGeometry([-2]);
    const controlMesh = new THREE.Mesh(controlGeometry, transparentMaterial());
    const controlIndex = controlGeometry.index;
    if (controlIndex === null) throw new Error('The control geometry must be indexed.');
    geometries.get(controlMesh, controlGeometry);
    geometries.update(controlGeometry);
    attributes.update(controlIndex, gl.ELEMENT_ARRAY_BUFFER);
    const controlBuffer = attributes.get(controlIndex)?.buffer;
    expect(controlBuffer).toBeDefined();
    expect(createdBuffers).toHaveLength(10);
    controlGeometry.dispose();
    expect(attributes.get(controlIndex)).toBeUndefined();
    expect(deletedBuffers).toContain(controlBuffer);
    expect(deletedBuffers).toHaveLength(7);
  });

  it('restores source references immediately when the draw callback returns a promise', () => {
    const { geometry, material, mesh } = skinnedTarget([-1, -5]);
    const controller = new TransparentTriangleController(mesh);
    controller.reconcile([{ key: 'async-callback', mesh }]);
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const returned = controller.withDraw(cameraAt(10), () => {
      expect(mesh.geometry).not.toBe(geometry);
      return pending;
    });

    expect(returned).toBe(pending);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    resolve();
    controller.dispose();
  });

  it('releases borrowed attributes before disposing shells across off, on, replacement, and removal', () => {
    const first = skinnedTarget([-1, -5, -2, -4]);
    const second = skinnedTarget([-2, -6]);
    const camera = cameraAt(10);
    let sourcePositionDisposals = 0;
    let sourceMorphDisposals = 0;
    let sourceTextureDisposals = 0;
    (first.geometry.getAttribute('position') as THREE.BufferAttribute).addEventListener(
      'dispose',
      () => {
        sourcePositionDisposals += 1;
      },
    );
    const morph = new THREE.Float32BufferAttribute(new Float32Array(36), 3);
    first.geometry.morphAttributes.position = [morph];
    first.mesh.morphTargetInfluences = [0];
    morph.addEventListener('dispose', () => {
      sourceMorphDisposals += 1;
    });
    const texture = new THREE.Texture();
    first.material.map = texture;
    texture.addEventListener('dispose', () => {
      sourceTextureDisposals += 1;
    });

    const root = new THREE.Group().add(first.mesh, second.mesh);
    const controller = new TransparentTriangleController(root);
    controller.reconcile([{ key: 'sleeve', mesh: first.mesh }]);
    withIndexOrder(controller, camera, first.mesh);
    let oldShell: THREE.BufferGeometry | undefined;
    controller.withDraw(camera, () => {
      oldShell = first.mesh.geometry;
    });

    controller.setEnabled(false);
    const disposedShell = oldShell;
    expect(disposedShell).toBeDefined();
    expect(disposedShell?.index).toBeNull();
    expect(Object.keys(disposedShell?.attributes ?? {})).toHaveLength(0);
    expect(disposedShell?.morphAttributes).toEqual({});
    expect(controller.inspect().counters.geometryShellsDisposed).toBe(1);
    expect(controller.inspect().counters.materialClonesDisposed).toBe(1);
    withIndexOrder(controller, camera, first.mesh);
    expect(first.mesh.geometry).toBe(first.geometry);

    controller.setEnabled(true);
    withIndexOrder(controller, camera, first.mesh);
    let replacementShell: THREE.BufferGeometry | undefined;
    controller.withDraw(camera, () => {
      replacementShell = first.mesh.geometry;
    });
    expect(replacementShell).not.toBe(oldShell);

    const replacementGeometry = triangleGeometry([-3, -1, -5]);
    first.mesh.geometry = replacementGeometry;
    withIndexOrder(controller, camera, first.mesh);
    let geometryReplacementShell: THREE.BufferGeometry | undefined;
    controller.withDraw(camera, () => {
      geometryReplacementShell = first.mesh.geometry;
    });
    expect(replacementShell?.index).toBeNull();
    expect(geometryReplacementShell).not.toBe(replacementShell);

    controller.reconcile([{ key: 'sleeve', mesh: second.mesh }]);
    expect(geometryReplacementShell?.index).toBeNull();
    expect(controller.inspect().counters.geometryShellsDisposed).toBe(3);
    expect(controller.inspect().counters.materialClonesDisposed).toBe(3);
    expect(sourcePositionDisposals).toBe(0);
    expect(sourceMorphDisposals).toBe(0);
    expect(sourceTextureDisposals).toBe(0);
    controller.dispose();
  });

  it('skips hidden and camera-layer targets, then refreshes before a shown draw', () => {
    const { mesh, geometry: sourceGeometry } = skinnedTarget([-1, -5], -12);
    const parent = new THREE.Group();
    parent.add(mesh);
    const camera = cameraAt(10);
    const controller = new TransparentTriangleController(parent);
    controller.reconcile([{ key: 'hidden', mesh }]);

    controller.withDraw(camera, () => {
      expect(mesh.geometry).not.toBe(sourceGeometry);
    });
    expect(controller.inspect().counters.vertexEvaluations).toBe(6);
    expect(controller.inspect().counters.sorts).toBe(1);

    parent.visible = false;
    mesh.morphTargetInfluences![0] = 1;
    controller.withDraw(camera, () => {
      expect(mesh.geometry).toBe(sourceGeometry);
    });
    expect(controller.inspect().targets[0]?.reason).toBe('hidden-ancestor');
    expect(controller.inspect().counters.vertexEvaluations).toBe(6);
    expect(controller.inspect().counters.sorts).toBe(1);

    parent.visible = true;
    mesh.layers.set(2);
    controller.withDraw(camera, () => {
      expect(mesh.geometry).toBe(sourceGeometry);
    });
    expect(controller.inspect().targets[0]?.reason).toBe('camera-layer-mismatch');
    expect(controller.inspect().counters.vertexEvaluations).toBe(6);
    expect(controller.inspect().counters.sorts).toBe(1);

    mesh.layers.set(0);
    let shownOrder: number[] = [];
    controller.withDraw(camera, () => {
      expect(mesh.geometry).not.toBe(sourceGeometry);
      shownOrder = Array.from(mesh.geometry.index!.array);
    });
    expect(faceOrder(shownOrder)).toEqual([0, 1]);
    expect(controller.inspect().counters.vertexEvaluations).toBe(12);
    expect(controller.inspect().counters.sorts).toBe(2);
    controller.dispose();
  });

  it('reports invalid eligibility without modifying source meshes', () => {
    const cases: Array<{ reason: string; mutate: (mesh: THREE.Mesh) => void }> = [
      { reason: 'instanced-mesh', mutate: () => undefined },
      { reason: 'not-indexed', mutate: (mesh) => mesh.geometry.setIndex(null) },
      { reason: 'partial-draw-range', mutate: (mesh) => mesh.geometry.setDrawRange(0, 0) },
      { reason: 'geometry-groups', mutate: (mesh) => mesh.geometry.addGroup(0, 3, 0) },
      {
        reason: 'not-transparent',
        mutate: (mesh) => ((mesh.material as THREE.Material).transparent = false),
      },
      {
        reason: 'side-not-double-sided',
        mutate: (mesh) => ((mesh.material as THREE.Material).side = THREE.FrontSide),
      },
      {
        reason: 'depth-write-enabled',
        mutate: (mesh) => ((mesh.material as THREE.Material).depthWrite = true),
      },
      {
        reason: 'depth-test-disabled',
        mutate: (mesh) => ((mesh.material as THREE.Material).depthTest = false),
      },
      {
        reason: 'alpha-test-enabled',
        mutate: (mesh) => ((mesh.material as THREE.Material).alphaTest = 0.1),
      },
      {
        reason: 'alpha-hash-enabled',
        mutate: (mesh) =>
          ((mesh.material as THREE.Material & { alphaHash: boolean }).alphaHash = true),
      },
      {
        reason: 'alpha-to-coverage-enabled',
        mutate: (mesh) =>
          ((mesh.material as THREE.Material & { alphaToCoverage: boolean }).alphaToCoverage = true),
      },
      {
        reason: 'non-standard-blending',
        mutate: (mesh) => ((mesh.material as THREE.Material).blending = THREE.AdditiveBlending),
      },
      {
        reason: 'transmission-enabled',
        mutate: (mesh) => ((mesh.material as THREE.MeshPhysicalMaterial).transmission = 0.5),
      },
      {
        reason: 'vertex-displacement-enabled',
        mutate: (mesh) =>
          ((mesh.material as THREE.MeshStandardMaterial).displacementMap = new THREE.Texture()),
      },
      {
        reason: 'multiple-materials',
        mutate: (mesh) => (mesh.material = [mesh.material as THREE.Material]),
      },
    ];
    const camera = cameraAt(10);

    for (const [index, item] of cases.entries()) {
      const { mesh: fixtureMesh, geometry, material } = skinnedTarget([-1]);
      let mesh: THREE.Mesh = fixtureMesh;
      if (item.reason === 'instanced-mesh') {
        mesh = new THREE.InstancedMesh(geometry, material, 1);
      } else if (item.reason === 'transmission-enabled') {
        const physical = new THREE.MeshPhysicalMaterial({
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        mesh.material = physical;
      }
      item.mutate(mesh);
      const sourceMaterial = mesh.material;
      const controller = new TransparentTriangleController(mesh);
      controller.reconcile([{ key: `invalid-${index}`, mesh }]);
      controller.withDraw(camera, () => {
        expect(mesh.geometry).toBe(geometry);
        expect(mesh.material).toBe(sourceMaterial);
      });
      expect(controller.inspect().targets[0]?.reason).toBe(item.reason);
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.material).toBe(sourceMaterial);
      expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
      controller.dispose();
    }
  });

  it('requires a consumer-safe factory for custom shaders and disposes only owned materials', () => {
    const { geometry, mesh: standardMesh } = skinnedTarget([-1, -5]);
    const mesh = standardMesh as THREE.SkinnedMesh<THREE.BufferGeometry, THREE.Material>;
    const texture = new THREE.Texture();
    const custom = new THREE.ShaderMaterial({
      uniforms: { sourceMap: { value: texture } },
      vertexShader:
        'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader:
        'uniform sampler2D sourceMap; void main() { gl_FragColor = texture2D(sourceMap, vec2(0.0)); }',
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    mesh.material = custom;
    const camera = cameraAt(10);
    let textureDisposals = 0;
    texture.addEventListener('dispose', () => {
      textureDisposals += 1;
    });

    const unsupported = new TransparentTriangleController(mesh);
    unsupported.reconcile([{ key: 'custom', mesh }]);
    unsupported.withDraw(camera, () => {
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.material).toBe(custom);
    });
    expect(unsupported.inspect().targets[0]?.reason).toBe('custom-material-needs-clone-factory');
    unsupported.dispose();

    let cloneDisposals = 0;
    const controller = new TransparentTriangleController(mesh, {
      cloneMaterial: (source) => {
        const shader = source as THREE.ShaderMaterial;
        const clone = new THREE.ShaderMaterial().copy(shader);
        clone.uniforms = Object.fromEntries(
          Object.entries(shader.uniforms).map(([name, uniform]) => [name, { ...uniform }]),
        );
        clone.addEventListener('dispose', () => {
          cloneDisposals += 1;
        });
        return clone;
      },
    });
    controller.reconcile([{ key: 'custom', mesh }]);
    controller.withDraw(camera, () => {
      const activeMaterial = mesh.material as THREE.Material;
      expect(activeMaterial).not.toBe(custom);
      expect(activeMaterial.forceSinglePass).toBe(true);
      expect((activeMaterial as THREE.ShaderMaterial).uniforms.sourceMap.value).toBe(texture);
      expect(mesh.geometry.getAttribute('position')).toBe(geometry.getAttribute('position'));
    });
    expect(mesh.material).toBe(custom);
    controller.dispose();
    expect(cloneDisposals).toBe(1);
    expect(textureDisposals).toBe(0);
  });

  it('refreshes its material clone on source version changes and explicit invalidation', () => {
    const { material, mesh } = skinnedTarget([-1, -5]);
    const controller = new TransparentTriangleController(mesh);
    const camera = cameraAt(10);
    controller.reconcile([{ key: 'versioned', mesh }]);
    let firstClone: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      firstClone = mesh.material as THREE.Material;
    });

    material.needsUpdate = true;
    let secondClone: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      secondClone = mesh.material as THREE.Material;
    });
    expect(secondClone).not.toBe(firstClone);

    mesh.material = transparentMaterial();
    let identityClone: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      identityClone = mesh.material as THREE.Material;
    });
    expect(identityClone).not.toBe(secondClone);

    controller.invalidateMaterials();
    let thirdClone: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      thirdClone = mesh.material as THREE.Material;
    });
    expect(thirdClone).not.toBe(secondClone);
    expect(thirdClone).not.toBe(identityClone);
    expect(controller.inspect().counters.materialClonesCreated).toBe(4);
    expect(controller.inspect().counters.materialClonesDisposed).toBe(3);
    controller.dispose();
  });

  it('keeps two source material clones in a per-target LRU', () => {
    const { mesh: target } = skinnedTarget([-1, -5]);
    const mesh = target as THREE.SkinnedMesh<
      THREE.BufferGeometry,
      THREE.Material | THREE.Material[]
    >;
    const first = mesh.material as THREE.Material;
    const second = transparentMaterial();
    const third = transparentMaterial();
    const disposed = new Map<THREE.Material, number>();
    const tracked = new Set<THREE.Material>();
    const controller = new TransparentTriangleController(mesh);
    const camera = cameraAt(10);
    controller.reconcile([{ key: 'material-lru', mesh }]);
    const drawMaterial = () => {
      let clone: THREE.Material | undefined;
      controller.withDraw(camera, () => {
        clone = mesh.material as THREE.Material;
      });
      if (!tracked.has(clone!)) {
        tracked.add(clone!);
        clone!.addEventListener('dispose', () => {
          disposed.set(clone!, (disposed.get(clone!) ?? 0) + 1);
        });
      }
      return clone!;
    };

    const firstClone = drawMaterial();
    mesh.material = second;
    const secondClone = drawMaterial();
    mesh.material = first;
    expect(drawMaterial()).toBe(firstClone);
    mesh.material = third;
    const thirdClone = drawMaterial();
    expect(disposed.get(secondClone)).toBe(1);
    expect(disposed.get(firstClone)).toBeUndefined();
    expect(disposed.get(thirdClone)).toBeUndefined();
    expect(controller.inspect().counters.materialClonesCreated).toBe(3);
    expect(controller.inspect().counters.materialClonesDisposed).toBe(1);

    mesh.material = first;
    expect(drawMaterial()).toBe(firstClone);
    mesh.material = second;
    const replacementSecondClone = drawMaterial();
    expect(replacementSecondClone).not.toBe(secondClone);
    expect(disposed.get(thirdClone)).toBe(1);
    controller.dispose();
    expect(disposed.get(firstClone)).toBe(1);
    expect(disposed.get(replacementSecondClone)).toBe(1);
    expect(controller.inspect().counters.materialClonesDisposed).toBe(4);
    first.dispose();
    second.dispose();
    third.dispose();
  });

  it('replaces only the changed source version and preserves the other material entry', () => {
    const { mesh: target } = skinnedTarget([-1, -5]);
    const mesh = target as THREE.SkinnedMesh<
      THREE.BufferGeometry,
      THREE.Material | THREE.Material[]
    >;
    const first = mesh.material as THREE.Material;
    const second = transparentMaterial();
    const controller = new TransparentTriangleController(mesh);
    const camera = cameraAt(10);
    controller.reconcile([{ key: 'material-version', mesh }]);
    const drawMaterial = () => {
      let clone: THREE.Material | undefined;
      controller.withDraw(camera, () => {
        clone = mesh.material as THREE.Material;
      });
      return clone!;
    };

    const firstClone = drawMaterial();
    mesh.material = second;
    const secondClone = drawMaterial();
    first.needsUpdate = true;
    mesh.material = first;
    const updatedFirstClone = drawMaterial();
    expect(updatedFirstClone).not.toBe(firstClone);
    mesh.material = second;
    expect(drawMaterial()).toBe(secondClone);
    expect(controller.inspect().counters.materialClonesCreated).toBe(3);
    expect(controller.inspect().counters.materialClonesDisposed).toBe(1);
    controller.dispose();
    expect(controller.inspect().counters.materialClonesDisposed).toBe(3);
    first.dispose();
    second.dispose();
  });

  it('keeps cached clones and pose data when the opposite material is ineligible', () => {
    const { geometry, mesh: target } = skinnedTarget([-1, -5]);
    const mesh = target as THREE.SkinnedMesh<
      THREE.BufferGeometry,
      THREE.Material | THREE.Material[]
    >;
    const first = mesh.material as THREE.Material;
    const second = transparentMaterial();
    const controller = new TransparentTriangleController(mesh);
    const camera = cameraAt(10);
    controller.reconcile([{ key: 'material-ineligible', mesh }]);
    let firstClone: THREE.Material | undefined;
    let firstShell: THREE.BufferGeometry | undefined;
    controller.withDraw(camera, () => {
      firstClone = mesh.material as THREE.Material;
      firstShell = mesh.geometry;
    });
    mesh.material = second;
    let secondClone: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      secondClone = mesh.material as THREE.Material;
    });
    let secondCloneDisposals = 0;
    secondClone!.addEventListener('dispose', () => {
      secondCloneDisposals += 1;
    });
    const before = controller.inspect();
    second.transparent = false;
    controller.withDraw(camera, () => {
      expect(mesh.geometry).toBe(geometry);
    });
    const ineligible = controller.inspect();
    expect(ineligible.targets[0]?.reason).toBe('not-transparent');
    expect(ineligible.counters.geometryShellsDisposed).toBe(0);
    expect(ineligible.counters.materialClonesDisposed).toBe(1);
    expect(secondCloneDisposals).toBe(1);
    expect(ineligible.counters.vertexEvaluations).toBe(before.counters.vertexEvaluations);
    expect(ineligible.targets[0]?.poseRevision).toBe(before.targets[0]?.poseRevision);

    mesh.material = first;
    let reusedClone: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      reusedClone = mesh.material as THREE.Material;
      expect(mesh.geometry).toBe(firstShell);
    });
    expect(reusedClone).toBe(firstClone);
    controller.dispose();
    expect(controller.inspect().counters.materialClonesDisposed).toBe(2);
    first.dispose();
    second.dispose();
  });

  it('disposes every cached clone exactly once across off, geometry replacement, removal, and dispose', () => {
    const { geometry, mesh: target } = skinnedTarget([-1, -5]);
    const mesh = target as THREE.SkinnedMesh<
      THREE.BufferGeometry,
      THREE.Material | THREE.Material[]
    >;
    const first = mesh.material as THREE.Material;
    const second = transparentMaterial();
    const allClones: THREE.Material[] = [];
    const disposalCounts = new Map<THREE.Material, number>();
    const controller = new TransparentTriangleController(mesh);
    const camera = cameraAt(10);
    controller.reconcile([{ key: 'material-cleanup', mesh }]);
    const draw = () =>
      controller.withDraw(camera, () => {
        const clone = mesh.material as THREE.Material;
        if (!allClones.includes(clone)) {
          allClones.push(clone);
          clone.addEventListener('dispose', () => {
            disposalCounts.set(clone, (disposalCounts.get(clone) ?? 0) + 1);
          });
        }
      });

    draw();
    mesh.material = second;
    draw();
    expect(allClones).toHaveLength(2);
    controller.setEnabled(false);
    expect(allClones.map((clone) => disposalCounts.get(clone))).toEqual([1, 1]);

    controller.setEnabled(true);
    mesh.material = first;
    draw();
    const replacementGeometry = triangleGeometry([-2, -6]);
    mesh.geometry = replacementGeometry;
    draw();
    expect(disposalCounts.get(allClones[2]!)).toBe(1);
    mesh.material = second;
    draw();
    controller.reconcile([]);
    expect(allClones.map((clone) => disposalCounts.get(clone))).toEqual([1, 1, 1, 1, 1]);

    controller.reconcile([{ key: 'material-cleanup', mesh }]);
    draw();
    const finalClone = allClones.at(-1)!;
    controller.dispose();
    controller.dispose();
    expect(disposalCounts.get(finalClone)).toBe(1);
    expect(controller.inspect().counters.materialClonesDisposed).toBe(allClones.length);
    first.dispose();
    second.dispose();
    geometry.dispose();
    replacementGeometry.dispose();
  });

  it('caches a rejected custom factory result by source identity and version', () => {
    const { mesh: target } = skinnedTarget([-1, -5]);
    const mesh = target as THREE.SkinnedMesh<
      THREE.BufferGeometry,
      THREE.Material | THREE.Material[]
    >;
    const first = mesh.material as THREE.Material;
    const source = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    let factoryCalls = 0;
    const controller = new TransparentTriangleController(mesh, {
      cloneMaterial: () => {
        factoryCalls += 1;
        return null;
      },
    });
    controller.reconcile([{ key: 'negative-cache', mesh }]);
    const camera = cameraAt(10);
    let firstClone: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      firstClone = mesh.material as THREE.Material;
    });
    let rejectedCloneDisposals = 0;
    firstClone!.addEventListener('dispose', () => {
      rejectedCloneDisposals += 1;
    });
    mesh.material = source;
    controller.withDraw(camera, () => undefined);
    controller.withDraw(camera, () => undefined);
    expect(factoryCalls).toBe(1);
    expect(controller.inspect().targets[0]?.reason).toBe('material-clone-rejected');

    mesh.material = [source, first];
    controller.withDraw(camera, () => undefined);
    expect(controller.inspect().targets[0]?.reason).toBe('multiple-materials');
    mesh.material = first;
    let reusedClone: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      reusedClone = mesh.material as THREE.Material;
    });
    expect(reusedClone).toBe(firstClone);
    expect(rejectedCloneDisposals).toBe(0);
    mesh.material = source;
    controller.withDraw(camera, () => undefined);
    expect(factoryCalls).toBe(1);
    source.needsUpdate = true;
    controller.withDraw(camera, () => undefined);
    expect(factoryCalls).toBe(2);
    expect(controller.inspect().counters.materialClonesCreated).toBe(1);
    expect(controller.inspect().counters.materialClonesDisposed).toBe(0);
    controller.dispose();
    expect(rejectedCloneDisposals).toBe(1);
    source.dispose();
    first.dispose();
  });

  it('requires a factory for standard materials with custom shader hooks and preserves hook state', () => {
    const { geometry, mesh } = skinnedTarget([-1, -5]);
    const source = mesh.material as THREE.MeshStandardMaterial;
    const sourceHook = (shader: Parameters<THREE.Material['onBeforeCompile']>[0]) => {
      shader.fragmentShader += '\n#define TRANSPARENT_TRIANGLE_HOOK 1';
    };
    const sourceCacheKey = () => 'transparent-triangle-custom-cache-key';
    source.onBeforeCompile = sourceHook;
    source.customProgramCacheKey = sourceCacheKey;
    source.roughness = 0.27;
    const sourceWithDefines = source as THREE.MeshStandardMaterial & {
      defines: Record<string, string>;
    };
    sourceWithDefines.defines = { TRANSPARENT_TRIANGLE_DEFINE: '1' };

    const unsupported = new TransparentTriangleController(mesh);
    unsupported.reconcile([{ key: 'custom-hooks', mesh }]);
    unsupported.withDraw(cameraAt(10), () => {
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.material).toBe(source);
    });
    expect(unsupported.inspect().targets[0]?.reason).toBe('custom-material-needs-clone-factory');
    unsupported.dispose();

    let factoryCalls = 0;
    const controller = new TransparentTriangleController(mesh, {
      cloneMaterial: (material) => {
        factoryCalls += 1;
        const hookedSource = material as THREE.MeshStandardMaterial & {
          defines: Record<string, string>;
        };
        const clone = new THREE.MeshStandardMaterial().copy(hookedSource);
        clone.onBeforeCompile = hookedSource.onBeforeCompile;
        clone.customProgramCacheKey = hookedSource.customProgramCacheKey;
        (clone as THREE.MeshStandardMaterial & { defines: Record<string, string> }).defines = {
          ...hookedSource.defines,
        };
        return clone;
      },
    });
    controller.reconcile([{ key: 'custom-hooks', mesh }]);
    controller.withDraw(cameraAt(10), () => {
      const clone = mesh.material as THREE.MeshStandardMaterial & {
        defines: Record<string, string>;
      };
      expect(clone).not.toBe(source);
      expect(clone.onBeforeCompile).toBe(sourceHook);
      expect(clone.customProgramCacheKey).toBe(sourceCacheKey);
      expect(clone.customProgramCacheKey()).toBe('transparent-triangle-custom-cache-key');
      expect(clone.roughness).toBe(0.27);
      expect(clone.defines).toEqual({ TRANSPARENT_TRIANGLE_DEFINE: '1' });
      const shader = {
        uniforms: {},
        fragmentShader: 'void main() {}',
        vertexShader: 'void main() {}',
      } as unknown as Parameters<THREE.Material['onBeforeCompile']>[0];
      clone.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.fragmentShader).toContain('TRANSPARENT_TRIANGLE_HOOK');
    });
    expect(factoryCalls).toBe(1);
    expect(mesh.material).toBe(source);
    controller.dispose();
  });

  it('requires a factory for standard material onBeforeRender hooks and invokes the preserved hook', () => {
    const { geometry, mesh } = skinnedTarget([-1, -5]);
    const source = mesh.material as THREE.MeshStandardMaterial;
    let hookCalls = 0;
    const sourceHook = () => {
      hookCalls += 1;
    };
    source.onBeforeRender = sourceHook;
    const camera = cameraAt(10);

    const unsupported = new TransparentTriangleController(mesh);
    unsupported.reconcile([{ key: 'custom-render-hook', mesh }]);
    unsupported.withDraw(camera, () => {
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.material).toBe(source);
    });
    expect(unsupported.inspect().targets[0]?.reason).toBe('custom-material-needs-clone-factory');
    unsupported.dispose();

    let factoryCalls = 0;
    const controller = new TransparentTriangleController(mesh, {
      cloneMaterial: (material) => {
        factoryCalls += 1;
        const hookedSource = material as THREE.MeshStandardMaterial;
        const clone = new THREE.MeshStandardMaterial().copy(hookedSource);
        clone.onBeforeRender = hookedSource.onBeforeRender;
        return clone;
      },
    });
    controller.reconcile([{ key: 'custom-render-hook', mesh }]);
    controller.withDraw(camera, () => {
      const clone = mesh.material as THREE.MeshStandardMaterial;
      expect(mesh.geometry).not.toBe(geometry);
      expect(clone).not.toBe(source);
      expect(clone.onBeforeRender).toBe(sourceHook);
      clone.onBeforeRender(
        {} as THREE.WebGLRenderer,
        {} as THREE.Scene,
        camera,
        mesh.geometry,
        mesh,
        {} as THREE.Group,
      );
    });
    expect(factoryCalls).toBe(1);
    expect(hookCalls).toBe(1);
    expect(mesh.material).toBe(source);
    controller.dispose();
  });

  it('rejects nested draws and lifecycle changes during a draw with clear errors', () => {
    const { mesh } = skinnedTarget([-1]);
    const controller = new TransparentTriangleController(mesh);
    const camera = cameraAt(10);
    controller.reconcile([{ key: 'nested', mesh }]);

    expect(() =>
      controller.withDraw(camera, () => controller.withDraw(camera, () => undefined)),
    ).toThrow('TransparentTriangleController does not allow nested withDraw calls.');
    expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(() => controller.withDraw(camera, () => controller.setEnabled(false))).toThrow(
      'TransparentTriangleController cannot change lifecycle state during withDraw.',
    );
    expect(controller.inspect().enabled).toBe(true);
    controller.dispose();
  });
});
