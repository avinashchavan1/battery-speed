#!/bin/bash
# Builds the macOS app (menu bar readout + dashboard window) into
# dist/Battery Speed.app, as a universal binary (Apple Silicon + Intel) where
# the installed Xcode can build both. The result is shipped with the package,
# so other Macs need no compiler.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Battery Speed.app"
BIN="$APP/Contents/MacOS/BatterySpeedMenu"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# App icon: draw the 1024px master, then every size macOS asks for.
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
xcrun swift "$ROOT/scripts/make-icon.swift" "$TMP/icon-1024.png" >/dev/null
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$TMP/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$TMP/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Battery Speed</string>
  <key>CFBundleDisplayName</key>
  <string>Battery Speed</string>
  <key>CFBundleIdentifier</key>
  <string>com.batteryspeed.app</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleVersion</key>
  <string>5</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.utilities</string>
  <key>CFBundleExecutable</key>
  <string>BatterySpeedMenu</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.3.2</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>Battery Speed checks when your next event starts, to warn you if the battery won't last until it ends. Event details stay on this Mac.</string>
  <key>NSCalendarsUsageDescription</key>
  <string>Battery Speed checks when your next event starts, to warn you if the battery won't last until it ends. Event details stay on this Mac.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

build() { # build <arch>
  xcrun swiftc -O -swift-version 5 -framework AppKit -framework WebKit -framework EventKit \
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
