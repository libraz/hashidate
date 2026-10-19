"""Prepare web-sized textures from an export profile.

usage: python3 textures.py <profile.json>

Copies textures_src/*.png into textures and downsizes each with sips. The size is
the px of the first resize entry whose match glob fits the file name, else 1024.
"""
import fnmatch
import json
import os
import shutil
import subprocess
import sys

DEFAULT_PX = 1024


def main(argv):
    if len(argv) != 1:
        raise SystemExit("usage: textures.py <profile.json>")
    path = argv[0]
    try:
        with open(path, encoding="utf-8") as f:
            profile = json.load(f)
    except (OSError, ValueError) as e:
        raise SystemExit(f"cannot read export profile {path}: {e}")
    if not isinstance(profile, dict):
        raise SystemExit(f"export profile {path}: top level must be an object")

    src = profile.get("textures_src")
    dst = profile.get("textures")
    if not src:
        raise SystemExit(f"export profile {path}: missing 'textures_src'")
    if not dst:
        raise SystemExit(f"export profile {path}: missing 'textures'")
    if not os.path.isdir(src):
        raise SystemExit(f"textures_src not found: {src}")
    rules = profile.get("resize", [])

    os.makedirs(dst, exist_ok=True)
    names = sorted(n for n in os.listdir(src) if n.lower().endswith(".png"))
    for name in names:
        out = os.path.join(dst, name)
        shutil.copyfile(os.path.join(src, name), out)
        px = next((r["px"] for r in rules if fnmatch.fnmatch(name, r["match"])), DEFAULT_PX)
        subprocess.run(["sips", "-Z", str(px), out], check=True, stdout=subprocess.DEVNULL)
    print(f"textures: {len(names)} file(s) {src} -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1:])
