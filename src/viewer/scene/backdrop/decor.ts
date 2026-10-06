import * as THREE from 'three';
import { linenMaterial, timberMaterial } from './finishes';
import { lamp, ROOM, slab } from './parts';
import { framedPrint, type TextureBin } from './textures';

interface PaperTextures {
  color: THREE.Texture | null;
  tooth: THREE.Texture | null;
}

function paperTextures(bin: TextureBin): PaperTextures {
  if (typeof document === 'undefined') return { color: null, tooth: null };

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = 128;
  colorCanvas.height = 128;
  const colorContext = colorCanvas.getContext('2d');
  if (!colorContext) return { color: null, tooth: null };
  colorContext.fillStyle = '#f5efe4';
  colorContext.fillRect(0, 0, colorCanvas.width, colorCanvas.height);
  // Narrow strata catch light at the edge of a page block without becoming
  // decorative ribs. The cover boards hide their ends inside the book.
  for (let y = 3; y < colorCanvas.height; y += 4) {
    colorContext.fillStyle =
      y % 16 === 3 ? 'rgba(133, 112, 101, 0.13)' : 'rgba(133, 112, 101, 0.065)';
    colorContext.fillRect(2, y, colorCanvas.width - 4, 1);
  }
  const color = new THREE.CanvasTexture(colorCanvas);
  color.colorSpace = THREE.SRGBColorSpace;
  color.wrapS = THREE.ClampToEdgeWrapping;
  color.wrapT = THREE.ClampToEdgeWrapping;
  color.anisotropy = 8;
  bin.push(color);

  const toothCanvas = document.createElement('canvas');
  toothCanvas.width = 128;
  toothCanvas.height = 128;
  const toothContext = toothCanvas.getContext('2d');
  if (!toothContext) return { color, tooth: null };
  const toothImage = toothContext.createImageData(toothCanvas.width, toothCanvas.height);
  for (let y = 0; y < toothCanvas.height; y++) {
    for (let x = 0; x < toothCanvas.width; x++) {
      const value = Math.round(228 + Math.sin(x * 0.37 + y * 0.08) * 7 + Math.sin(y * 0.61) * 4);
      const i = (y * toothCanvas.width + x) * 4;
      toothImage.data[i] = value;
      toothImage.data[i + 1] = value;
      toothImage.data[i + 2] = value;
      toothImage.data[i + 3] = 255;
    }
  }
  toothContext.putImageData(toothImage, 0, 0);
  const tooth = new THREE.CanvasTexture(toothCanvas);
  tooth.colorSpace = THREE.NoColorSpace;
  tooth.wrapS = THREE.ClampToEdgeWrapping;
  tooth.wrapT = THREE.ClampToEdgeWrapping;
  tooth.anisotropy = 8;
  bin.push(tooth);
  return { color, tooth };
}

interface BookOptions {
  width: number;
  height: number;
  depth: number;
  cover: number;
  spine: number;
  tilt?: number;
  turnY?: number;
  print?: THREE.Texture | null;
  label?: THREE.Texture | null;
}

function book(pageTextures: PaperTextures, brass: THREE.Material, opts: BookOptions): THREE.Group {
  const group = new THREE.Group();
  const cover = new THREE.MeshStandardMaterial({
    color: opts.cover,
    roughness: 0.76,
    roughnessMap: pageTextures.tooth,
    bumpMap: pageTextures.tooth,
    bumpScale: 0.008,
  });
  const spine = new THREE.MeshStandardMaterial({
    color: opts.spine,
    roughness: 0.7,
    roughnessMap: pageTextures.tooth,
    bumpMap: pageTextures.tooth,
    bumpScale: 0.006,
  });
  const pages = new THREE.MeshStandardMaterial({
    color: pageTextures.color ? 0xffffff : 0xf4eee3,
    map: pageTextures.color,
    roughnessMap: pageTextures.tooth,
    bumpMap: pageTextures.tooth,
    bumpScale: 0.02,
    roughness: 0.96,
  });

  const pageBlock = slab(opts.width - 0.012, opts.height - 0.016, opts.depth - 0.012, pages, 1);
  group.add(pageBlock);

  for (const z of [-1, 1]) {
    const board = slab(opts.width, opts.height, 0.008, cover, 1);
    board.position.z = z * (opts.depth / 2 + 0.004);
    group.add(board);
  }

  const spineBoard = slab(0.012, opts.height, opts.depth, spine, 1);
  spineBoard.position.x = -opts.width / 2;
  group.add(spineBoard);

  // One quiet vertical band is enough to say “designed object” at this scale.
  if (!opts.print) {
    const band = slab(0.006, opts.height * 0.68, 0.002, brass, 1);
    band.position.set(opts.width * 0.19, 0, opts.depth / 2 + 0.009);
    group.add(band);
  }

  if (opts.print) {
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(opts.width * 0.76, opts.height * 0.67),
      new THREE.MeshStandardMaterial({ map: opts.print, color: 0xffffff, roughness: 0.9 }),
    );
    art.position.z = opts.depth / 2 + 0.01;
    group.add(art);
  }
  if (opts.label) {
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(opts.width * 0.72, opts.height * 0.14),
      new THREE.MeshStandardMaterial({
        map: opts.label,
        transparent: true,
        color: 0xffffff,
        roughness: 0.92,
        depthWrite: false,
      }),
    );
    label.position.set(0, -opts.height * 0.29, opts.depth / 2 + 0.012);
    group.add(label);
  }

  group.rotation.y = opts.turnY ?? 0;
  group.rotation.z = opts.tilt ?? 0;
  return group;
}

function coverLabelTexture(bin: TextureBin): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(91, 77, 76, 0.78)';
  context.font = '600 22px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('BOTANICAL NOTES', canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  bin.push(texture);
  return texture;
}

/**
 * Small things that make the shared room feel occupied.
 *
 * These are deliberately separate from the imported furniture in `assets.ts`.
 * The glTF pieces arrive asynchronously, while this group is part of every
 * pattern build and must be complete before the first frame. Keeping the
 * procedural pieces here also gives them one owner for geometry, materials and
 * the few generated textures they use.
 */
export function bedroomDetails(bin: TextureBin): THREE.Group {
  const root = new THREE.Group();
  root.name = 'bedroom-details';

  const shelfWood = timberMaterial(bin, { width: 0.65, height: 0.2 });
  const bracketWood = timberMaterial(bin, { width: 0.16, height: 0.11 });
  // Cylinder UVs wrap once around the shade; include the fixture's 68% scale.
  const lampShade = linenMaterial(bin, 0xf5eee7, {
    width: Math.PI * 0.16 * 0.68,
    height: 0.11 * 0.68,
  });
  const brass = new THREE.MeshStandardMaterial({
    color: 0xc5a16c,
    metalness: 0.72,
    roughness: 0.34,
  });

  // A narrow ledge in the unused left wall area. Its exact position keeps the
  // avatar's head clear while giving the imported poster pair a low visual
  // anchor beneath it.
  const wallShelf = new THREE.Group();
  wallShelf.name = 'wall-shelf';
  wallShelf.position.set(-1.15, 1.1, ROOM.backZ + 0.11);
  const shelfBoard = slab(0.65, 0.026, 0.2, shelfWood, 4);
  wallShelf.add(shelfBoard);
  for (const side of [-1, 1]) {
    const bracket = slab(0.02, 0.11, 0.16, bracketWood, 2);
    bracket.position.set(side * 0.235, -0.068, -0.01);
    wallShelf.add(bracket);
  }

  const pages = paperTextures(bin);
  const coverPrint = framedPrint(bin, '/textures/poster-peonies.jpg');
  const coverLabel = coverLabelTexture(bin);
  const placeBook = (x: number, opts: BookOptions): void => {
    const tilt = opts.tilt ?? 0;
    const item = book(pages, brass, opts);
    // Raise the centre by the rotated half-width as well as the half-height,
    // so the low corner of the leaning book still lands on the plank.
    item.position.set(
      x,
      0.013 + (Math.cos(tilt) * opts.height) / 2 + (Math.abs(Math.sin(tilt)) * opts.width) / 2,
      -0.012,
    );
    wallShelf.add(item);
  };
  placeBook(-0.15, {
    width: 0.11,
    height: 0.2,
    depth: 0.034,
    cover: 0xd39aaa,
    spine: 0xa66d7e,
    tilt: -0.1,
    print: coverPrint,
    label: coverLabel,
  });
  placeBook(-0.04, {
    width: 0.1,
    height: 0.18,
    depth: 0.032,
    cover: 0xf0e5d9,
    spine: 0xcdb8a3,
    turnY: Math.PI / 2,
  });
  placeBook(0.065, {
    width: 0.105,
    height: 0.205,
    depth: 0.036,
    cover: 0xa8b9a2,
    spine: 0x75866d,
    turnY: -Math.PI / 2,
  });
  placeBook(0.17, {
    width: 0.095,
    height: 0.16,
    depth: 0.03,
    cover: 0x9cafc2,
    spine: 0x6c8198,
    turnY: Math.PI / 2,
  });

  root.add(wallShelf);

  const lampBulb = new THREE.MeshStandardMaterial({
    color: 0xffe5bd,
    emissive: 0xffbd78,
    emissiveIntensity: 1.8,
    roughness: 0.4,
  });
  const lampFixture = lamp(lampShade, lampBulb);
  // `lamp` keeps its base, arm and shade as the first three children. A pair
  // of slim champagne rings makes the ivory shade read as a brass/ivory piece
  // without changing the helper's intentionally soft silhouette.
  lampFixture.position.set(-0.25, 0.013, 0.01);
  lampFixture.scale.setScalar(0.68);
  for (const child of lampFixture.children.slice(0, 2)) {
    if (child instanceof THREE.Mesh) child.material = brass;
  }
  const lampBaseRing = new THREE.Mesh(new THREE.TorusGeometry(0.074, 0.004, 8, 20), brass);
  lampBaseRing.position.y = 0.019;
  lampBaseRing.rotation.x = Math.PI / 2;
  lampFixture.add(lampBaseRing);
  const lampCollar = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.0035, 8, 20), brass);
  lampCollar.position.set(-0.075, 0.36, 0.02);
  lampCollar.rotation.set(0.5, 0, 0.38);
  lampFixture.add(lampCollar);
  wallShelf.add(lampFixture);
  return root;
}
