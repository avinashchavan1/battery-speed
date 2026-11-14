// Start-at-login, per operating system, using only what each system ships with:
//   macOS    LaunchAgents (collector + menu bar readout), and the app in Applications
//   Linux    a systemd user service, or an XDG autostart entry without systemd
//   Windows  a hidden launcher in the user's Startup folder
// None of it needs admin rights, and `uninstall` removes all of it.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, dataDir, port } from './paths.js';

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NODE = stableNodePath();
const CLI = path.join(ROOT, 'bin', 'battery-speed.js');

/**
 * The Node binary to launch at login. `process.execPath` is often a versioned
 * path (Homebrew's Cellar, for one) that disappears on the next upgrade, so
 * prefer the stable `node` on PATH when it is the same program.
 */
function stableNodePath() {
  const real = (file) => {
    try {
      return realpathSync(file);
    } catch {
      return null;
    }
  };
  const current = real(process.execPath);
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (candidate !== process.execPath && real(candidate) === current) return candidate;
  }
  return process.execPath;
}

/** Is a Battery Speed server answering on the configured port? */
export async function probe() {
  try {
    const res = await fetch(`http://127.0.0.1:${port()}/api/now`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' && 'percent' in body ? body : null;
  } catch {
    return null;
  }
}

async function waitUntilRunning(seconds = 20) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await probe()) return true;
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------- macOS

const MAC_COLLECTOR = 'com.batteryspeed.collector';
const MAC_MENUBAR = 'com.batteryspeed.menubar';
const macAgentsDir = () => path.join(os.homedir(), 'Library', 'LaunchAgents');
const macDomain = () => `gui/${process.getuid()}`;
const macPlist = (label) => path.join(macAgentsDir(), `${label}.plist`);
const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(label, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
${body}
</dict>
</plist>
`;
}

const stringArray = (items) =>
  `  <array>\n${items.map((item) => `    <string>${xml(item)}</string>`).join('\n')}\n  </array>`;

async function macUnload(label) {
  await run('launchctl', ['bootout', `${macDomain()}/${label}`]).catch(() => {});
}

async function macLoad(label) {
  await macUnload(label);
  // bootout returns before the old copy has fully gone; loading too early
  // fails with "Bootstrap failed: 5", so wait for it and retry.
  for (let attempt = 0; attempt < 10; attempt++) {
    const stillThere = await run('launchctl', ['print', `${macDomain()}/${label}`]).then(() => true, () => false);
    if (!stillThere) {
      const loaded = await run('launchctl', ['bootstrap', macDomain(), macPlist(label)]).then(() => true, () => false);
      if (loaded) return;
    }
    await sleep(1000);
  }
  throw new Error(`Could not load ${label}. Try: launchctl bootstrap ${macDomain()} "${macPlist(label)}"`);
}

const MAC_APP = 'Battery Speed.app';
const MAC_BUNDLE_ID = 'com.batteryspeed.app';
const MAC_APP_BINARY = path.join('Contents', 'MacOS', 'BatterySpeedMenu');

/** The app bundle to install: the copy shipped in dist/, or one built from source. */
async function macSourceApp(log) {
  const shipped = path.join(ROOT, 'dist', MAC_APP);
  if (existsSync(path.join(shipped, MAC_APP_BINARY))) return shipped;
  try {
    await run('xcrun', ['--find', 'swiftc']);
    await run('bash', [path.join(ROOT, 'scripts', 'build-menubar.sh')], { timeout: 300_000 });
    return existsSync(path.join(shipped, MAC_APP_BINARY)) ? shipped : null;
  } catch {
    log('Mac app skipped: no prebuilt copy and no Swift compiler on this Mac.');
    return null;
  }
}

/** Applications folders the app may live in: the shared one, else the user's own. */
const macAppFolders = () => ['/Applications', path.join(os.homedir(), 'Applications')];

/** True if the bundle at `app` is Battery Speed, so it is safe to replace or remove. */
function macIsOurApp(app) {
  try {
    return readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes(MAC_BUNDLE_ID);
  } catch {
    return false;
  }
}

/** Copies the app into Applications. Resolves to the installed bundle's path. */
async function macInstallApp(log) {
  const source = await macSourceApp(log);
  if (!source) return null;

  for (const folder of macAppFolders()) {
    const dest = path.join(folder, MAC_APP);
    try {
      mkdirSync(folder, { recursive: true });
      accessSync(folder, fsConstants.W_OK);
    } catch {
      continue; // not writable: try the next folder
    }
    if (existsSync(dest) && !macIsOurApp(dest)) continue; // someone else's app with this name
    rmSync(dest, { recursive: true, force: true });
    await run('ditto', [source, dest]);
    // Tell Launch Services about it, so Spotlight and Launchpad pick it up at once.
    await run(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', dest],
    ).catch(() => {});
    log(`App installed: ${dest}`);
    return dest;
  }
  log('Could not copy the app into an Applications folder; running it from the package instead.');
  return source;
}

async function macInstall(log) {
  const data = dataDir();
  mkdirSync(macAgentsDir(), { recursive: true });

  writeFileSync(
    macPlist(MAC_COLLECTOR),
    plist(
      MAC_COLLECTOR,
      `  <key>ProgramArguments</key>
${stringArray([NODE, CLI, 'start'])}
  <key>EnvironmentVariables</key>
  <dict>
    <key>BATTERY_DATA_DIR</key>
    <string>${xml(data)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(path.join(data, 'agent.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(data, 'agent.log'))}</string>`,
    ),
  );
  await macLoad(MAC_COLLECTOR);
  log('Collector installed: starts at login and keeps recording in the background.');

  // Stop any running copy before replacing the app on disk.
  await macUnload(MAC_MENUBAR);
  await run('pkill', ['-x', 'BatterySpeedMenu']).catch(() => {});
  const app = await macInstallApp(log);
  if (app) {
    writeFileSync(
      macPlist(MAC_MENUBAR),
      plist(
        MAC_MENUBAR,
        `  <key>ProgramArguments</key>
${stringArray([path.join(app, MAC_APP_BINARY), '--background'])}
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart after a crash, but stay closed after Quit from the menu. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(data, 'menubar.log'))}</string>`,
      ),
    );
    await macLoad(MAC_MENUBAR);
    log('Menu bar readout started. Open "Battery Speed" from Launchpad or Spotlight for the full window.');
  }
}

async function macUninstall(log) {
  for (const label of [MAC_COLLECTOR, MAC_MENUBAR]) {
    await macUnload(label);
    rmSync(macPlist(label), { force: true });
  }
  await run('pkill', ['-x', 'BatterySpeedMenu']).catch(() => {});
  for (const folder of macAppFolders()) {
    const app = path.join(folder, MAC_APP);
    if (macIsOurApp(app)) rmSync(app, { recursive: true, force: true });
  }
  log('Removed the app, the collector and the menu bar readout.');
}

const macInstalled = () => existsSync(macPlist(MAC_COLLECTOR));

// ---------------------------------------------------------------- Linux

const LINUX_UNIT = 'battery-speed.service';
const linuxUnitFile = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', LINUX_UNIT);
const linuxDesktopFile = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'battery-speed.desktop');

function startDetached() {
  spawn(NODE, [CLI, 'start'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function linuxInstall(log) {
  const unit = linuxUnitFile();
  mkdirSync(path.dirname(unit), { recursive: true });
  writeFileSync(
    unit,
    `[Unit]
Description=Battery Speed collector and dashboard

[Service]
ExecStart="${NODE}" "${CLI}" start
Environment=BATTERY_DATA_DIR=${dataDir()}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`,
  );
  try {
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', LINUX_UNIT]);
    // Without lingering the service stops at logout, which is what a laptop wants.
    log('Installed as a systemd user service: starts at login.');
  } catch {
    // No systemd user session: fall back to the desktop's own autostart folder.
    rmSync(unit, { force: true });
    const desktop = linuxDesktopFile();
    mkdirSync(path.dirname(desktop), { recursive: true });
    writeFileSync(
      desktop,
      `[Desktop Entry]
Type=Application
Name=Battery Speed
Comment=Battery monitor (background collector)
Exec="${NODE}" "${CLI}" start
X-GNOME-Autostart-enabled=true
NoDisplay=true
`,
    );
    startDetached();
    log('Installed as a desktop autostart entry: starts at login.');
  }
}

async function linuxUninstall(log) {
  await run('systemctl', ['--user', 'disable', '--now', LINUX_UNIT]).catch(() => {});
  rmSync(linuxUnitFile(), { force: true });
  rmSync(linuxDesktopFile(), { force: true });
  await run('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  // Covers the copy started through the autostart-entry fallback.
  await run('pkill', ['-f', 'battery-speed.js start']).catch(() => {});
  log('Removed Battery Speed from login items.');
}

const linuxInstalled = () => existsSync(linuxUnitFile()) || existsSync(linuxDesktopFile());

// ---------------------------------------------------------------- Windows

const windowsLauncher = () =>
  path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Battery Speed.vbs',
  );

async function windowsStop() {
  // Stop any running collector except this very process.
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    `Where-Object { $_.CommandLine -like '*battery-speed.js*start*' -and $_.ProcessId -ne ${process.pid} } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }';
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).catch(() => {});
}

async function windowsInstall(log) {
  const launcher = windowsLauncher();
  mkdirSync(path.dirname(launcher), { recursive: true });
  // A script host launcher runs Node with no console window.
  const q = (text) => `""${text}""`;
  writeFileSync(
    launcher,
    `' Starts the Battery Speed collector at login, without a console window.\r\n` +
      `CreateObject("WScript.Shell").Run "${q(NODE)} ${q(CLI)} start", 0, False\r\n`,
  );
  await windowsStop();
  spawn('wscript.exe', [launcher], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  log('Installed in your Startup folder: starts at login.');
}

async function windowsUninstall(log) {
  rmSync(windowsLauncher(), { force: true });
  await windowsStop();
  log('Removed Battery Speed from your Startup folder.');
}

const windowsInstalled = () => existsSync(windowsLauncher());

// ---------------------------------------------------------------- public

const PLATFORMS = {
  darwin: { install: macInstall, uninstall: macUninstall, installed: macInstalled },
  linux: { install: linuxInstall, uninstall: linuxUninstall, installed: linuxInstalled },
  win32: { install: windowsInstall, uninstall: windowsUninstall, installed: windowsInstalled },
};

function platform() {
  const p = PLATFORMS[process.platform];
  if (!p) throw new Error(`Start-at-login is not supported on this system (${process.platform}).`);
  return p;
}

/** Installs start-at-login and starts the collector now. Resolves to whether it came up. */
export async function install(log = console.log) {
  await platform().install(log);
  return waitUntilRunning();
}

export async function uninstall(log = console.log) {
  await platform().uninstall(log);
}

export function isInstalled() {
  return PLATFORMS[process.platform]?.installed() ?? false;
}
