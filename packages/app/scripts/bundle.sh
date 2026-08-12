#!/bin/sh
# Builds packages/app/build/LLMTally.app from the SwiftPM release binary
# plus the fixed icon. Ad-hoc signed; the bundle id unlocks
# UserNotifications and SMAppService (launch at login).
#
# Dev-machine bundle: the sidecar still resolves to this checkout's
# packages/app/src/sidecar-main.ts (compile-time #filePath fallback,
# override with LLMTALLY_SIDECAR) and bun is probed at the usual
# install paths. A distributable bundle would embed both; that is a
# later phase.
set -eu
cd "$(dirname "$0")/.."

swift build -c release --package-path macos

APP=build/LLMTally.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macos/.build/release/LLMTallyBar "$APP/Contents/MacOS/LLMTally"
cp assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>LLMTally</string>
    <key>CFBundleDisplayName</key><string>LLMTally</string>
    <key>CFBundleIdentifier</key><string>com.urbanscenery.llmtally</string>
    <key>CFBundleExecutable</key><string>LLMTally</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force -s - "$APP"
echo "built $APP"
echo "run:  open $APP"
