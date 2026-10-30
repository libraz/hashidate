#!/usr/bin/env bash
#
# Run `cargo test -p hashidate-core -- <filter>` for each filter and fail unless every filter
# matched at least one test. `cargo test` succeeds when a filter matches nothing, which would let a
# misspelled filter pass; this script counts the `N passed` of every `test result:` line instead.
#
# usage: tools/rust-core/test-min.sh <filter>...
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <filter>..." >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"

status=0
for filter in "$@"; do
  output=$(CARGO_BUILD_JOBS=2 nice -n 10 cargo test -p hashidate-core -- "$filter" 2>&1) || {
    printf '%s\n' "$output"
    echo "FAIL: cargo test failed for filter '$filter'" >&2
    exit 1
  }
  passed=$(printf '%s\n' "$output" \
    | sed -n 's/^test result: ok\. \([0-9][0-9]*\) passed.*/\1/p' \
    | awk '{ sum += $1 } END { print sum + 0 }')
  if [ "$passed" -lt 1 ]; then
    echo "FAIL: filter '$filter' matched no test" >&2
    status=1
  else
    echo "ok: filter '$filter' ran $passed test(s)"
  fi
done
exit "$status"
