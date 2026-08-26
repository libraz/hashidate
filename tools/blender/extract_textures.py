"""unitypackage からテクスチャを取り出す。

.unitypackage は gzip 圧縮 tar で、アセットごとに
  <guid>/asset      … ファイル実体
  <guid>/pathname   … Unity プロジェクト上のパス
の対を持つ。順序が保証されないため 2 パスで走査する。

usage: python3 extract_textures.py <pkg> <出力先> [パスに含む文字列]
"""
import os
import sys
import tarfile

pkg = sys.argv[1]
out = sys.argv[2]
needle = sys.argv[3] if len(sys.argv) > 3 else "/Texture_1K/"

os.makedirs(out, exist_ok=True)

# pass 1: guid -> Unity パス
paths = {}
with tarfile.open(pkg, "r|gz") as tf:
    for m in tf:
        if m.name.endswith("/pathname"):
            guid = m.name.split("/")[0]
            paths[guid] = tf.extractfile(m).read().decode("utf-8").split("\n")[0]

want = {g: p for g, p in paths.items()
        if needle in p and p.lower().endswith((".png", ".tga"))}
print(f"対象 {len(want)} / 全アセット {len(paths)}")

# pass 2: 実体を書き出す
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
print(f"抽出 {got} ファイル -> {out}")
