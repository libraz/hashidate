"""Split the scanned sofa into cloth and timber meshes before GLB export.

The source asset has one material slot for both the upholstery and the dark
wood trim. Its diffuse image is the only authored boundary between those
surfaces, so classify each source polygon from a few UV samples before Blender
triangulates it. The output intentionally carries no source materials; the
viewer supplies the PBR finishes at runtime.

Usage::

    blender -b -P split_sofa.py -- source.blend diffuse.jpg destination.glb
"""

import os
import sys
from mathutils import Vector

import bpy


argv = sys.argv[sys.argv.index("--") + 1 :]
if len(argv) != 3:
    raise SystemExit("usage: split_sofa.py -- source.blend diffuse.jpg destination.glb")

source, diffuse, destination = map(os.path.abspath, argv)
bpy.ops.wm.open_mainfile(filepath=source)

sofa = bpy.data.objects.get("Sofa_01")
if sofa is None or sofa.type != "MESH":
    raise SystemExit("Sofa_01 mesh was not found")

image = bpy.data.images.load(diffuse, check_existing=True)
image.scale(512, 512)
width, height = image.size[:]
if not width or not height:
    raise SystemExit("diffuse image has no pixels")
pixels = list(image.pixels[:])

uv_layer = sofa.data.uv_layers.active
if uv_layer is None:
    raise SystemExit("Sofa_01 has no active UV layer")


def sample(u, v):
    """Read a linear RGB sample with the image's authored edge behaviour."""

    # Image.pixels and Blender UVs use the same bottom-left origin. Wrapping
    # also matches the source sampler at the few UVs just outside the atlas.
    x = max(0, min(width - 1, int((u % 1.0) * width)))
    y = max(0, min(height - 1, int((v % 1.0) * height)))
    offset = (y * width + x) * 4
    r, g, b = pixels[offset : offset + 3]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def polygon_luminance(poly):
    loops = [uv_layer.data[index].uv.copy() for index in poly.loop_indices]
    centroid = sum(loops, Vector((0.0, 0.0))) / len(loops)
    samples = [centroid]
    # The centroid captures the material body. Pulling each loop 40% toward
    # its corner catches the narrow wood trim that surrounds that body.
    samples.extend(centroid * 0.6 + uv * 0.4 for uv in loops)
    return sum(sample(uv.x, uv.y) for uv in samples) / len(samples)


sofa.data.calc_loop_triangles()

cloth_material = bpy.data.materials.new("Sofa_01_upholstery")
wood_material = bpy.data.materials.new("Sofa_01_frame")
sofa.data.materials.clear()
sofa.data.materials.append(cloth_material)
sofa.data.materials.append(wood_material)

cloth = 0
wood = 0
for polygon in sofa.data.polygons:
    if polygon_luminance(polygon) >= 0.22:
        polygon.material_index = 0
        cloth += 1
    else:
        polygon.material_index = 1
        wood += 1
if (cloth, wood) != (1509, 2591):
    raise SystemExit(f"unexpected sofa mask cloth={cloth} wood={wood}; expected 1509/2591")

# Separate by the temporary material indices. Material data is discarded by
# the export, but Blender's material separator preserves the source polygon
# winding, normals, UVs and object transform without a hand-built mesh copy.
bpy.ops.object.select_all(action="DESELECT")
sofa.select_set(True)
bpy.context.view_layer.objects.active = sofa
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.separate(type="MATERIAL")
bpy.ops.object.mode_set(mode="OBJECT")

parts = [obj for obj in bpy.context.selected_objects if obj.type == "MESH"]
if len(parts) != 2:
    raise SystemExit(f"expected two sofa parts, got {len(parts)}")
for part in parts:
    material_name = part.data.materials[0].name if part.data.materials else ""
    part.name = "Sofa_01_upholstery" if material_name == cloth_material.name else "Sofa_01_frame"

os.makedirs(os.path.dirname(destination) or ".", exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
for part in parts:
    part.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.export_scene.gltf(
    filepath=destination,
    export_format="GLB",
    use_selection=True,
    export_materials="NONE",
    export_cameras=False,
    export_lights=False,
    export_extras=False,
)
print(f"@@@ sofa split cloth={cloth} wood={wood} objects={[part.name for part in parts]}")
print(f"@@@ EXPORTED {destination} {os.path.getsize(destination)} bytes")
