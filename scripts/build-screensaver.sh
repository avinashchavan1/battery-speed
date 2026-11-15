#!/bin/bash
# Builds the macOS screen saver into dist/Battery Speed.saver, as a universal
# bundle (Apple Silicon + Intel) where the installed Xcode can build both.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SAVER="$ROOT/dist/Battery Speed.saver"
BIN="$SAVER/Contents/MacOS/BatterySpeedSaver"
SOURCE="$ROOT/screensaver/BatterySpeedSaver.swift"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$SAVER/Contents/MacOS"

cat > "$SAVER/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Battery Speed</string>
  <key>CFBundleDisplayName</key>
  <string>Battery Speed</string>
  <key>CFBundleIdentifier</key>
  <string>com.batteryspeed.saver</string>
  <key>CFBundleExecutable</key>
  <string>BatterySpeedSaver</string>
  <key>CFBundlePackageType</key>
  <string>BNDL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.3.0</string>
  <key>CFBundleVersion</key>
  <string>4</string>
  <key>NSPrincipalClass</key>
  <string>BatterySpeedSaverView</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
EOF

# A screen saver is a loadable bundle, so compile to an object file and link
# it as one (swiftc on its own only produces executables and dynamic libraries).
build() { # build <arch>
  local target="$1-apple-macos13.0"
  xcrun swiftc -O -swift-version 5 -parse-as-library -module-name BatterySpeedSaver \
    -target "$target" -emit-object -o "$TMP/saver-$1.o" "$SOURCE"
  xcrun clang -bundle -target "$target" -isysroot "$SDK" \
    -L "$SDK/usr/lib/swift" -L /usr/lib/swift -Xlinker -rpath -Xlinker /usr/lib/swift \
    -framework ScreenSaver -framework AppKit -framework IOKit \
    -o "$TMP/saver-$1" "$TMP/saver-$1.o"
}

build arm64
if build x86_64 2>/dev/null; then
  lipo -create "$TMP/saver-arm64" "$TMP/saver-x86_64" -output "$BIN"
  echo "Built universal bundle (Apple Silicon + Intel)"
else
  cp "$TMP/saver-arm64" "$BIN"
  echo "Built Apple Silicon bundle only (this Xcode cannot target Intel)"
fi

codesign --force --sign - "$SAVER" >/dev/null 2>&1
echo "Built $SAVER"
