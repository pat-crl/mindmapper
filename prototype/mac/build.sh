#!/bin/bash
set -euo pipefail

mac_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
prototype_dir="$(dirname "$mac_dir")"
repo_root="$(dirname "$prototype_dir")"
output_dir="${1:-"$repo_root/builds/mindmapper-prototype"}"
mkdir -p "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"
app_name="Mind Mapper Prototype.app"
destination="$output_dir/$app_name"
bundle_id="au.pcarroll.mindmapper.prototype"

if [[ -e "$destination" || -L "$destination" ]]; then
  existing_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$existing_id" != "$bundle_id" || -L "$destination" ]]; then
    echo "A different bundle already exists at $destination." >&2
    exit 1
  fi
fi

stage_dir="$(mktemp -d "$output_dir/.mindmapper-build.XXXXXX")"
previous="$stage_dir/Previous.app"
cleanup() {
  if [[ -e "$previous" && ! -e "$destination" ]]; then
    if ! mv "$previous" "$destination"; then
      echo "The previous build is recoverable at $previous." >&2
      return
    fi
  fi
  rm -rf "$stage_dir"
}
trap cleanup EXIT
app="$stage_dir/$app_name"
contents="$app/Contents"
web="$contents/Resources/Web"
mkdir -p "$contents/MacOS" "$web/prototype" "$web/src"

cp "$mac_dir/Info.plist" "$contents/Info.plist"
cp "$mac_dir/Resources/AppIcon.icns" "$contents/Resources/AppIcon.icns"
cp "$repo_root/src/model.js" "$web/src/model.js"
cp "$prototype_dir/index.html" "$web/prototype/index.html"
for asset in "$prototype_dir"/*.js "$prototype_dir"/*.css; do
  if [[ -f "$asset" ]]; then cp "$asset" "$web/prototype/"; fi
done

xcrun swiftc -target "$(uname -m)-apple-macosx14.5" \
  "$mac_dir/MindMapperPrototype.swift" "$mac_dir/WebEditor.swift" "$mac_dir/DocumentStore.swift" \
  "$mac_dir/FigurePDF.swift" "$mac_dir/FigureShare.swift" \
  -o "$contents/MacOS/MindMapperPrototype"
/usr/bin/plutil -lint "$contents/Info.plist" >&2
/usr/bin/codesign --force --sign - --timestamp=none "$app" >&2
/usr/bin/codesign --verify --strict "$app"

if [[ -e "$destination" ]]; then mv "$destination" "$previous"; fi
mv "$app" "$destination"
printf '%s\n' "$destination"
