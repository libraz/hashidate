"""Read the lilToon look out of a unitypackage's .mat files as `materials.toon`.

usage: python3 lil_materials.py <package.unitypackage> --folder <path substring>
           --glb <model.glb> [--map <glb material>=<mat name> ...]

Prints {"toon": {...}} on stdout, ready to paste into a descriptor, and reports
on stderr. Only the .mat files whose Unity path contains --folder are read, and
only m_Shader, m_TexEnvs, m_Floats and m_Colors in them. A GLB material takes
the .mat of the same name, else the one named without a `mt_` prefix, else the
one --map gives. Textures are named by the stem of their Unity path plus `.png`,
which is what textures.py writes; toon_textures.py copies them next to the GLB.

A shader guid not in the table is an error: leave other shaders out with
--folder. Everything the importer does not reproduce but the material uses is
listed on stderr as `warning:`; a material on either side with no partner is
listed as `unmatched`.
"""
import argparse
import json
import os
import re
import struct
import sys
import tarfile

# Shader guid (first 8 hex digits) -> whether the variant draws an outline pass.
# lilToon's own .shader.meta guids, stable across releases. Fur, Lite and the
# other families follow the same rule: only the body pass is read.
OUTLINE = {
    "df12117e": False, "85d6126c": False, "3b4aa199": True, "efa77a80": True,
    "165365ab": False, "3c79b10c": True, "b269573b": False, "71716888": True,
    "6a77405f": False, "9cf05406": True,
    "381af8ba": False, "b957dce3": False, "8cf5267d": True, "583a8800": True,
    "0e3ece1b": False, "1c12a370": True, "34c2907e": False, "701268c0": True,
    "82226adb": False, "62df797f": True,
    "9294844b": False, "51b2dee0": True,
    "55706696": False, "544c75f5": False, "54bc8b41": False,
    "a8d94439": False, "dce3f3e2": False, "3fb94a39": False,
    "3eef4aee": False, "bbfffd55": False, "c6d605ee": True, "afa1a194": False,
    "5ba51788": True, "9b0c2630": True, "90f83c35": False, "67ed0252": True,
    "7e398ea5": False, "7e61dbad": True,
    "fba17785": True, "3b3957e6": True, "0c762f24": True,
    "94274b8e": False, "33e950d0": False, "00795bf5": False,
}
BLEND_MODES = ("normal", "add", "screen", "multiply")
GLB_JSON_CHUNK = 0x4E4F534A


def fail(message):
    raise SystemExit(f"lil_materials: {message}")


def num(value):
    """A float32 read from YAML, without its representation noise."""
    value = round(value, 6)
    return int(value) if value == int(value) else value


def parse_mat(text, where):
    """The shader guid and the three property lists of a Unity text-YAML material."""
    if not text.lstrip().startswith(("%YAML", "---")):
        fail(f"{where}: not a Unity text material (is the project set to force text?)")
    shader = None
    section = None
    indent = 0
    name = None
    textures, floats, colors = {}, {}, {}
    inside = False
    seen = False
    for line in text.splitlines():
        if line.startswith("---"):
            # Class 21 is Material; a file may lead with other documents.
            inside = line.startswith("--- !u!21 ")
            seen = seen or inside
            section = None
            continue
        if not inside:
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("%"):
            continue
        here = len(line) - len(line.lstrip())
        found = re.search(r"m_Shader:.*guid: ([0-9a-fA-F]{32})", line)
        if found:
            shader = found.group(1).lower()
            continue
        key = re.fullmatch(r"(m_\w+):(?:\s*\[\])?", stripped)
        if key and not stripped.startswith("-") and (section is None or here <= indent):
            section = key.group(1) if key.group(1) in ("m_TexEnvs", "m_Floats", "m_Colors") else None
            indent = here
            continue
        if section is None:
            continue
        item = re.match(r"-\s*(\w+):\s*(.*)$", stripped)
        if section == "m_TexEnvs":
            if item and not item.group(2):
                name = item.group(1)
                continue
            guid = re.match(r"m_Texture:.*guid: ([0-9a-fA-F]{32})", stripped)
            if guid and name:
                textures[name] = guid.group(1).lower()
        elif item and section == "m_Floats":
            try:
                floats[item.group(1)] = float(item.group(2))
            except ValueError:
                fail(f"{where}: {item.group(1)} is not a number: {item.group(2)!r}")
        elif item and section == "m_Colors":
            parts = dict(re.findall(r"([rgba]):\s*(-?[0-9.eE+-]+)", item.group(2)))
            if set(parts) != set("rgba"):
                fail(f"{where}: {item.group(1)} is not a colour: {item.group(2)!r}")
            colors[item.group(1)] = tuple(float(parts[c]) for c in "rgba")
    if not seen:
        fail(f"{where}: no Material document (!u!21)")
    if shader is None:
        fail(f"{where}: no m_Shader guid")
    return shader, textures, floats, colors


def read_package(package, folder):
    """({.mat basename: text}, {guid: Unity path}) from a gzip-compressed unitypackage."""
    paths = {}
    try:
        with tarfile.open(package, "r|gz") as tf:
            for member in tf:
                if member.name.endswith("/pathname"):
                    guid = member.name.removeprefix("./").split("/")[0]
                    paths[guid] = tf.extractfile(member).read().decode("utf-8").split("\n")[0]
    except (OSError, tarfile.TarError) as e:
        fail(f"cannot read {package}: {e}")
    wanted = {}
    for guid, path in paths.items():
        if folder in path and path.lower().endswith(".mat"):
            wanted.setdefault(os.path.basename(path)[:-4], []).append(guid)
    clash = {name: [paths[g] for g in guids] for name, guids in wanted.items() if len(guids) > 1}
    if clash:
        fail(f"materials share a name under {folder!r}, narrow --folder: {clash}")
    by_guid = {guids[0]: name for name, guids in wanted.items()}
    mats = {}
    with tarfile.open(package, "r|gz") as tf:
        for member in tf:
            if not member.name.endswith("/asset"):
                continue
            guid = member.name.removeprefix("./").split("/")[0]
            if guid in by_guid:
                mats[by_guid[guid]] = tf.extractfile(member).read().decode("utf-8")
    if not mats:
        fail(f"no .mat under {folder!r} in {package}")
    return mats, paths


def glb_materials(path):
    """The material names in a GLB's JSON chunk."""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
            if len(head) < 12 or head[:4] != b"glTF":
                fail(f"{path} is not a GLB")
            while True:
                chunk = f.read(8)
                if len(chunk) < 8:
                    fail(f"{path} has no JSON chunk")
                size, kind = struct.unpack("<II", chunk)
                data = f.read(size)
                if kind == GLB_JSON_CHUNK:
                    break
        document = json.loads(data.decode("utf-8"))
    except (OSError, ValueError) as e:
        fail(f"cannot read {path}: {e}")
    return [m["name"] for m in document.get("materials", []) if m.get("name")]


def pair(glb_names, mat_names, overrides):
    """GLB material -> .mat name: the same name, else without `mt_`, else --map."""
    for glb, mat in overrides.items():
        if glb not in glb_names:
            fail(f"--map {glb}={mat}: the GLB has no material {glb!r}")
        if mat not in mat_names:
            fail(f"--map {glb}={mat}: no .mat named {mat!r}")
    paired = {}
    for glb in glb_names:
        if glb in mat_names:
            paired[glb] = glb
        elif glb.startswith("mt_") and glb[3:] in mat_names:
            paired[glb] = glb[3:]
        elif glb in overrides:
            paired[glb] = overrides[glb]
    return paired


class Material:
    """One .mat with the lookups the conversion needs."""

    def __init__(self, name, text, paths):
        self.name = name
        shader, self.textures, self.floats, self.colors = parse_mat(text, f"{name}.mat")
        if shader[:8] not in OUTLINE:
            fail(f"{name}.mat: shader guid {shader} is not a lilToon variant; leave it out with --folder")
        self.outline = OUTLINE[shader[:8]]
        self.paths = paths
        self.warnings = []

    def f(self, key, default):
        return self.floats.get(key, default)

    def on(self, key):
        return self.f(key, 0) == 1

    def color(self, key, default):
        return self.colors.get(key, default)

    def texture(self, key):
        """The `<stem>.png` a texture slot names, or None when empty or not in the package."""
        guid = self.textures.get(key)
        if guid is None:
            return None
        path = self.paths.get(guid)
        if path is None:
            self.warnings.append(f"{key} names a texture that is not in the package")
            return None
        return os.path.splitext(os.path.basename(path))[0] + ".png"


def rgb(c):
    return [num(v) for v in c[:3]]


def rgba(c):
    return [num(v) for v in c[:4]]


def with_mask(block, mat, slot):
    mask = mat.texture(slot)
    if mask:
        block["mask"] = mask
    return block


def convert(mat):
    """A ToonSpec for one material (src/protocol/avatars.ts is the reference)."""
    spec = {"shadow": with_mask({
        "color": rgb(mat.color("_ShadowColor", (0.82, 0.76, 0.85, 1))),
        "border": num(mat.f("_ShadowBorder", 0.5)),
        "blur": num(mat.f("_ShadowBlur", 0.1)),
        "strength": num(mat.f("_ShadowStrength", 1)) if mat.on("_UseShadow") else 0,
        "normalStrength": num(mat.f("_ShadowNormalStrength", 1)),
    }, mat, "_ShadowStrengthMask")}
    second = mat.color("_Shadow2ndColor", (0.68, 0.66, 0.79, 0))
    if second[3] > 0:
        spec["shadow2"] = {"color": rgba(second), "border": num(mat.f("_Shadow2ndBorder", 0.15)),
                           "blur": num(mat.f("_Shadow2ndBlur", 0.1))}
    if mat.f("_AsUnlit", 0) > 0:
        spec["asUnlit"] = num(mat.f("_AsUnlit", 0))
    bump = mat.texture("_BumpMap")
    if mat.on("_UseBumpMap") and bump:
        spec["normalMap"] = {"file": bump, "scale": num(mat.f("_BumpScale", 1))}
    if mat.on("_UseRim"):
        spec["rim"] = with_mask({
            "color": rgba(mat.color("_RimColor", (0.66, 0.5, 0.48, 1))),
            "border": num(mat.f("_RimBorder", 0.5)),
            "blur": num(mat.f("_RimBlur", 0.65)),
            "fresnelPower": num(mat.f("_RimFresnelPower", 3.5)),
        }, mat, "_RimColorTex")
    matcap = mat.texture("_MatCapTex")
    if mat.on("_UseMatCap") and matcap:
        mode = int(mat.f("_MatCapBlendMode", 1))
        if not 0 <= mode < len(BLEND_MODES):
            fail(f"{mat.name}.mat: _MatCapBlendMode {mode} is not 0 to 3")
        spec["matcap"] = with_mask({
            "file": matcap,
            "color": rgba(mat.color("_MatCapColor", (1, 1, 1, 1))),
            "blend": num(mat.f("_MatCapBlend", 1)),
            "mode": BLEND_MODES[mode],
        }, mat, "_MatCapBlendMask")
    if mat.on("_UseEmission"):
        emission = {"color": rgb(mat.color("_EmissionColor", (1, 1, 1, 1)))}
        emissive = mat.texture("_EmissionMap")
        if emissive:
            emission["map"] = emissive
        spec["emission"] = emission
    if mat.outline:
        spec["outline"] = with_mask({
            "width": num(mat.f("_OutlineWidth", 0.08)),
            "color": rgba(mat.color("_OutlineColor", (0.6, 0.56, 0.73, 1))),
            "fixWidth": num(mat.f("_OutlineFixWidth", 0.5)),
        }, mat, "_OutlineWidthMask")
    return spec


def unsupported(mat):
    """(property, value) for each thing the material uses that the runtime does not draw."""
    found = []

    def float_if(key, default, test):
        value = mat.f(key, default)
        if test(value):
            found.append((key, num(value)))

    float_if("_ShadowBorderRange", 0, lambda v: v > 0)
    if mat.outline and mat.textures.get("_OutlineTex") not in (None, mat.textures.get("_MainTex")):
        found.append(("_OutlineTex", "differs from _MainTex"))
    float_if("_RimShadowMask", 0.5, lambda v: v != 0.5)
    float_if("_RimDirStrength", 0, lambda v: v > 0)
    float_if("_MatCapShadowMask", 0, lambda v: v != 0)
    for key in ("_UseBacklight", "_UseRimShade", "_UseMatCap2nd", "_UseMain2ndTex",
                "_UseMain3rdTex", "_UseGlitter", "_UseAnisotropy"):
        float_if(key, 0, lambda v: v == 1)
    third = mat.color("_Shadow3rdColor", (0, 0, 0, 0))
    if third[3] > 0:
        found.append(("_Shadow3rdColor", rgba(third)))
    float_if("_ShadowMainStrength", 0, lambda v: v != 0)
    float_if("_ShadowEnvStrength", 0, lambda v: v != 0)
    for key in ("_ShadowColorTex", "_Shadow2ndColorTex"):
        if key in mat.textures:
            found.append((key, "set"))
    return found


def main(argv):
    parser = argparse.ArgumentParser(prog="lil_materials.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("package")
    parser.add_argument("--folder", required=True)
    parser.add_argument("--glb", required=True)
    parser.add_argument("--map", action="append", default=[], metavar="GLB=MAT")
    args = parser.parse_args(argv)
    overrides = {}
    for entry in args.map:
        glb, sep, mat = entry.partition("=")
        if not sep or not glb or not mat:
            fail(f"--map wants <glb material>=<mat name>, got {entry!r}")
        overrides[glb] = mat

    texts, paths = read_package(args.package, args.folder)
    mats = {name: Material(name, text, paths) for name, text in sorted(texts.items())}
    glb_names = glb_materials(args.glb)
    paired = pair(glb_names, set(mats), overrides)
    if not paired:
        fail("no GLB material has a .mat; check --folder, --glb and --map")

    toon = {}
    for glb, name in sorted(paired.items()):
        mat = mats[name]
        toon[glb] = convert(mat)
        for key, value in unsupported(mat):
            print(f"warning: {glb} ({name}.mat): {key} = {value}", file=sys.stderr)
        for message in mat.warnings:
            print(f"warning: {glb} ({name}.mat): {message}", file=sys.stderr)
    for glb in glb_names:
        if glb not in paired:
            print(f"unmatched: GLB material {glb!r} has no .mat", file=sys.stderr)
    for name in mats:
        if name not in paired.values():
            print(f"unmatched: {name}.mat has no GLB material", file=sys.stderr)
    json.dump({"toon": toon}, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
