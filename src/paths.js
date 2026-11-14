// Where the app keeps its files, on every operating system.

import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'Battery Speed';
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const DEFAULT_PORT = 4780;

function userDataDir() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_NAME);
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'battery-speed');
  }
}

/**
 * History, settings and logs live here. An installed copy uses the standard
 * per-user folder; a source checkout that already recorded into ./data keeps
 * using it, so existing history is never left behind.
 */
export function dataDir() {
  let dir;
  if (process.env.BATTERY_DATA_DIR) dir = path.resolve(process.env.BATTERY_DATA_DIR);
  else if (existsSync(path.join(ROOT, 'data', 'battery.db'))) dir = path.join(ROOT, 'data');
  else dir = userDataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbFile() {
  return process.env.BATTERY_DB
    ? path.resolve(ROOT, process.env.BATTERY_DB)
    : path.join(dataDir(), 'battery.db');
}

const configFile = () => path.join(dataDir(), 'config.json');

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

/** Merges `patch` into the saved config. A null value removes that key. */
export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  for (const key of Object.keys(next)) if (next[key] == null) delete next[key];
  const file = configFile();
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // may hold an API key: owner-only, even if it already existed
  return next;
}

export function port() {
  return Number(process.env.PORT) || Number(loadConfig().port) || DEFAULT_PORT;
}

/** The Claude API key for the AI summary, if one has been set up. */
export function apiKey() {
  return process.env.ANTHROPIC_API_KEY || loadConfig().anthropicApiKey || null;
}
