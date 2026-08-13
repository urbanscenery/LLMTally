#!/bin/sh
# Builds packages/app/build/LLMTally.app from the SwiftPM release binary
# plus the fixed icon AND a self-contained sidecar (bun build --compile)
# so the bundle needs no bun install and no repo checkout at runtime.
# Ad-hoc signed; the bundle id unlocks UserNotifications and
# SMAppService (launch at login).
set -eu
cd "$(dirname "$0")/.."

# keep the Swift theme catalog in lockstep with the shared presets
bun scripts/gen-theme-presets.ts

swift build -c release --package-path macos
bun build --compile src/sidecar-main.ts --outfile build/llmtally-sidecar

APP=build/LLMTally.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macos/.build/release/LLMTallyBar "$APP/Contents/MacOS/LLMTally"
cp assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
mkdir -p "$APP/Contents/Helpers"
cp build/llmtally-sidecar "$APP/Contents/Helpers/llmtally-sidecar"

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

codesign --force -s - "$APP/Contents/Helpers/llmtally-sidecar"
codesign --force -s - "$APP"
echo "built $APP (self-contained sidecar embedded)"
echo "run:  open $APP"
