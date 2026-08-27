"""Blender headless: read an FBX, keep only the shape keys needed, write out a GLB.

An extra outfit FBX comes out carrying its own armature, so it is re-parented onto
the main skeleton before being merged. The bone names are shared, so the vertex
groups carry over as they are.

usage: blender -b -P export_glb.py -- [--profile NAME] <in.fbx|in.blend> <out.glb>
                                     [texdir] [extra.fbx ...]
"""
import bpy
import mathutils
import os
import re
import sys

argv = sys.argv[sys.argv.index("--") + 1:]

# Which avatar's shape-key conventions to apply. Defaults to the first avatar so
# the original invocation keeps working unchanged.
profile_name = "yoka"
if "--profile" in argv:
    i = argv.index("--profile")
    profile_name = argv[i + 1]
    del argv[i:i + 2]

src, dst = argv[0], argv[1]
TEXDIR = os.path.abspath(argv[2] if len(argv) > 2 else "tex")
EXTRA = argv[3:]

ARKIT52 = set("""eyeBlinkLeft eyeLookDownLeft eyeLookInLeft eyeLookOutLeft eyeLookUpLeft eyeSquintLeft eyeWideLeft
eyeBlinkRight eyeLookDownRight eyeLookInRight eyeLookOutRight eyeLookUpRight eyeSquintRight eyeWideRight
jawForward jawLeft jawRight jawOpen mouthClose mouthFunnel mouthPucker mouthLeft mouthRight
mouthSmileLeft mouthSmileRight mouthFrownLeft mouthFrownRight mouthDimpleLeft mouthDimpleRight
mouthStretchLeft mouthStretchRight mouthRollLower mouthRollUpper mouthShrugLower mouthShrugUpper
mouthPressLeft mouthPressRight mouthLowerDownLeft mouthLowerDownRight mouthUpperUpLeft mouthUpperUpRight
browDownLeft browDownRight browInnerUp browOuterUpLeft browOuterUpRight
cheekPuff cheekSquintLeft cheekSquintRight noseSneerLeft noseSneerRight tongueOut""".split())

VRM_PRESET = set("""happy angry sad relaxed surprised neutral
aa ih ou ee oh blink blinkLeft blinkRight lookup lookdown lookLeft lookRight""".split())


# Shape keys ship in labelled groups delimited by dummy separator shapes, a
# common convention on commercial avatars. Filtering by group rather than by
# name is what lets the avatar's *own* expression vocabulary through: an
# authored face has no naming convention that identifies it from the outside.
#
# The separators are kept as well, so the runtime can rediscover the grouping
# from the GLB alone rather than being handed a table.
#
# The delimiter itself is per-author — underscores on one avatar, asterisks on
# another — so it is profile data, like the group names.
PROFILES = {
    "yoka": {
        "separator": r"^_{2,}(.+?)_{2,}$",
        # Dropped groups and why: the per-part primitives the presets are
        # composed from (eye / brow / mouth) are redundant once the presets are
        # here, the adjustment group is rig calibration, the blink-inbetween
        # group is documented as not to be touched directly, and MMD is a
        # vocabulary this avatar does not need it for.
        "keep_groups": {"BSL52", "VRM", "VRChat", "YOKA", "YOKA_Hide"},
        # Groups kept only on particular meshes. Empty right now: the shape
        # group looked like it would be needed, because the avatar ships
        # standalone spiral / sparkle / dot irises and the matching presets
        # obviously use them — but the presets turn out to draw their own, so
        # the group is a build-time customisation vocabulary (elf ears, fangs,
        # and on the body, proportions) that the runtime never drives.
        "keep_groups_by_mesh": {},
        # This FBX references its textures, so the relink pass finds them.
        "texture_by_material": {},
    },
    "manuka": {
        "separator": r"^\*{3,}(.+?)\*{3,}$",
        # The opposite composition to the first avatar: no finished faces at
        # all, so the per-part primitives are not redundant here — they are the
        # only way to build an expression, and every one of them has to ship.
        # OPTION carries the drawn effects (heart iris, spiral, dot pupil,
        # tears) that no composition reaches, and MMD is a second complete
        # vocabulary the engine already speaks.
        #
        # Dropped: EYELASH is lash-shape customisation chosen once at build
        # time, and MORPH is face and body proportion (jaw width, elf ears).
        # Neither is something a running avatar changes.
        "keep_groups": {"EYE MORPH", "EYELID", "EYE OPTION",
                        "MOUTH", "BROW", "OPTION", "MMD"},
        "keep_groups_by_mesh": {},
        # The body's shapes sit under no separator, and this author writes the
        # outfit-fitting family as `Shrink_*` rather than `*Hide` — same role,
        # different word, and a different mechanism: the limb is thinned so the
        # garment sits over it instead of the vertices being collapsed.
        "keep_names": r"^Shrink_",
        # This FBX carries no image references at all — the textures ship
        # alongside it as loose PNGs, named after the material that uses them.
        # The vendor .blend does have them wired, but exporting from it crashes
        # Blender during primitive extraction, so the FBX is the source and the
        # mapping is stated here.
        "texture_by_material": {
            "Manuka_body": "Manuka_body.png",
            "Manuka_costume": "Manuka_costume.png",
            "Manuka_face": "Manuka_face.png",
            "Manuka_hair": "Manuka_hair.png",
            # The drawn-effect overlay layer shares the face sheet.
            "Manuka_option": "Manuka_face.png",
        },
    },
}

if profile_name not in PROFILES:
    raise SystemExit(f"unknown profile '{profile_name}': {sorted(PROFILES)}")
_profile = PROFILES[profile_name]
SEPARATOR = re.compile(_profile["separator"])
KEEP_GROUPS = _profile["keep_groups"]
KEEP_GROUPS_BY_MESH = _profile["keep_groups_by_mesh"]
TEX_BY_MATERIAL = _profile.get("texture_by_material", {})
KEEP_NAMES = re.compile(_profile["keep_names"]) if _profile.get("keep_names") else None
print(f"@@@ profile={profile_name} keep_groups={sorted(KEEP_GROUPS)}")


def keep(name, group, mesh):
    if group is not None:
        return group in KEEP_GROUPS or group in KEEP_GROUPS_BY_MESH.get(mesh, ())
    # No separator above this shape: either a mesh that carries a few loose keys
    # (hair length variants, a lingerie *Hide) or an avatar that does not use the
    # convention at all. Fall back to recognising the canonical vocabularies by
    # name — that path has to keep working for the next avatar.
    if name in ARKIT52 or name in VRM_PRESET or name.startswith("vrc."):
        return True
    # "Hide" is the VRChat convention for the shapes an outfit raises to keep the
    # body from poking through it. Not every author uses that word, so the
    # profile can name its own pattern for the same role.
    return bool(KEEP_NAMES.search(name)) if KEEP_NAMES else "Hide" in name


def armature_of(objects):
    return next((o for o in objects if o.type == "ARMATURE"), None)


# A .blend source is preferred when the vendor ships one: materials arrive
# already wired to their textures, so the relink pass below only has to point
# them at the resized copies instead of rebuilding the node trees.
if src.endswith(".blend"):
    bpy.ops.wm.open_mainfile(filepath=src)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=src)
main_arm = armature_of(bpy.data.objects)
print(f"@@@ main armature '{main_arm.name}' bones={len(main_arm.data.bones)}")

# --- re-parent extra outfits onto the main skeleton
#
# From the second FBX import onwards Blender's unit resolution stops working and
# the file arrives at 100x scale. The ratio is worked out against the height of
# the first skeleton's bones, and the file is imported again.
main_bones = {b.name for b in main_arm.data.bones}


def import_extra(path, scale):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, global_scale=scale)
    return [o for o in bpy.data.objects if o not in before]


def scale_ratio(arm):
    """Size of the main skeleton relative to this one, from shared bones only.

    Comparing overall armature extents is wrong: a garment rig is a partial
    skeleton, so its extents are legitimately smaller. Only bones present in
    both can be compared.
    """
    pairs = []
    for b in arm.data.bones:
        if b.name not in main_bones:
            continue
        d = b.head_local.length
        if d > 1e-6:
            pairs.append(main_arm.data.bones[b.name].head_local.length / d)
    return sum(pairs) / len(pairs) if pairs else 1.0


def graft_bones(arm, names):
    """Copy the garment's own bones into the main armature, keeping hierarchy.

    A VRChat garment ships with its own physics bones (hems, ribbons) that the
    avatar skeleton does not have; Modular Avatar grafts them in at build time.
    Without them the mesh binds to nothing and explodes.
    """
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = main_arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = main_arm.data.edit_bones

    def depth(b):
        d, p = 0, b.parent
        while p:
            d, p = d + 1, p.parent
        return d

    created = {}
    for b in sorted((arm.data.bones[n] for n in names), key=depth):
        nb = eb.new(b.name)
        nb.head = b.head_local
        nb.tail = b.tail_local
        nb.align_roll(b.matrix_local.to_3x3() @ mathutils.Vector((0, 0, 1)))
        created[b.name] = nb
        if b.parent:
            nb.parent = created.get(b.parent.name) or eb.get(b.parent.name)
    bpy.ops.object.mode_set(mode="OBJECT")
    return len(created)


for path in EXTRA:
    name = os.path.basename(path)
    added = import_extra(path, 1.0)
    arm = armature_of(added)
    if not arm:
        print(f"@@@ {name}: no armature, skipped")
        continue

    ratio = scale_ratio(arm)
    if abs(ratio - 1) > 0.02:
        for o in added:
            bpy.data.objects.remove(o, do_unlink=True)
        added = import_extra(path, ratio)
        arm = armature_of(added)
        print(f"@@@ {name}: rescaled by {ratio:.5f}")

    own = [b.name for b in arm.data.bones if b.name not in main_bones]
    grafted = graft_bones(arm, own) if own else 0
    main_bones.update(own)

    moved = []
    bpy.context.view_layer.update()
    for ob in [o for o in added if o.type == "MESH"]:
        # Re-parenting must preserve the world transform explicitly. Relying on
        # matrix_parent_inverse does not survive the glTF export — that is a
        # Blender-only concept — and the mesh comes out at the armature's raw
        # 0.01 scale inverted, i.e. 100x too large.
        world = ob.matrix_world.copy()
        ob.parent = main_arm
        ob.matrix_parent_inverse.identity()
        ob.matrix_world = world
        for mod in ob.modifiers:
            if mod.type == "ARMATURE":
                mod.object = main_arm
        moved.append(f"{ob.name}({ob.dimensions.y:.2f})")
    bpy.data.objects.remove(arm, do_unlink=True)
    print(f"@@@ merged {name} -> {moved}  grafted_bones={grafted}")

# --- split multi-material meshes per material and name the pieces
#
# The glTF exporter splits a mesh per material and renumbers the pieces into a
# sequence like Mesh011. Naming a part to swap an outfit needs an identifier, so
# the split is done here first and each piece is given <original>__<material>.
#
# Meshes that carry shape keys (the face) are excluded. Splitting one scatters its
# morphs across several meshes and breaks what the expressions drive.
split = []
for ob in [o for o in bpy.data.objects if o.type == "MESH"]:
    if len(ob.data.materials) < 2 or ob.data.shape_keys:
        continue
    orig = ob.name
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="MATERIAL")
    bpy.ops.object.mode_set(mode="OBJECT")
    for part in [o for o in bpy.context.selected_objects if o.type == "MESH"]:
        mats = part.data.materials
        mi = part.data.polygons[0].material_index if part.data.polygons else 0
        mat = mats[mi].name if mi < len(mats) and mats[mi] else "mat"
        part.name = f"{orig}__{mat}"
        split.append(part.name)
if split:
    print(f"@@@ split by material -> {split}")

# --- relink textures (the absolute Windows paths in the FBX become local ones)
relinked, miss = 0, []
for im in bpy.data.images:
    base = os.path.basename(im.filepath.replace("\\", "/"))
    local = os.path.join(TEXDIR, base)
    if os.path.exists(local):
        im.filepath = local
        try:
            im.reload()
            relinked += 1
        except Exception as e:
            miss.append(f"{base}: {e}")
    elif base:
        miss.append(base)
print(f"@@@ textures relinked={relinked} missing={sorted(set(miss))}")


# --- give materials a base-colour image when the source ships none
#
# An FBX exported without embedded media has materials but no image references,
# so nothing survives to relink and the avatar arrives untextured. The textures
# are on disk next to it, named after the material, so the mapping is stated in
# the profile and wired here.
#
# Alpha is connected as well, and the material marked as blended. The runtime
# turns that into an alpha test (see materials.js); what it cannot do is invent
# transparency for a material that arrived opaque, and without it every
# alpha-cut piece — lashes, hair cards, the highlights over the iris — renders
# as an opaque rectangle.
def wire_texture(mat, path):
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
        if out is None:
            out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(path, check_existing=True)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if "Alpha" in bsdf.inputs:
        nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    # The attribute that carries this was renamed across Blender versions.
    for attr, value in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        if hasattr(mat, attr):
            setattr(mat, attr, value)


wired = []
for mat in bpy.data.materials:
    filename = TEX_BY_MATERIAL.get(mat.name)
    if not filename:
        continue
    path = os.path.join(TEXDIR, filename)
    if not os.path.exists(path):
        miss.append(filename)
        continue
    wire_texture(mat, path)
    wired.append(f"{mat.name}<-{filename}")
if wired or TEX_BY_MATERIAL:
    print(f"@@@ textures wired by material: {wired}")

# --- thin out the shape keys
report = []
for ob in [o for o in bpy.data.objects if o.type == "MESH"]:
    sk = ob.data.shape_keys
    if not sk:
        continue
    names = [k.name for k in sk.key_blocks[1:]]

    # Walk in order so each shape knows which separator it sits under.
    group, groups, drop = None, [], []
    for n in names:
        m = SEPARATOR.match(n)
        if m:
            group = m.group(1)
            groups.append(group)
        elif not keep(n, group, ob.name):
            drop.append(n)
    kept_groups = [g for g in groups
                   if g in KEEP_GROUPS or g in KEEP_GROUPS_BY_MESH.get(ob.name, ())]
    # A separator whose whole group is dropped would be a boundary around
    # nothing, so it goes too.
    drop += [n for n in names
             if SEPARATOR.match(n) and SEPARATOR.match(n).group(1) not in kept_groups]

    for n in drop:
        ob.shape_key_remove(sk.key_blocks[n])
    left = len(ob.data.shape_keys.key_blocks) - 1 if ob.data.shape_keys else 0
    report.append((ob.name, len(names), left, kept_groups))
print("@@@ SHAPEKEYS  mesh / before / after / groups")
for n, b, a, g in report:
    print(f"@@@   {n:20} {b:5} -> {a:4}  {','.join(g) or '-'}")

for ob in [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys]:
    kept = [k.name for k in ob.data.shape_keys.key_blocks[1:]]
    if kept:
        print(f"@@@ KEPT[{ob.name}] {','.join(kept)}")

print("@@@ MESHLIST")
for ob in [o for o in bpy.data.objects if o.type == "MESH"]:
    mats = [m.name for m in ob.data.materials]
    print(f"@@@   {ob.name:18} verts={len(ob.data.vertices):6} mats={','.join(mats)}")

kw = dict(
    filepath=dst,
    export_format="GLB",
    export_morph=True,
    export_morph_normal=False,
    export_skins=True,
    export_yup=True,
    export_apply=False,
)
try:
    bpy.ops.export_scene.gltf(**kw, export_image_format="WEBP", export_image_quality=85)
except TypeError:
    bpy.ops.export_scene.gltf(**kw)
print(f"@@@ EXPORTED {dst} {os.path.getsize(dst)} bytes")
