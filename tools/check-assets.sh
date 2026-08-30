#!/usr/bin/env bash
#
# Fail if anything large is tracked/staged or untracked and not ignored.
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
# fix. Keep this list separate from untracked files so the diagnosis says what
# git actually knows about each path.
mapfile -t tracked < <(git ls-files -c --deduplicate)
mapfile -t untracked < <(git ls-files -o --exclude-standard --deduplicate)

tracked_over=()
for f in "${tracked[@]}"; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f")
  if [ "$size" -gt "$MAX" ]; then
    tracked_over+=("$(printf '%10d  %s' "$size" "$f")")
  fi
done

untracked_over=()
for f in "${untracked[@]}"; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f")
  if [ "$size" -gt "$MAX" ]; then
    untracked_over+=("$(printf '%10d  %s' "$size" "$f")")
  fi
done

failed=0
if [ ${#tracked_over[@]} -gt 0 ]; then
  echo "tracked files over $((MAX / 1024)) KiB:" >&2
  printf '%s\n' "${tracked_over[@]}" >&2
  echo >&2
  echo "put resources in backup/resource/ and generated files in public/models/" >&2
  echo "(both are already in .gitignore)." >&2
  failed=1
fi

if [ ${#untracked_over[@]} -gt 0 ]; then
  echo "untracked non-ignored files over $((MAX / 1024)) KiB:" >&2
  printf '%s\n' "${untracked_over[@]}" >&2
  echo >&2
  echo "remove these untracked files before committing or move them under an ignored asset directory." >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "no tracked file over $((MAX / 1024)) KiB (${#tracked[@]} checked)"
echo "no untracked non-ignored file over $((MAX / 1024)) KiB (${#untracked[@]} checked)"
