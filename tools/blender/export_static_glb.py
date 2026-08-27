"""Export a static scenery .blend as compact, geometry-only GLB.

The browser supplies the optimised 1K material maps at runtime.  Keeping the
source's 4K EXR maps out of the GLB avoids turning one bedside asset into a
multi-megabyte download.

usage: blender -b -P export_static_glb.py -- source.blend destination.glb
"""

import bpy
import os
import sys

argv = sys.argv[sys.argv.index("--") + 1 :]
if len(argv) != 2:
    raise SystemExit("usage: export_static_glb.py -- source.blend destination.glb")

source, destination = argv
bpy.ops.wm.open_mainfile(filepath=source)

# A purchased/static asset needs no camera, light or source-world setup.  Do
# retain every mesh: several Poly Haven furnishings keep movable doors and
# drawers as separate objects.
bpy.ops.object.select_all(action="DESELECT")
for obj in bpy.context.scene.objects:
    if obj.type == "MESH":
        obj.select_set(True)

os.makedirs(os.path.dirname(destination), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=destination,
    export_format="GLB",
    use_selection=True,
    export_materials="NONE",
    export_cameras=False,
    export_lights=False,
    export_extras=False,
)
print(f"exported {destination}")
