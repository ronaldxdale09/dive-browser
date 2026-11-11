#!/usr/bin/env bash
# Shows what Dive changed in the vendored tauri-runtime-cef relative to the
# upstream revision it is pinned to (see vendor/tauri-runtime-cef/UPSTREAM.md).
# Writes the full patch to target/vendor-runtime.patch and prints a summary.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

upstream="$(cargo metadata --format-version 1 | python3 -c '
import json,sys,os
m=json.load(sys.stdin)
p=[x for x in m["packages"] if x["name"]=="tauri-runtime" and (x.get("source") or "").startswith("git+https://github.com/tauri-apps/tauri")]
print(os.path.join(os.path.dirname(os.path.dirname(p[0]["manifest_path"])), "tauri-runtime-cef"))')"
[[ -d "${upstream}/src" ]] || { echo "upstream checkout not found; run cargo fetch" >&2; exit 1; }

mkdir -p target
diff -ruN "${upstream}/src" vendor/tauri-runtime-cef/src > target/vendor-runtime.patch || true
echo "upstream: ${upstream}"
echo "added files:"
diff -rq "${upstream}/src" vendor/tauri-runtime-cef/src | sed -n 's|^Only in vendor/tauri-runtime-cef/src\(.*\): \(.*\)|  src\1/\2|p' || true
echo "modified files:"
diff -rq "${upstream}/src" vendor/tauri-runtime-cef/src | sed -n 's|^Files .* and vendor/tauri-runtime-cef/src/\(.*\) differ$|  src/\1|p' || true
modified="$(diff -ru "${upstream}/src" vendor/tauri-runtime-cef/src || true)"
echo "changed lines in modified upstream files: +$(grep -c '^+[^+]' <<<"${modified}" || true) -$(grep -c '^-[^-]' <<<"${modified}" || true)"
echo "full patch: target/vendor-runtime.patch"
