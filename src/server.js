// Local-only server: polls the battery, saves history to SQLite, and streams
// each new sample to the dashboard over Server-Sent Events.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readBattery, PLATFORM } from './battery.js';
import { Estimator } from './estimator.js';
import { Store } from './store.js';
import { Profile } from './learning.js';
import { Alerts } from './alerts.js';
import { healthTrend } from './health.js';
import { energyUsers } from './energy.js';
import { buildDigest, generateSummary } from './summary.js';
import { ROOT, VERSION, dbFile, port as configuredPort, apiKey } from './paths.js';

const HOST = '127.0.0.1'; // never exposed to the network
const LIVE_MS = PLATFORM?.liveMs ?? 2000; // poll rate while a dashboard is open
const IDLE_MS = PLATFORM?.idleMs ?? 15_000; // background rate, to stay light on the battery
const MAX_RANGE_MIN = 60 * 24 * 365;
const ENERGY_CACHE_MS = 20_000;
// BATTERY_NOTIFY=off silences desktop notifications entirely (used by the dev copy).
const NOTIFY_AVAILABLE = process.env.BATTERY_NOTIFY !== 'off';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Starts collecting and serving. Resolves once the server is listening. */
export function startServer({ port = configuredPort() } = {}) {
  const dbPath = dbFile();
  const store = new Store(dbPath);
  const estimator = new Estimator(new Profile(store));
  const notificationsOn = () => NOTIFY_AVAILABLE && store.getSetting('notifications', 'on') === 'on';
  const alerts = new Alerts(store, notificationsOn);
  const clients = new Set();
  let latest = null;
  let fault = null;
  let timer = null;
  let running = false;
  let energyCache = { at: 0, pending: null, data: { apps: [], total: 0, metric: PLATFORM?.energyMetric ?? 'cpu' } };
  let summaryPending = null;

  const meta = () => ({
    version: VERSION,
    platform: PLATFORM?.label ?? process.platform,
    platformId: process.platform,
    energyMetric: PLATFORM?.energyMetric ?? 'cpu',
    summaryReady: Boolean(apiKey()),
  });

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => {
    for (const res of clients) send(res, event, data);
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function tick() {
    running = true;
    clearTimeout(timer);
    try {
      const sample = await readBattery();
      const derived = estimator.update(sample);
      latest = { ...sample, derived };
      fault = null;
      store.record(sample, derived.state);
      broadcast('sample', latest);
      for (const alert of await alerts.evaluate(sample, derived)) broadcast('alert', alert);
    } catch (err) {
      // Log a failure once, not on every poll, so the log file stays small.
      if (fault?.message !== err.message) console.error('[battery] read failed:', err.message);
      fault = { message: err.message };
      broadcast('fault', fault);
    } finally {
      running = false;
      timer = setTimeout(tick, clients.size ? LIVE_MS : IDLE_MS);
    }
  }

  // Measuring takes about a second, so share one reading between callers.
  function energyNow() {
    if (Date.now() - energyCache.at < ENERGY_CACHE_MS) return Promise.resolve(energyCache.data);
    energyCache.pending ??= energyUsers()
      .then((data) => {
        energyCache = { at: Date.now(), pending: null, data };
        return data;
      })
      .catch((err) => {
        energyCache.pending = null;
        throw err;
      });
    return energyCache.pending;
  }

  const savedSummary = () => {
    const raw = store.getSetting('summary', '');
    return raw ? JSON.parse(raw) : null;
  };

  // One request at a time: a second click while one is running shares its result.
  function writeSummary() {
    summaryPending ??= (async () => {
      const energy = await energyNow().catch(() => null);
      const digest = buildDigest({ store, latest, energy, health: healthTrend(store.healthDays()) });
      const { text, model } = await generateSummary(digest, apiKey());
      const summary = { ts: Date.now(), text, model };
      store.setSetting('summary', JSON.stringify(summary));
      return summary;
    })().finally(() => {
      summaryPending = null;
    });
    return summaryPending;
  }

  function readJsonBody(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > limit) reject(new Error('Body too large'));
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  // Changes are only accepted from the dashboard itself, not from other sites
  // that happen to be open in the browser.
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  async function serveStatic(urlPath, res) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }

  const server = http.createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      send(res, 'init', { latest, fault, intervalMs: LIVE_MS, meta: meta() });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      if (!running) tick(); // switch to the live poll rate right away
      return;
    }

    if (pathname === '/api/now') return json(res, 200, latest);

    if (pathname === '/api/history') {
      const asked = Number(searchParams.get('minutes'));
      const minutes = Math.min(MAX_RANGE_MIN, Math.max(1, Number.isFinite(asked) && asked > 0 ? asked : 60));
      try {
        return json(res, 200, { ...store.history(Date.now() - minutes * 60_000), ...store.stats() });
      } catch (err) {
        console.error('[store] history query failed:', err.message);
        return json(res, 500, { error: err.message });
      }
    }

    if (pathname === '/api/alerts') {
      return json(res, 200, {
        alerts: store.recentAlerts(),
        notifications: notificationsOn(),
        notificationsAvailable: NOTIFY_AVAILABLE,
      });
    }

    if (pathname === '/api/health') return json(res, 200, healthTrend(store.healthDays()));

    if (pathname === '/api/energy') {
      energyNow().then(
        (data) => json(res, 200, data),
        (err) => json(res, 500, { error: err.message }),
      );
      return;
    }

    if (pathname === '/api/summary' && req.method === 'GET') {
      return json(res, 200, { summary: savedSummary(), ready: Boolean(apiKey()) });
    }

    // Sends a digest of the last 24 hours to the Claude API. Only ever runs on
    // an explicit request from the dashboard.
    if (pathname === '/api/summary' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request refused' });
      writeSummary().then(
        (summary) => json(res, 200, { summary }),
        (err) => {
          console.error('[summary] failed:', err.cause?.message ?? err.message);
          json(res, 502, { error: err.userMessage ?? 'Could not write the summary.' });
        },
      );
      return;
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request refused' });
      readJsonBody(req).then(
        (body) => {
          if (typeof body.notifications === 'boolean') {
            store.setSetting('notifications', body.notifications ? 'on' : 'off');
          }
          json(res, 200, { notifications: notificationsOn(), notificationsAvailable: NOTIFY_AVAILABLE });
        },
        (err) => json(res, 400, { error: err.message }),
      );
      return;
    }

    serveStatic(decodeURIComponent(pathname), res);
  });

  const close = () => {
    clearTimeout(timer);
    server.close();
    store.close();
  };

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      store.close();
      reject(err);
    });
    server.listen(port, HOST, () => {
      tick();
      resolve({ port, url: `http://localhost:${port}`, dbPath, close });
    });
  });
}

// Kept so that `node src/server.js` (how earlier installs launched it) still works.
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'src', 'server.js')) {
  startServer().then(
    ({ url, dbPath }) => console.log(`Battery Speed running at ${url} (history: ${dbPath})`),
    (err) => {
      console.error(err.code === 'EADDRINUSE' ? 'Battery Speed is already running on this port.' : err.message);
      process.exit(1);
    },
  );
}
