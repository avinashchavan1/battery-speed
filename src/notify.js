// Native desktop notifications on macOS, Windows and Linux, using only tools
// each system ships with. Text is always passed as an argument or environment
// variable, never spliced into a script, so it cannot be misread as code.

import { execFile } from 'node:child_process';

const TIMEOUT_MS = 15_000;

const SENDERS = {
  darwin: (title, body) => [
    '/usr/bin/osascript',
    [
      '-e', 'on run argv',
      '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e', 'end run',
      title, body,
    ],
    {},
  ],
  linux: (title, body) => ['notify-send', ['--app-name=Battery Speed', title, body], {}],
  win32: (title, body) => [
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      // A tray balloon: works on every Windows version without extra modules.
      'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
        '$n = New-Object System.Windows.Forms.NotifyIcon; ' +
        '$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; ' +
        "$n.ShowBalloonTip(8000, $env:BS_TITLE, $env:BS_BODY, 'Info'); " +
        'Start-Sleep -Seconds 9; $n.Dispose()',
    ],
    { env: { ...process.env, BS_TITLE: title, BS_BODY: body }, windowsHide: true },
  ],
};

/** Shows a notification. Resolves to whether the system accepted it. */
export function notify(title, body) {
  const build = SENDERS[process.platform];
  if (!build) return Promise.resolve(false);
  const [command, args, options] = build(String(title), String(body));
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TIMEOUT_MS, ...options }, (err) => {
      if (err) console.error('[notify] failed:', err.message);
      resolve(!err);
    });
  });
}
