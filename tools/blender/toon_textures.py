"""Copy the textures a descriptor's `materials.toon` names next to the GLB.

usage: python3 toon_textures.py <profile.json> <descriptor.json> <outdir>

Every file the toon specs name (masks, normal maps, matcaps, emission maps) is
copied from the profile's `textures` directory into <outdir>, which the viewer
fetches them from. A descriptor that is absent, has no `materials.toon` or names
no file leaves nothing to do and exits 0; a named file that is not in `textures`
is listed, all of them, and exits 1.
"""
import json
import os
import shutil
import sys

# The keys that hold a file name, per block of a ToonSpec.
FILE_KEYS = {"shadow": ("mask",), "normalMap": ("file",), "rim": ("mask",),
             "matcap": ("file", "mask"), "emission": ("map",), "outline": ("mask",)}


def read_json(path, what):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise SystemExit(f"cannot read {what} {path}: {e}")


def named_files(descriptor):
    """The sorted file names across every toon spec of a descriptor."""
    materials = descriptor.get("materials") if isinstance(descriptor, dict) else None
    toon = materials.get("toon") if isinstance(materials, dict) else None
    files = set()
    for spec in (toon or {}).values():
        for block, keys in FILE_KEYS.items():
            entry = spec.get(block) if isinstance(spec, dict) else None
            if isinstance(entry, dict):
                files.update(entry[k] for k in keys if isinstance(entry.get(k), str))
    return sorted(files)


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: toon_textures.py <profile.json> <descriptor.json> <outdir>")
    profile_path, descriptor_path, out = argv
    files = named_files(read_json(descriptor_path, "descriptor")) if os.path.isfile(descriptor_path) else []
    if not files:
        print("toon textures: nothing to copy")
        return
    profile = read_json(profile_path, "export profile")
    src = profile.get("textures") if isinstance(profile, dict) else None
    if not src:
        raise SystemExit(f"export profile {profile_path}: missing 'textures'")
    missing = [name for name in files if not os.path.isfile(os.path.join(src, name))]
    if missing:
        raise SystemExit(f"toon textures: not in {src}: {', '.join(missing)}")
    os.makedirs(out, exist_ok=True)
    for name in files:
        shutil.copyfile(os.path.join(src, name), os.path.join(out, name))
    print(f"toon textures: {len(files)} file(s) {src} -> {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
