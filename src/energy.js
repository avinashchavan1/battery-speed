// Which apps are working the battery hardest right now.
//
// macOS exposes a per-app "energy impact" (the figure Activity Monitor shows).
// Windows and Linux have no such number, so there the list ranks by CPU use,
// which is the closest widely available stand-in. `metric` says which it is.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const round1 = (n) => Math.round(n * 10) / 10;

function rank(entries, limit, metric) {
  const byApp = new Map();
  for (const [name, value] of entries) {
    if (name && value > 0) byApp.set(name, (byApp.get(name) ?? 0) + value);
  }
  const apps = [...byApp]
    .map(([name, power]) => ({ name, power: round1(power) }))
    .sort((a, b) => b.power - a.power);
  return {
    metric,
    apps: apps.slice(0, limit),
    total: round1(apps.reduce((sum, a) => sum + a.power, 0)),
  };
}

// ---------- macOS ----------

const MAC_FRIENDLY = {
  WindowServer: 'WindowServer (display)',
  'com.apple.DriverKit-AppleBCMWLAN': 'Wi-Fi driver',
  coreaudiod: 'Audio',
  'com.apple.WebKit.WebContent': 'Web content',
  'com.apple.WebKit.GPU': 'Web content (graphics)',
  kernel_task: 'kernel_task (system)',
  mds_stores: 'Spotlight indexing',
};
const INTERPRETERS = /^(python[\d.]*|node|ruby|java|deno|bun)$/i;

function macName(commPath) {
  // Helpers live inside their app's bundle; credit the outermost app.
  const app = commPath.match(/\/([^/]+)\.app\//);
  if (app) return app[1];
  const base = commPath.split('/').pop();
  if (INTERPRETERS.test(base)) {
    // Name the project a script interpreter is running from, when visible.
    const project = commPath.match(/\/([^/]+)\/\.?venv\//) ?? commPath.match(/\/([^/]+)\/node_modules\//);
    return project ? `${base} (${project[1]})` : base;
  }
  return MAC_FRIENDLY[base] ?? base;
}

async function mac(limit) {
  // Two samples: the first has no interval to measure power over.
  const { stdout } = await run(
    '/usr/bin/top',
    ['-l', '2', '-o', 'power', '-n', '25', '-stats', 'pid,power'],
    { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
  );
  const second = stdout.slice(stdout.lastIndexOf('PID'));
  const rows = [...second.matchAll(/^\s*(\d+)\s+([\d.]+)\s*$/gm)]
    .map((m) => ({ pid: m[1], power: Number(m[2]) }))
    .filter((r) => r.power > 0);
  if (!rows.length) return rank([], limit, 'energy');

  const names = new Map();
  try {
    const ps = await run('/bin/ps', ['-o', 'pid=,comm=', '-p', rows.map((r) => r.pid).join(',')]);
    for (const m of ps.stdout.matchAll(/^\s*(\d+)\s+(.+)$/gm)) names.set(m[1], m[2].trim());
  } catch {
    // ps exits non-zero if every listed process has already quit.
  }

  const entries = rows
    .map((r) => [names.get(r.pid), r.power])
    .filter(([comm]) => comm && !comm.endsWith('/top')) // gone, or our own measurement
    .map(([comm, power]) => [macName(comm), power]);
  return rank(entries, limit, 'energy');
}

// ---------- Linux ----------

/** Parses `ps -eo pcpu=,comm=` output. Exported for tests. */
export function parsePs(stdout) {
  return [...stdout.matchAll(/^\s*([\d.]+)\s+(.+)$/gm)]
    .map((m) => [m[2].trim(), Number(m[1])])
    .filter(([name]) => name !== 'ps');
}

async function linux(limit) {
  const { stdout } = await run('ps', ['-eo', 'pcpu=,comm=', '--sort=-pcpu'], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
  });
  return rank(parsePs(stdout).slice(0, 40), limit, 'cpu');
}

// ---------- Windows ----------

const WINDOWS_SCRIPT =
  "$ErrorActionPreference = 'SilentlyContinue'; " +
  'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ' +
  "Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' -and $_.PercentProcessorTime -gt 0 } | " +
  'Sort-Object PercentProcessorTime -Descending | Select-Object -First 25 Name, PercentProcessorTime | ' +
  'ConvertTo-Json -Compress';

/** Parses the PowerShell JSON. Exported for tests. */
export function parseWindowsProcesses(stdout) {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  // "chrome#3" is the fourth chrome process: fold instances into one app.
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => [
    String(p.Name).replace(/#\d+$/, ''),
    Number(p.PercentProcessorTime),
  ]);
}

async function windows(limit) {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
    { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return rank(parseWindowsProcesses(stdout), limit, 'cpu');
}

const READERS = { darwin: mac, linux, win32: windows };

export async function energyUsers(limit = 5) {
  const reader = READERS[process.platform];
  return reader ? reader(limit) : rank([], limit, 'cpu');
}
