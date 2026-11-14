# Battery Speed

Live battery stats, charging speed and time left, in an animated dashboard that
runs on your own computer. Works on macOS, Windows and Linux laptops.

- **See power move.** Charger, laptop and battery drawn as a live scene, with
  dots flowing wherever the watts are going.
- **Know the time left.** Time until empty or full, learned from how your own
  battery charges.
- **Catch a weak charger.** Tells you when you are plugged in but still draining.
- **Alerts.** Desktop notifications for low battery, a charger that can't keep
  up, and reaching 80%.
- **History.** Charge and power charts from 15 minutes to 7 days, kept locally.
- **Battery health.** Capacity compared with new, cycle count, and the trend.
- **Private.** Everything stays on your computer. The one exception is the
  optional AI summary, which only runs when you press its button.

## Install

You need [Node.js](https://nodejs.org) 22.13 or newer. Nothing else.

### The quick way (any system)

```
npm install -g github:avinashchavan1/battery-speed
battery-speed install
```

`install` makes it start at login, keeps it recording in the background, and
prints the dashboard address (http://localhost:4780).

To update later, run the first command again. To try it without keeping it
running, use `battery-speed start --open` instead of `install`.

### Without installing anything

[Download the folder](https://github.com/avinashchavan1/battery-speed/archive/refs/heads/main.zip),
unzip it, and double-click the launcher for your system:

| System  | Launcher                     |
| ------- | ---------------------------- |
| macOS   | `Start Battery Speed.command` |
| Windows | `start.bat`                  |
| Linux   | `./start.sh`                 |

This runs it until you close the window. For the optional AI summary, run
`npm install` in the folder once.

## Commands

```
battery-speed start        Run in this terminal (add --open to open the dashboard)
battery-speed install      Start at login and record in the background
battery-speed uninstall    Remove start-at-login and stop the background copy
battery-speed status       Is it running? Current reading, data folder
battery-speed open         Open the dashboard
battery-speed key          Save a Claude API key for the AI summary
```

`--port <n>` runs on another port. Uninstalling keeps your saved history.

## What each system can show

Operating systems expose different amounts of battery data. The dashboard
adapts and never shows a number it does not have.

| Feature                              | Mac (Apple Silicon) | Mac (Intel) | Windows | Linux |
| ------------------------------------ | :-----------------: | :---------: | :-----: | :---: |
| Charge, time left, charging speed    | yes | yes | yes | yes |
| Plugged-in-but-draining warning      | yes | yes | yes | yes |
| History charts, alerts, health trend | yes | yes | yes | yes |
| Watts from the charger, total draw   | yes | no  | no  | no  |
| Charger's rated watts                | yes | yes | no  | USB-C only |
| Per-app ranking                      | energy impact | energy impact | CPU use | CPU use |
| Cycle count                          | yes | yes | most laptops | most laptops |
| Menu bar readout                     | yes | yes | no  | no  |

Where "watts from the charger" is not available, the power chart shows what
flows into and out of the battery instead.

The Windows and Linux readers are covered by automated tests against
representative data, but have not yet been run on real Windows or Linux
hardware. If something looks wrong there, `battery-speed status` and the log
in the data folder are the places to look.

## The AI summary (optional)

Press "Write summary" and Claude reads the last 24 hours and tells you, in
plain language, what happened and what to do about it. Pressing the button
sends battery numbers, alert titles and the names of your busiest apps to the
Claude API. Nothing is sent at any other time.

To switch it on, run `battery-speed key` and paste a Claude API key. The key is
stored in your data folder, readable only by you. `battery-speed key --clear`
removes it.

## Where things are kept

| System  | Data folder                                      |
| ------- | ------------------------------------------------ |
| macOS   | `~/Library/Application Support/Battery Speed`    |
| Windows | `%LOCALAPPDATA%\Battery Speed`                   |
| Linux   | `~/.local/share/battery-speed`                   |

It holds the history database, your settings and the log. Delete the folder to
erase everything. The dashboard is only reachable from your own computer.

## Development

```
npm install
npm test                 # platform parsing tests
npm start                # run and open the dashboard
npm run build:menubar    # rebuild the macOS menu bar app (needs Xcode)
```

`BATTERY_SIMULATE=limited` makes a Mac report only what Windows and Linux can,
which is how the reduced dashboard is checked.

## License

[MIT](LICENSE)
