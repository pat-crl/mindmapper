#!/bin/bash
set -euo pipefail

mac_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(cd -- "$mac_dir/../.." && pwd)"
output_dir="${1:-"$repo_root/builds/mindmapper-release"}"
identity="${MINDMAPPER_SIGN_IDENTITY:?Set MINDMAPPER_SIGN_IDENTITY to a Developer ID Application identity.}"
profile="${MINDMAPPER_NOTARY_PROFILE:?Set MINDMAPPER_NOTARY_PROFILE to an existing notarytool Keychain profile.}"
mkdir -p "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"
version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$mac_dir/Info.plist")"
stage="$(mktemp -d "$output_dir/.mindmapper-package.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

notarize() {
  xcrun notarytool submit "$1" --keychain-profile "$profile" --wait --output-format json \
    | tee "$stage/notary-result.json" >&2
  [[ "$(/usr/bin/plutil -extract status raw "$stage/notary-result.json")" == "Accepted" ]]
}

app="$(MINDMAPPER_UNIVERSAL=1 MINDMAPPER_SIGN_IDENTITY="$identity" "$mac_dir/build.sh" "$stage")"
/usr/bin/ditto -c -k --keepParent "$app" "$stage/Mind Mapper.zip"
notarize "$stage/Mind Mapper.zip"
xcrun stapler staple "$app" >&2
xcrun stapler validate "$app" >&2
/usr/sbin/spctl --assess --type execute --verbose "$app"

image_contents="$stage/Image Contents"
mkdir "$image_contents"
/usr/bin/ditto "$app" "$image_contents/Mind Mapper.app"
ln -s /Applications "$image_contents/Applications"
image="$stage/Mind Mapper $version.dmg"
/usr/bin/hdiutil create -quiet -fs HFS+ -format UDZO -volname "Mind Mapper" -srcfolder "$image_contents" "$image"
/usr/bin/codesign --force --sign "$identity" --timestamp "$image" >&2
notarize "$image"
xcrun stapler staple "$image" >&2
xcrun stapler validate "$image" >&2
/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose "$image"
mv -f "$image" "$output_dir/$(basename "$image")"
printf '%s\n' "$output_dir/$(basename "$image")"
