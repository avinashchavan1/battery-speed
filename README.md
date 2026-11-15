# Battery Speed

Live battery stats, charging speed and time left, in an animated dashboard that
runs on your own computer. Works on macOS, Windows and Linux laptops.

- **See power move.** Charger, laptop and battery drawn as a live scene, with
  dots flowing wherever the watts are going.
- **Know the time left.** Time until empty or full, learned from how your own
  battery charges.
- **Catch a weak charger.** Tells you when you are plugged in but still draining.
- **Energy-hog alert.** When one app uses most of the energy for a few minutes
  while the battery drains, you are told which one and roughly what it costs,
  for example "quitting it would add about 2 hours of battery".
- **Charger memory.** Remembers every charger you plug in and whether it kept
  up. Plug in one that fell short before and you are warned straight away,
  with the size of charger that would keep up.
- **Alerts.** Desktop notifications for low battery, a charger that can't keep
  up, and reaching 80%.
- **History.** Charge and power charts from 15 minutes to 7 days, kept locally.
- **Battery health.** Capacity compared with new, cycle count, and the trend.
- **A real Mac app.** On macOS it installs into Applications, with its own
  window, a Dock icon while open, and a live readout in the menu bar.
- **A screen saver for the locked screen.** Charge, state and time left on a
  black screen, redrawn twice a minute so it costs next to nothing.
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
prints the dashboard address (http://localhost:4780). On a Mac it also puts
**Battery Speed** in your Applications folder: open it from Launchpad or
Spotlight like any other app.

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
battery-speed screensaver  macOS: open settings to choose the screen saver
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
| App window and menu bar readout      | yes | yes | no  | no  |
| Screen saver for the locked screen   | yes | yes | no  | no  |
| Charger memory                       | yes | yes | no  | USB-C only |

Where "watts from the charger" is not available, the power chart shows what
flows into and out of the battery instead.

The energy-hog alert works from the per-app ranking above, so on Windows and
Linux it is based on processor use. It only watches while the battery is
draining, measuring apps once a minute, and never names parts of the system
that cannot be quit. The watts and minutes it quotes are estimates.

On a Mac the battery publishes new figures once a minute. Plugging in or
unplugging shows up at once, as "Charger connected" or "Running on battery";
the watts follow within a minute, and the dashboard says "Reading…" until
they do, instead of showing figures from before the change.

The Windows and Linux readers are covered by automated tests against
representative data, but have not yet been run on real Windows or Linux
hardware. If something looks wrong there, `battery-speed status` and the log
in the data folder are the places to look.

## Notifications

On a Mac, alerts are posted by the Battery Speed app itself, with its icon, and
clicking one opens the app on the section it is about (the Energy list for an
energy hog, Chargers for a weak charger). macOS asks once for permission. If the
app is not running, or on Windows and Linux, the system's own notification tool
is used instead. The Alerts section has a button to send a test notification.

## Screen saver and the locked screen (macOS)

`battery-speed install` puts a **Battery Speed** screen saver in your Screen
Savers folder. Choose it in System Settings > Screen Saver, or run
`battery-speed screensaver` to open that page.

macOS does not let apps add their own content to the lock screen, but it does
show the screen saver there. With this saver selected, a locked or idle Mac
shows the charge, whether it is charging, and the time left.

It is built to use very little power: a black background, dim text, nothing
that animates, and one redraw every 30 seconds. The text moves to a new spot on
each redraw to avoid burn-in. It reads the battery from the system directly, so
it works even when the collector is not running.

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

It holds the history database, your settings and the log. On a Mac, the app
also logs to `~/Library/Logs/Battery Speed.log`. Delete the folder to
erase everything. The dashboard is only reachable from your own computer.

## Development

```
npm install
npm test                 # platform parsing tests
npm start                # run and open the dashboard
npm run build:menubar    # rebuild the macOS app and its icon (needs Xcode)
npm run build:screensaver  # rebuild the macOS screen saver (needs Xcode)
```

`BATTERY_SIMULATE` reshapes the live reading for testing: `limited` (only what
Windows and Linux report), `charging`, or `draining`. `limited` is how the
reduced dashboard is checked.

## License

[MIT](LICENSE)
