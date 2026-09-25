#!/usr/bin/env bash
# Archive Hoshimura and upload it to App Store Connect, where it becomes a
# TestFlight build a few minutes later.
#
#   TEAM_ID=ABCDE12345 ./ios/scripts/testflight.sh
#
# Needs: a Mac with Xcode 16+, signed in to your Apple ID in Xcode
# (Settings > Accounts), a paid Apple Developer membership, and the app
# record created in App Store Connect with bundle id com.myvibeverse.hoshimura.
set -euo pipefail

if [[ -z "${TEAM_ID:-}" ]]; then
  echo "Set TEAM_ID to your 10-character Apple team id (developer.apple.com/account, Membership details)." >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$HERE/build"
# Every upload needs a build number App Store Connect has not seen; the
# clock always gives one.
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"

rm -rf "$BUILD"
mkdir -p "$BUILD"

echo "Archiving build $BUILD_NUMBER for team $TEAM_ID"
xcodebuild archive \
  -project "$HERE/Hoshimura.xcodeproj" \
  -scheme Hoshimura \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$BUILD/Hoshimura.xcarchive" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER"

cp "$HERE/ExportOptions.plist" "$BUILD/ExportOptions.plist"
plutil -replace teamID -string "$TEAM_ID" "$BUILD/ExportOptions.plist"

echo "Uploading to App Store Connect"
xcodebuild -exportArchive \
  -archivePath "$BUILD/Hoshimura.xcarchive" \
  -exportOptionsPlist "$BUILD/ExportOptions.plist" \
  -exportPath "$BUILD/export" \
  -allowProvisioningUpdates

echo
echo "Uploaded build $BUILD_NUMBER. It shows up under TestFlight in App Store Connect"
echo "once Apple finishes processing it (usually 5 to 15 minutes)."
