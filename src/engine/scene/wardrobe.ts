import * as THREE from 'three';
import type { Localized } from '../../i18n/locale';
import type {
  MorphTarget,
  Profile,
  WardrobeNodePose,
  WardrobePreset,
  WardrobeSlot,
  WardrobeTable,
} from '../types';

/**
 * Wardrobe layer.
 *
 * Which meshes make up a garment, and which body parts have to be hidden so
 * they do not poke through it, is avatar data and lives in the avatar
 * descriptor. This file is only the mechanism. The runtime asks for a canonical
 * slot ("bottom") and an item id ("long"); nothing here knows what either
 * means.
 *
 * Two mechanisms, because two avatars needed two:
 *
 * - visibility, which every avatar uses
 * - hide shapes, the VRChat convention where the body carries a `*Hide`
 *   blendshape per region (neck, bust, thigh, shin, …) that collapses those
 *   vertices, and an outfit declares the set it needs
 *
 * The second is optional. An avatar whose outfit is not cut to sit over
 * collapsed geometry simply declares no `hide` list, and taking a piece off is
 * a plain visibility change.
 *
 * An item may also carry a `pose`: rest transforms for named nodes, such as the
 * foot angle a heel needs. Every layer that measures the rig reads the rest
 * once, so a pose is written onto the scene before the rig is built
 * (`poseWardrobe`), and a change of pose asks for a rebuild (`onPoseChange`)
 * instead of being written in place.
 */

/** `<name>_<digits>`, without building a pattern out of a name. */
function isNumberedClash(meshName: string, name: string): boolean {
  if (!meshName.startsWith(`${name}_`)) return false;
  const suffix = meshName.slice(name.length + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

const EMPTY: WardrobeTable = { slots: {}, presets: {} };

export type WornState = Record<string, string | null>;

/** Every slot empty, then the `default` preset, then whatever `initial` says about a slot the table has. */
export function wornState(table: WardrobeTable | undefined, initial?: WornState): WornState {
  const slots = table?.slots ?? {};
  const state: WornState = {};
  for (const slot of Object.keys(slots)) state[slot] = null;
  const assign = (set: WornState) => {
    for (const [slot, item] of Object.entries(set)) if (slot in slots) state[slot] = item;
  };
  const preset = table?.presets?.default;
  if (preset) assign(preset.set);
  if (initial) assign(initial);
  return state;
}

/** The node poses `state` wears; a later slot wins over an earlier one on the same node. */
export function wardrobePose(
  table: WardrobeTable | undefined,
  state: WornState,
): Map<string, WardrobeNodePose> {
  const pose = new Map<string, WardrobeNodePose>();
  for (const [slot, def] of Object.entries(table?.slots ?? {})) {
    const item = def.items.find((x) => x.id === state[slot]);
    for (const [name, transform] of Object.entries(item?.pose ?? {})) pose.set(name, transform);
  }
  return pose;
}

function poseKey(pose: Map<string, WardrobeNodePose>): string {
  return JSON.stringify([...pose].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Objects by sanitised glTF node name, the way the loader names them. */
function nodesByName(root: THREE.Object3D): Map<string, THREE.Object3D[]> {
  const nodes = new Map<string, THREE.Object3D[]>();
  root.traverse((o) => {
    const raw = typeof o.userData?.name === 'string' ? o.userData.name : o.name;
    if (!raw) return;
    const name = THREE.PropertyBinding.sanitizeNodeName(raw);
    nodes.set(name, [...(nodes.get(name) ?? []), o]);
  });
  return nodes;
}

/**
 * Write the node poses `state` wears onto a freshly loaded scene, before
 * anything measures it. Returns the names the scene does not have.
 */
export function poseWardrobe(
  root: THREE.Object3D,
  table: WardrobeTable | undefined,
  state: WornState,
): string[] {
  const pose = wardrobePose(table, state);
  if (pose.size === 0) return [];
  const nodes = nodesByName(root);
  const missing: string[] = [];
  for (const [name, transform] of pose) {
    const found = nodes.get(THREE.PropertyBinding.sanitizeNodeName(name));
    if (!found) {
      missing.push(name);
      continue;
    }
    for (const node of found) {
      if (transform.rotation) node.quaternion.fromArray(transform.rotation).normalize();
      if (transform.translation) node.position.fromArray(transform.translation);
    }
  }
  root.updateMatrixWorld(true);
  return missing;
}

export class Wardrobe {
  readonly profile: Profile;
  readonly slots: Record<string, WardrobeSlot>;
  readonly presetDefs: Record<string, WardrobePreset>;
  readonly note: Localized | null;
  readonly all: THREE.Mesh[] = [];
  /** Every object carrying a glTF node name in `userData.name`. */
  private readonly namedObjects: THREE.Object3D[] = [];
  /** Which item is worn in each slot, or null for none. */
  readonly state: WornState;
  /**
   * Called when the worn items ask for a different pose than the scene was
   * built with. The owner rebuilds the avatar wearing `state`; without an
   * owner the meshes change and the pose stays.
   */
  onPoseChange: ((state: WornState) => void) | null = null;
  /** The pose the scene was built with. */
  private readonly builtPose: string;
  /** Item meshes the descriptor names that this GLB does not have. */
  readonly missing: string[] = [];
  /** The hide shapes the current outfit raises. */
  activeHides: string[] = [];
  /** (mesh, index) pairs currently held at 1 */
  private written: MorphTarget[] = [];

  /**
   * @param root    the loaded GLB scene
   * @param profile the built profile, for routing hide shapes
   * @param table   `{ slots, presets, note }` from the avatar descriptor
   * @param initial the items to wear over the `default` preset; the scene must
   *                already carry their pose (`poseWardrobe`)
   */
  constructor(
    root: THREE.Object3D,
    profile: Profile,
    table: WardrobeTable = EMPTY,
    initial?: WornState,
  ) {
    this.profile = profile;
    this.slots = table?.slots ?? {};
    this.presetDefs = table?.presets ?? {};
    this.note = table?.note ?? null;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) this.all.push(o);
      if (typeof o.userData?.name === 'string') this.namedObjects.push(o);
    });

    const nodes = nodesByName(root);
    for (const [slot, def] of Object.entries(this.slots)) {
      for (const it of def.items) {
        const gone = it.meshes.filter((n) => this.resolve(n).length === 0);
        for (const name of Object.keys(it.pose ?? {}))
          if (!nodes.has(THREE.PropertyBinding.sanitizeNodeName(name))) gone.push(name);
        if (gone.length) this.missing.push(`${slot}/${it.id}: ${gone.join(',')}`);
      }
    }
    this.state = wornState(table, initial);
    this.builtPose = poseKey(wardrobePose(table, this.state));
    this.apply();
  }

  /**
   * Export mangles garment names two ways, so one table entry has to match
   * all of them:
   *   "<mesh>__<material>" — we split multi-material meshes ourselves
   *   "<mesh>_<n>"         — glTF disambiguates a clash with a bone of the
   *                          same name, which is how "Pillow" became "Pillow_1"
   * A glTF node name also matches: the node's Mesh, or for a multi-primitive
   * node (a Group) its direct child Meshes.
   */
  private resolve(name: string): THREE.Mesh[] {
    // Mesh names reach the scene through the loader's sanitiser; the descriptor
    // may spell them as the authoring tool did.
    const wanted = THREE.PropertyBinding.sanitizeNodeName(name);
    const found = new Set(
      this.all.filter(
        (m) =>
          m.name === wanted || m.name.startsWith(`${wanted}__`) || isNumberedClash(m.name, wanted),
      ),
    );
    for (const o of this.namedObjects) {
      if (THREE.PropertyBinding.sanitizeNodeName(o.userData.name) !== wanted) continue;
      if (o instanceof THREE.Mesh) found.add(o);
      else for (const c of o.children) if (c instanceof THREE.Mesh) found.add(c);
    }
    return [...found];
  }

  set(slot: string, itemId: string | null): void {
    if (!(slot in this.slots)) return;
    this.state[slot] = itemId;
    this.apply();
  }

  applyPreset(name: string): void {
    const p = this.presetDefs[name];
    if (!p) return;
    Object.assign(this.state, p.set);
    this.apply();
  }

  apply(): void {
    // Visibility: every item mesh off, then the selected ones back on.
    for (const def of Object.values(this.slots)) {
      for (const it of def.items) {
        for (const n of it.meshes) for (const m of this.resolve(n)) m.visible = false;
      }
    }
    const hides = new Set<string>();
    for (const [slot, itemId] of Object.entries(this.state)) {
      if (!itemId) continue;
      const it = this.slots[slot]?.items.find((x) => x.id === itemId);
      if (!it) continue;
      for (const n of it.meshes) for (const m of this.resolve(n)) m.visible = true;
      for (const h of it.hide ?? []) hides.add(h);
    }

    // Hide shapes are static per outfit, so they are written once here rather
    // than every frame. Only the exact indices previously raised are cleared:
    // the face mesh carries both hide shapes and expression shapes, and the
    // latter belong to the director.
    for (const { mesh, index } of this.written) {
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = 0;
    }
    const written: MorphTarget[] = [];
    for (const h of hides) {
      for (const t of this.profile.morphTargets.get(h) ?? []) {
        if (!t.mesh.morphTargetInfluences) continue;
        t.mesh.morphTargetInfluences[t.index] = 1;
        written.push(t);
      }
    }
    this.written = written;
    this.activeHides = [...hides];

    if (poseKey(wardrobePose({ slots: this.slots }, this.state)) !== this.builtPose)
      this.onPoseChange?.({ ...this.state });
  }
}
