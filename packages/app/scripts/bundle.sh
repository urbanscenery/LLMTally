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

REPO_ROOT="$(cd ../.. && pwd)"
KEYCHAIN_HELPER="$REPO_ROOT/packages/core/native/bin/darwin-universal/llmtally-keychain"
bun "$REPO_ROOT/scripts/build-keychain-helper.ts"
bun "$REPO_ROOT/scripts/build-keychain-helper.ts" --check
if [ ! -x "$KEYCHAIN_HELPER" ]; then
  echo "bundle: keychain helper is missing or not executable" >&2
  exit 1
fi

# macOS 27's Command Line Tools ship no SwiftUI macro plugin, and @State
# is a macro since the 27 SDK — so a bare CLT toolchain cannot expand it
# ("plugin for module 'SwiftUIMacros' not found"). Borrow Xcode's own
# SDK + plugin server (they must match: a 26.x plugin against the 27 SDK
# fails on `_makeStorage_v0`). Nothing here goes through xcrun, so an
# unaccepted Xcode license does not block the build.
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"
if [ ! -f "$DEV_DIR/usr/lib/swift/host/plugins/libSwiftUIMacros.dylib" ] &&
   [ ! -f "$DEV_DIR/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins/libSwiftUIMacros.dylib" ]; then
  XCODE_DEV="${LLMTALLY_XCODE_DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
  XCODE_PLUGINS="$XCODE_DEV/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins"
  XCODE_PLUGIN_SERVER="$XCODE_DEV/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-plugin-server"
  XCODE_SDK="$XCODE_DEV/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
  if [ -f "$XCODE_PLUGINS/libSwiftUIMacros.dylib" ] && [ -x "$XCODE_PLUGIN_SERVER" ] && [ -d "$XCODE_SDK" ]; then
    echo "bundle: active toolchain ($DEV_DIR) lacks the SwiftUI macro plugin; building with the SDK and plugin server from $XCODE_DEV" >&2
    export SDKROOT="$XCODE_SDK"
    set -- -Xswiftc -external-plugin-path -Xswiftc "$XCODE_PLUGINS#$XCODE_PLUGIN_SERVER"
  else
    echo "bundle: the active Swift toolchain has no SwiftUI macro plugin and no Xcode.app to borrow one from (set LLMTALLY_XCODE_DEVELOPER_DIR)" >&2
    exit 1
  fi
fi
swift build -c release --package-path macos "$@"
bun build --compile src/sidecar-main.ts --outfile build/llmtally-sidecar
# bun 1.3.x leaks its ~60MB .{hash}.bun-build temp in cwd even on success
rm -f ./.*.bun-build

APP=build/LLMTally.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Helpers"
cp macos/.build/release/LLMTallyBar "$APP/Contents/MacOS/LLMTally"
cp assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp build/llmtally-sidecar "$APP/Contents/Helpers/llmtally-sidecar"
cp "$KEYCHAIN_HELPER" "$APP/Contents/Helpers/llmtally-keychain"

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

codesign --force -s - "$APP/Contents/Helpers/llmtally-keychain"
codesign --force -s - "$APP/Contents/Helpers/llmtally-sidecar"
codesign --force -s - "$APP"
codesign --verify --deep --strict "$APP"
echo "built $APP (self-contained sidecar and keychain helper embedded)"
echo "run:  open $APP"
