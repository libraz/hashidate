"""Prepare web-sized textures from an export profile.

usage: python3 textures.py <profile.json>

Converts the {png,tga,jpg,jpeg,psd} files under textures_src, subdirectories
included, to PNG in textures, named after the source stem, and downsizes any larger
than the target with sips (never upscales). The size is the px of the first resize
entry whose match glob fits the source file name, else 1024. Two sources sharing a
stem, wherever they sit, are an error.
"""
import fnmatch
import json
import os
import shutil
import subprocess
import sys

DEFAULT_PX = 1024
SOURCE_EXTS = (".png", ".tga", ".jpg", ".jpeg", ".psd")


def longest_side(path):
    out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                         check=True, capture_output=True, text=True).stdout
    return max(int(line.split(":")[1]) for line in out.splitlines() if "pixel" in line)


def collect_sources(src):
    """Every texture under src as a path relative to it, sorted; a shared stem is fatal."""
    names = sorted(os.path.relpath(os.path.join(root, name), src)
                   for root, _, files in os.walk(src)
                   for name in files if name.lower().endswith(SOURCE_EXTS))
    stems = {}
    for name in names:
        stems.setdefault(os.path.splitext(os.path.basename(name))[0].lower(), []).append(name)
    clash = {k: v for k, v in stems.items() if len(v) > 1}
    if clash:
        raise SystemExit(f"textures_src: files share a stem and would overwrite each other: {clash}")
    return names


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
    names = collect_sources(src)
    for name in names:
        out = os.path.join(dst, os.path.splitext(os.path.basename(name))[0] + ".png")
        origin = os.path.join(src, name)
        if name.lower().endswith(".png"):
            shutil.copyfile(origin, out)
        else:
            subprocess.run(["sips", "-s", "format", "png", origin, "--out", out],
                           check=True, stdout=subprocess.DEVNULL)
        px = next((r["px"] for r in rules if fnmatch.fnmatch(os.path.basename(name), r["match"])), DEFAULT_PX)
        if longest_side(out) > px:
            subprocess.run(["sips", "-Z", str(px), out], check=True, stdout=subprocess.DEVNULL)
    print(f"textures: {len(names)} file(s) {src} -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1:])
