#!/bin/bash
# Double-click to run Battery Speed on macOS.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Battery Speed needs Node.js 22.13 or newer."
  echo "Install it from https://nodejs.org, then double-click this file again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
exec node bin/battery-speed.js start --open
