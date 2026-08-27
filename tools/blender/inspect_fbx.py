"""Blender headless: report the structure of an FBX.

usage: blender -b -P inspect_fbx.py -- <path.fbx>
"""
import bpy
import sys

path = sys.argv[sys.argv.index("--") + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=path)

meshes, arms = [], []
for ob in bpy.data.objects:
    if ob.type == "MESH":
        meshes.append(ob)
    elif ob.type == "ARMATURE":
        arms.append(ob)

print("\n@@@ SUMMARY")
print(f"@@@ objects={len(bpy.data.objects)} meshes={len(meshes)} armatures={len(arms)}")
for a in arms:
    print(f"@@@ armature '{a.name}' bones={len(a.data.bones)}")

tot_v = tot_t = tot_sk = 0
print("@@@ MESHES")
print(f"@@@ {'name':28} {'verts':>8} {'tris':>8} {'mats':>5} {'shapekeys':>10}")
for ob in sorted(meshes, key=lambda o: -len(o.data.vertices)):
    me = ob.data
    me.calc_loop_triangles()
    nsk = len(me.shape_keys.key_blocks) - 1 if me.shape_keys else 0
    tot_v += len(me.vertices)
    tot_t += len(me.loop_triangles)
    tot_sk += nsk
    print(f"@@@ {ob.name:28} {len(me.vertices):8} {len(me.loop_triangles):8} "
          f"{len(ob.material_slots):5} {nsk:10}")
print(f"@@@ TOTAL verts={tot_v} tris={tot_t} shapekeys={tot_sk}")

print("@@@ MATERIALS")
for m in bpy.data.materials:
    print(f"@@@   {m.name}")

print("@@@ IMAGES")
for im in bpy.data.images:
    print(f"@@@   {im.name}  src={im.filepath}")
