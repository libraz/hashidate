"""Pull the textures out of a unitypackage.

A .unitypackage is a gzip-compressed tar holding, for every asset, the pair
  <guid>/asset      … the file itself
  <guid>/pathname   … its path inside the Unity project
The order is not guaranteed, so it is walked in 2 passes.

usage: python3 extract_textures.py <pkg> <outdir> [substring the path must contain]
"""
import os
import sys
import tarfile

pkg = sys.argv[1]
out = sys.argv[2]
needle = sys.argv[3] if len(sys.argv) > 3 else "/Texture_1K/"

os.makedirs(out, exist_ok=True)

# pass 1: guid -> Unity path
paths = {}
with tarfile.open(pkg, "r|gz") as tf:
    for m in tf:
        if m.name.endswith("/pathname"):
            guid = m.name.split("/")[0]
            paths[guid] = tf.extractfile(m).read().decode("utf-8").split("\n")[0]

want = {g: p for g, p in paths.items()
        if needle in p and p.lower().endswith((".png", ".tga"))}
print(f"selected {len(want)} / {len(paths)} assets in total")

# pass 2: write the files out
got = 0
with tarfile.open(pkg, "r|gz") as tf:
    for m in tf:
        if not m.name.endswith("/asset"):
            continue
        guid = m.name.split("/")[0]
        if guid not in want:
            continue
        dst = os.path.join(out, os.path.basename(want[guid]))
        with open(dst, "wb") as f:
            f.write(tf.extractfile(m).read())
        got += 1
print(f"extracted {got} files -> {out}")
