"""Import a purchased avatar package through its pack in packs/<id>/.

usage: python3 import_pack.py <packs-dir>                               list the packs
       python3 import_pack.py <packs-dir> <id> <package.zip> <avatars-dir>  import one

A pack is data only, so importing never runs code a pack author wrote. It
unpacks the zip into unpacked/<id>/, runs the pack's `extract` steps
(each pulls files out of a .unitypackage by a path substring, as
extract_textures.py does), checks that every file the export profile names is
there, and puts avatar.json and export.json in place as <avatars-dir>/<id>.json
and <avatars-dir>/export/<id>.json. Paths are relative to the working
directory, which `make import` sets to the repository root.

A package whose hash the pack does not list is imported with a warning; one
that lacks a file the export profile names is refused. Nothing already there is
overwritten: neither an earlier unpacking, whose files would let a wrong
package pass that check, nor a descriptor in <avatars-dir> that differs from
the pack's.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paths import relative  # noqa: E402
from toon_textures import plain_names  # noqa: E402

RESOURCE = "unpacked"
EXTRACT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extract_textures.py")
PACK_KEYS = {"store", "packages", "extract"}
STEP_KEYS = {"from", "match", "into"}


def fail(message):
    raise SystemExit(f"import: {message}")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        fail(f"cannot read {path}: {e}")


def load_pack(packs, pack_id):
    root = os.path.join(packs, pack_id)
    if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]*", pack_id) or not os.path.isdir(root):
        fail(f"no pack named {pack_id!r} in {packs}")
    pack = read_json(os.path.join(root, "pack.json"))
    if not isinstance(pack, dict) or set(pack) != PACK_KEYS:
        fail(f"{root}/pack.json: needs exactly the keys {sorted(PACK_KEYS)}")
    if not isinstance(pack["store"], str) or not re.match(r"https://", pack["store"]):
        fail(f"{root}/pack.json: store must be an https URL")
    packages = pack["packages"]
    if not isinstance(packages, list) or not packages:
        fail(f"{root}/pack.json: packages must list at least one verified package")
    for i, entry in enumerate(packages):
        if (not isinstance(entry, dict) or set(entry) != {"file", "sha256"}
                or not isinstance(entry["file"], str)
                or not isinstance(entry["sha256"], str) or len(entry["sha256"]) != 64):
            fail(f"{root}/pack.json: packages[{i}] needs a file name and a 64-digit sha256")
    if not isinstance(pack["extract"], list):
        fail(f"{root}/pack.json: extract must be a list")
    for i, step in enumerate(pack["extract"]):
        if not isinstance(step, dict) or set(step) != STEP_KEYS:
            fail(f"{root}/pack.json: extract[{i}] needs exactly {sorted(STEP_KEYS)}")
        relative(step["from"], f"extract[{i}].from")
        relative(step["into"], f"extract[{i}].into")
        if not isinstance(step["match"], str) or not step["match"]:
            fail(f"{root}/pack.json: extract[{i}].match must be a non-empty string")
    avatar = read_json(os.path.join(root, "avatar.json"))
    profile = read_json(os.path.join(root, "export.json"))
    plain_names(avatar, f"{root}/avatar.json")
    prefix = f"{RESOURCE}/{pack_id}/"
    head = [RESOURCE, pack_id]
    for key, path in profile_paths(profile) + [("textures", profile.get("textures"))]:
        if not isinstance(path, str):
            continue
        relative(path, f"{root}/export.json: {key}")
        if path.split("/")[:2] != head or path.split("/")[2:] == []:
            fail(f"{root}/export.json: {key} must be under {prefix}, got {path!r}")
    return pack, avatar, profile


def profile_paths(profile):
    """Every path in an export profile that has to come out of the package."""
    paths = [("source", profile.get("source"))]
    paths += [(f"extras[{i}]", p) for i, p in enumerate(profile.get("extras") or [])]
    if "textures_src" in profile:
        paths.append(("textures_src", profile["textures_src"]))
    return [(key, path) for key, path in paths if isinstance(path, str)]


def list_packs(packs):
    ids = sorted(name for name in os.listdir(packs)
                 if os.path.isfile(os.path.join(packs, name, "pack.json")))
    for pack_id in ids:
        pack, avatar, _ = load_pack(packs, pack_id)
        label = avatar.get("label", {}).get("en", pack_id)
        author = (avatar.get("author") or {}).get("en", "?")
        files = ", ".join(entry["file"] for entry in pack["packages"])
        print(f"  {pack_id:12} {label} by {author}")
        print(f"  {'':12} {pack['store']}  ({files})")
    print("usage: make import PACK=<id> PACKAGE=<path to the zip>")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def place(source, target):
    """Copy a pack file into avatars/, refusing to overwrite a different one."""
    with open(source, "rb") as f:
        data = f.read()
    if os.path.exists(target):
        with open(target, "rb") as f:
            if f.read() == data:
                return
        fail(f"{target} already exists and differs from {source}; move it aside to re-import")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as f:
        f.write(data)
    print(f"wrote {target}")


def import_pack(packs, pack_id, package, avatars):
    pack, _, profile = load_pack(packs, pack_id)
    package = os.path.expanduser(package)
    if not os.path.isfile(package):
        fail(f"no package at {package}")
    digest = sha256(package)
    if any(entry["sha256"] == digest for entry in pack["packages"]):
        print(f"verified package {os.path.basename(package)}")
    else:
        files = ", ".join(entry["file"] for entry in pack["packages"])
        print(f"warning: {os.path.basename(package)} is not a package this pack was verified "
              f"with ({files}); importing anyway", file=sys.stderr)

    dest = os.path.join(RESOURCE, pack_id)
    if os.path.exists(dest):
        fail(f"{dest} already exists; move it aside to re-import")
    os.makedirs(dest)
    try:
        with zipfile.ZipFile(package) as archive:
            # ZipFile.extractall drops absolute paths and '..' from member names.
            archive.extractall(dest)
    except zipfile.BadZipFile as e:
        fail(f"{package} is not a zip: {e}")
    print(f"unpacked {package} -> {dest}")

    for step in pack["extract"]:
        source = os.path.join(dest, step["from"])
        if not os.path.isfile(source):
            fail(f"the package has no {step['from']}: is it the one this pack is for?")
        subprocess.run([sys.executable, "-I", EXTRACT, source,
                        os.path.join(dest, step["into"]), step["match"]], check=True)

    missing = [path for _, path in profile_paths(profile) if not os.path.exists(path)]
    if missing:
        fail(f"the package does not contain {', '.join(missing)}: is it the one this pack is for?")

    place(os.path.join(packs, pack_id, "avatar.json"), os.path.join(avatars, f"{pack_id}.json"))
    place(os.path.join(packs, pack_id, "export.json"),
          os.path.join(avatars, "export", f"{pack_id}.json"))


def main(argv):
    if len(argv) == 1:
        list_packs(argv[0])
    elif len(argv) == 4:
        import_pack(*argv)
    else:
        fail(__doc__.split("\n\n")[1])


if __name__ == "__main__":
    main(sys.argv[1:])
