#!/usr/bin/env node
// Battery Speed command line: one entry point on macOS, Windows and Linux.

import { spawn } from 'node:child_process';

// Checked before anything else loads: the history store needs Node's built-in SQLite.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `Battery Speed needs Node.js 22.13 or newer (this is ${process.versions.node}).\n` +
      'Get the current version from https://nodejs.org and run this again.',
  );
  process.exit(1);
}

const HELP = `Battery Speed: live battery stats, charging speed and time left.

Usage: battery-speed <command> [options]

Commands
  start        Run the collector and dashboard in this terminal (the default)
  install      Start at login and keep recording in the background
  uninstall    Remove start-at-login and stop the background copy
  status       Show whether it is running, and the current reading
  open         Open the dashboard in your browser
  screensaver  macOS: open Screen Saver settings to choose the Battery Speed saver
  help         Show this help

Options
  --open       With start: also open the dashboard
  --port <n>   With start: use another port (default 4780)
  --version    Print the version
`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
function option(name) {
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at !== -1 ? args[at + 1] : undefined;
}
const portArgAt = args.indexOf('--port');
const command =
  args.find((a, i) => !a.startsWith('-') && !(portArgAt !== -1 && i === portArgAt + 1)) ?? 'start';

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

function describe(reading) {
  const d = reading.derived;
  const eta = d.etaMin != null ? `, about ${d.etaMin} min until ${d.etaKind}` : '';
  return `${reading.percent}% · ${d.headline}${eta}`;
}

const commands = {
  async start() {
    const { startServer } = await import('../src/server.js');
    const { port: configuredPort } = await import('../src/paths.js');
    const { probe } = await import('../src/autostart.js');
    const asked = Number(option('port'));
    const port = Number.isInteger(asked) && asked > 0 ? asked : configuredPort();
    if (option('port')) process.env.PORT = String(port); // so `probe` checks the same port

    try {
      const server = await startServer({ port });
      console.log(`Battery Speed is running at ${server.url}`);
      console.log(`History is saved in ${server.dbPath}`);
      console.log('Press Ctrl+C to stop.');
      if (flag('open')) openBrowser(server.url);
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
          server.close();
          process.exit(0);
        });
      }
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      const url = `http://localhost:${port}`;
      if (await probe()) {
        // Not a failure: the background copy is already doing the job.
        console.log(`Battery Speed is already running at ${url}`);
        if (flag('open')) openBrowser(url);
        return;
      }
      console.error(`Port ${port} is in use by another program. Try: battery-speed start --port ${port + 10}`);
      process.exitCode = 1;
    }
  },

  async install() {
    const { install } = await import('../src/autostart.js');
    const { port } = await import('../src/paths.js');
    const up = await install();
    const url = `http://localhost:${port()}`;
    if (up) {
      console.log(`\nRunning. Dashboard: ${url}`);
      console.log('To remove it later: battery-speed uninstall');
    } else {
      console.log(`\nInstalled, but the collector has not answered yet. Check: battery-speed status`);
      process.exitCode = 1;
    }
  },

  async uninstall() {
    const { uninstall } = await import('../src/autostart.js');
    await uninstall();
    console.log('Your saved history was kept.');
  },

  async status() {
    const { probe, isInstalled } = await import('../src/autostart.js');
    const { port, dataDir, VERSION } = await import('../src/paths.js');
    const reading = await probe();
    console.log(`Battery Speed ${VERSION}`);
    console.log(`  Running:        ${reading ? `yes, at http://localhost:${port()}` : 'no'}`);
    console.log(`  Start at login: ${isInstalled() ? 'yes' : 'no'}`);
    console.log(`  Data folder:    ${dataDir()}`);
    if (reading) console.log(`  Now:            ${describe(reading)}`);
  },

  async open() {
    const { port } = await import('../src/paths.js');
    const { probe } = await import('../src/autostart.js');
    if (!(await probe())) {
      console.log('Battery Speed is not running. Start it with: battery-speed start --open');
      process.exitCode = 1;
      return;
    }
    openBrowser(`http://localhost:${port()}`);
  },

  async screensaver() {
    const { openScreenSaverSettings } = await import('../src/autostart.js');
    await openScreenSaverSettings();
    console.log('Screen Saver settings are open. Choose "Battery Speed" from the list (under Other).');
    console.log('To see it on the locked screen, set the screen saver to start after a short');
    console.log('time and keep "Require password after screen saver begins" turned on.');
  },

  async help() {
    console.log(HELP);
  },
};

if (flag('version') || args.includes('-v')) {
  const { VERSION } = await import('../src/paths.js');
  console.log(VERSION);
} else if (flag('help') || args.includes('-h')) {
  console.log(HELP);
} else if (!commands[command]) {
  console.error(`Unknown command "${command}".\n`);
  console.log(HELP);
  process.exitCode = 1;
} else {
  try {
    await commands[command]();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
