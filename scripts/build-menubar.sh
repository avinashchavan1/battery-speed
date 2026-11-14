#!/bin/bash
# Compiles the macOS menu bar app into dist/Battery Speed.app, as a universal
# binary (Apple Silicon + Intel) where the installed Xcode can build both.
# The result is shipped with the package, so other Macs need no compiler.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Battery Speed.app"
BIN="$APP/Contents/MacOS/BatterySpeedMenu"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Battery Speed</string>
  <key>CFBundleIdentifier</key>
  <string>com.batteryspeed.menubar</string>
  <key>CFBundleExecutable</key>
  <string>BatterySpeedMenu</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

build() { # build <arch>
  xcrun swiftc -O -swift-version 5 -framework AppKit \
    -target "$1-apple-macos13.0" -o "$TMP/menu-$1" "$ROOT/menubar/main.swift"
}

build arm64
if build x86_64 2>/dev/null; then
  lipo -create "$TMP/menu-arm64" "$TMP/menu-x86_64" -output "$BIN"
  echo "Built universal binary (Apple Silicon + Intel)"
else
  cp "$TMP/menu-arm64" "$BIN"
  echo "Built Apple Silicon binary only (this Xcode cannot target Intel)"
fi

codesign --force --sign - "$APP" >/dev/null 2>&1
echo "Built $APP"
