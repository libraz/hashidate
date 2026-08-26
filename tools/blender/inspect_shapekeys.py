"""Blender headless: dump every shape key and score it against the canonical vocabularies.

usage: blender -b -P inspect_shapekeys.py -- <path.fbx|path.blend> [out.txt]
"""
import bpy
import sys
import re

argv = sys.argv[sys.argv.index("--") + 1:]
path = argv[0]
out_path = argv[1] if len(argv) > 1 else None

ARKIT_52 = """eyeBlinkLeft eyeLookDownLeft eyeLookInLeft eyeLookOutLeft eyeLookUpLeft
eyeSquintLeft eyeWideLeft eyeBlinkRight eyeLookDownRight eyeLookInRight eyeLookOutRight eyeLookUpRight
eyeSquintRight eyeWideRight jawForward jawLeft jawRight jawOpen mouthClose mouthFunnel mouthPucker
mouthLeft mouthRight mouthSmileLeft mouthSmileRight mouthFrownLeft mouthFrownRight mouthDimpleLeft
mouthDimpleRight mouthStretchLeft mouthStretchRight mouthRollLower mouthRollUpper mouthShrugLower
mouthShrugUpper mouthPressLeft mouthPressRight mouthLowerDownLeft mouthLowerDownRight mouthUpperUpLeft
mouthUpperUpRight browDownLeft browDownRight browInnerUp browOuterUpLeft browOuterUpRight cheekPuff
cheekSquintLeft cheekSquintRight noseSneerLeft noseSneerRight tongueOut""".split()

VRC_VISEMES = """sil pp ff th dd kk ch ss nn rr aa e ih oh ou""".split()

# MMD lip sync plus the expression set most Japanese models ship.
MMD_CORE = """あ い う え お まばたき 笑い ウィンク ウィンク右 ウィンク２ ウィンク２右
にこり じと目 びっくり 怒り 困る 悲しい 真面目 上 下 睨み はぅ なごみ 瞳小 ハイライト消
照れ にやり ▲ ∧ ω □ ワ""".split()

if path.endswith(".blend"):
    bpy.ops.wm.open_mainfile(filepath=path)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path)

meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys]

lines = []
per_mesh = {}
for ob in sorted(meshes, key=lambda o: -len(o.data.shape_keys.key_blocks)):
    names = [kb.name for kb in ob.data.shape_keys.key_blocks][1:]  # drop Basis
    per_mesh[ob.name] = names
    lines.append(f"### {ob.name}  ({len(names)})")
    lines.extend(f"  {n}" for n in names)
    lines.append("")

all_names = [n for names in per_mesh.values() for n in names]
lower = {n.lower(): n for n in all_names}


def find(target):
    """Match a canonical name exactly, then case-insensitively, then as a suffix."""
    if target in all_names:
        return target
    if target.lower() in lower:
        return lower[target.lower()]
    for n in all_names:
        if n.lower().endswith(target.lower()):
            return n
    return None


print("\n@@@ SHAPEKEY TOTALS")
for name, names in per_mesh.items():
    print(f"@@@   {name:34} {len(names):5}")
print(f"@@@   {'TOTAL':34} {len(all_names):5}  unique={len(set(all_names))}")

hit = {t: find(t) for t in ARKIT_52}
found = {t: v for t, v in hit.items() if v}
print(f"\n@@@ ARKIT 52: {len(found)}/52")
for t in ARKIT_52:
    if hit[t]:
        mark = "=" if hit[t] == t else "~"
        print(f"@@@   {mark} {t} -> {hit[t]}")
missing = [t for t in ARKIT_52 if not hit[t]]
print(f"@@@ ARKIT missing ({len(missing)}): {' '.join(missing)}")

vis = [v for v in VRC_VISEMES if find(f"vrc.v_{v}") or find(f"v_{v}")]
print(f"\n@@@ VRC VISEMES: {len(vis)}/15  found={' '.join(vis)}")

mmd = [m for m in MMD_CORE if m in all_names]
print(f"\n@@@ MMD CORE: {len(mmd)}/{len(MMD_CORE)}  found={' '.join(mmd)}")

cjk = [n for n in all_names if re.search(r"[ぁ-んァ-ン一-龯]", n)]
print(f"@@@ CJK-named shapes: {len(cjk)}")

if out_path:
    with open(out_path, "w") as f:
        f.write("\n".join(lines))
    print(f"\n@@@ wrote {out_path}")
