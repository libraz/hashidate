#!/usr/bin/env bash
#
# Fail if anything large has been committed or staged.
#
# This project sits next to 1.5 GB of purchased avatar assets — a 533 MB
# unitypackage, 250 MB of 4K textures, 46 MB of FBX. .gitignore keeps them out,
# but a .gitignore is a list of the paths someone thought of, and a single
# `git add -f` or a new directory nobody anticipated is enough to put a
# half-gigabyte blob in the history permanently. Measuring what git is actually
# tracking is the check that cannot be defeated by a path nobody predicted.
#
# usage: tools/check-assets.sh [max-bytes]
set -euo pipefail

MAX=${1:-1048576}   # 1 MiB. Nothing this repo legitimately tracks comes close.

cd "$(git rev-parse --show-toplevel)"

# Both the index and the working tree copies of tracked files: a file staged but
# not yet committed is already a problem, and is the moment it is still cheap to
# fix.
mapfile -t tracked < <(git ls-files -c -o --exclude-standard --deduplicate 2>/dev/null || git ls-files)

over=()
for f in "${tracked[@]}"; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f")
  if [ "$size" -gt "$MAX" ]; then
    over+=("$(printf '%10d  %s' "$size" "$f")")
  fi
done

if [ ${#over[@]} -gt 0 ]; then
  echo "追跡対象に $((MAX / 1024)) KiB を超えるファイルがある:" >&2
  printf '%s\n' "${over[@]}" >&2
  echo >&2
  echo "リソースは backup/resource/ に、生成物は public/models/ に置くこと" >&2
  echo "（どちらも .gitignore 済み）。" >&2
  exit 1
fi

echo "追跡対象に $((MAX / 1024)) KiB 超のファイルなし（${#tracked[@]} 件を検査）"
