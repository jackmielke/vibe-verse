#!/bin/bash
# Ship a new build of the Vibe Verse iOS shell to TestFlight (internal testers get it on processing).
# API key only: no Apple web login needed. Usage: scripts/ship.sh [--submit]
#   --submit  also attach to the open App Store version and submit for review.
# Web content needs no new build at all: it loads myvibeverse.com live.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=6818036854
ISS=30502701-dad4-4788-9777-3a7c61beeac5
K=(-allowProvisioningUpdates -authenticationKeyPath "$HOME/.appstoreconnect/private_keys/AuthKey_D64LNK6B96.p8" -authenticationKeyID D64LNK6B96 -authenticationKeyIssuerID $ISS)
VERSION=$(grep MARKETING_VERSION project.yml | sed -E 's/.*"(.*)".*/\1/')
LAST=$(~/.local/bin/asc builds list --app $APP 2>/dev/null | python3 -c "import json,sys;print(max([int(b['attributes']['version']) for b in json.load(sys.stdin)['data']] or [0]))")
NEXT=$((LAST + 1))
sed -i '' -E "s/CURRENT_PROJECT_VERSION: \"[0-9]+\"/CURRENT_PROJECT_VERSION: \"$NEXT\"/" project.yml
xcodegen generate -q
rm -rf build/VibeVerse.xcarchive build/export
xcodebuild -project VibeVerse.xcodeproj -scheme VibeVerse -configuration Release -destination 'generic/platform=iOS' -archivePath build/VibeVerse.xcarchive archive "${K[@]}" -quiet
xcodebuild -exportArchive -archivePath build/VibeVerse.xcarchive -exportPath build/export -exportOptionsPlist scripts/ExportOptions.plist "${K[@]}" 2>&1 | grep -E "error|EXPORT|Upload succeeded"
echo "==> Uploaded $VERSION ($NEXT). Waiting for processing..."
until [ "$(~/.local/bin/asc builds list --app $APP 2>/dev/null | python3 -c "import json,sys;print(next((b['attributes']['processingState'] for b in json.load(sys.stdin)['data'] if b['attributes']['version']=='$NEXT'),''))")" = VALID ]; do sleep 30; done
echo "==> Build $NEXT is on TestFlight for Internal Testers."
if [ "${1:-}" = "--submit" ]; then
  BID=$(~/.local/bin/asc builds list --app $APP | python3 -c "import json,sys;print(next(b['id'] for b in json.load(sys.stdin)['data'] if b['attributes']['version']=='$NEXT'))")
  ~/.local/bin/asc review submit --app $APP --version "$VERSION" --build-id "$BID" --confirm
fi
