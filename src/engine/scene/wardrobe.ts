import * as THREE from 'three';
import type { Localized } from '../../i18n/locale';
import type { MorphTarget, Profile, WardrobePreset, WardrobeSlot, WardrobeTable } from '../types';

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
 */

const EMPTY: WardrobeTable = { slots: {}, presets: {} };

export class Wardrobe {
  readonly profile: Profile;
  readonly slots: Record<string, WardrobeSlot>;
  readonly presetDefs: Record<string, WardrobePreset>;
  readonly note: Localized | null;
  readonly all: THREE.Mesh[] = [];
  /** Which item is worn in each slot, or null for none. */
  readonly state: Record<string, string | null> = {};
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
   */
  constructor(root: THREE.Object3D, profile: Profile, table: WardrobeTable = EMPTY) {
    this.profile = profile;
    this.slots = table?.slots ?? {};
    this.presetDefs = table?.presets ?? {};
    this.note = table?.note ?? null;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) this.all.push(o);
    });

    for (const [slot, def] of Object.entries(this.slots)) {
      for (const it of def.items) {
        const gone = it.meshes.filter((n) => this.resolve(n).length === 0);
        if (gone.length) this.missing.push(`${slot}/${it.id}: ${gone.join(',')}`);
      }
      this.state[slot] = null;
    }
    if (this.presetDefs.default) this.applyPreset('default');
    else this.apply();
  }

  /**
   * Export mangles garment names two ways, so one table entry has to match
   * all of them:
   *   "<mesh>__<material>" — we split multi-material meshes ourselves
   *   "<mesh>_<n>"         — glTF disambiguates a clash with a bone of the
   *                          same name, which is how "Pillow" became "Pillow_1"
   */
  private resolve(name: string): THREE.Mesh[] {
    return this.all.filter(
      (m) =>
        m.name === name ||
        m.name.startsWith(`${name}__`) ||
        new RegExp(`^${name}_\\d+$`).test(m.name),
    );
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
  }
}
