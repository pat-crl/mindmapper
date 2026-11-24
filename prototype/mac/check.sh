#!/bin/bash
set -euo pipefail

mac_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(cd -- "$mac_dir/../.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/mindmapper-mac-check.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
target="$(uname -m)-apple-macosx14.5"

xcrun swiftc -target "$target" "$mac_dir/DocumentStore.swift" "$mac_dir/tests/StoreChecks.swift" -o "$test_dir/StoreChecks"
"$test_dir/StoreChecks"
if [[ "${1:-}" == "--store-only" ]]; then exit 0; fi

app="${1:-"$repo_root/builds/mindmapper/Mind Mapper.app"}"
if [[ $# -ge 2 ]]; then
  cp "$2" "$test_dir/Legacy.mindmap"
else
  node - "$repo_root/src/model.js" > "$test_dir/Legacy.mindmap" <<'JS'
const legacy = require(process.argv[2]);
const map = legacy.createMap('Field notes');
map.data.nodes[map.data.rootId].text = 'Legacy fixture';
const child = legacy.add(map.data, map.data.rootId, 'child', 'right');
map.data.nodes[child].text = 'Imported idea';
process.stdout.write(JSON.stringify({ version: 1, activeMapId: map.id, maps: [map] }));
JS
fi
xcrun swiftc -target "$target" "$mac_dir/DocumentStore.swift" "$mac_dir/WebEditor.swift" \
  "$mac_dir/FigurePDF.swift" "$mac_dir/FigureShare.swift" \
  "$mac_dir/tests/WebBridgeChecks.swift" -o "$test_dir/WebBridgeChecks"
"$test_dir/WebBridgeChecks" "$app/Contents/Resources/Web" "$test_dir" "$test_dir/Legacy.mindmap"
