#!/bin/sh
# Run Battery Speed on Linux or macOS:  ./start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Battery Speed needs Node.js 22.13 or newer. Install it from https://nodejs.org and run this again."
  exit 1
fi
exec node bin/battery-speed.js start --open
