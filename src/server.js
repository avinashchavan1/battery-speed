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
import { buildDigest, writeSummaryText, summaryEngine } from './summary.js';
import { analysePeriod, rankApps, digestText, builtinSummary } from './analysis.js';
import { ChargerMemory } from './chargers.js';
import { HogWatch, hogAlert } from './hogs.js';
import { notify } from './notify.js';
import { ROOT, VERSION, dbFile, port as configuredPort, apiKey } from './paths.js';

const HOST = '127.0.0.1'; // never exposed to the network
const LIVE_MS = PLATFORM?.liveMs ?? 2000; // poll rate while a dashboard is open
const IDLE_MS = PLATFORM?.idleMs ?? 15_000; // background rate, to stay light on the battery
const MAX_RANGE_MIN = 60 * 24 * 365;
const ENERGY_CACHE_MS = 20_000;
// On battery, apps are measured once a minute to catch one draining it.
// The measurement takes about a second, so it does not run on the charger.
const HOG_CHECK_MS = 60_000;
const NOTIFIER_PING_MS = 25_000; // keeps the Mac app's notification stream open
const DIGEST_HOUR = 7; // the morning digest goes out with the first reading after 7:00
const DAY_MS = 24 * 3600_000;
const localDay = (ts) => new Date(ts).toLocaleDateString('en-CA'); // YYYY-MM-DD
const UNPLUG_LEVELS = ['off', '80', '85', '90', '95'];
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
  const chargers = new ChargerMemory(store);

  // The Battery Speed Mac app subscribes to /notifications and posts alerts as
  // itself: its own icon, and a click opens the app. Without it (or on
  // Windows and Linux) the system's own notification tool is used instead.
  const notifiers = new Set();
  const deliver = (alert) => {
    if (notifiers.size) {
      for (const res of notifiers) send(res, 'notify', alert);
      return Promise.resolve(true);
    }
    return notify(alert.title, alert.body);
  };
  const notifierPing = setInterval(() => {
    for (const res of notifiers) res.write(': ping\n\n');
  }, NOTIFIER_PING_MS);

  const alerts = new Alerts(store, notificationsOn, (watts) => chargers.lookup(watts), deliver);
  const hogs = new HogWatch();
  const clients = new Set();
  let latest = null;
  let fault = null;
  let timer = null;
  let inflight = null; // the read in progress, shared by everyone who asks for one
  let energyCache = { at: 0, pending: null, data: { apps: [], total: 0, metric: PLATFORM?.energyMetric ?? 'cpu' } };
  let summaryPending = null;
  let appEnergyAt = null; // when per-app energy was last added to the daily totals

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

  // Reads the battery now. Calls that arrive during a read share it.
  function tick() {
    inflight ??= readOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function readOnce() {
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
      timer = setTimeout(tick, clients.size ? LIVE_MS : IDLE_MS);
    }
    maybeSendDigest().catch((err) => console.error('[digest] failed:', err.message));
  }

  // ---------------------------------------------------------------- digest

  const setting = (key, fallback) => store.getSetting(key, fallback);
  const settingsView = () => ({
    notifications: notificationsOn(),
    notificationsAvailable: NOTIFY_AVAILABLE,
    unplugAt: setting('unplugAt', '80'),
    digest: setting('digest', 'on') === 'on',
    calendar: setting('calendar', 'off') === 'on',
  });

  /** Everything known about one period, for the digest and the built-in analysis. */
  function periodFacts(fromTs, toTs) {
    const stats = analysePeriod(store.periodRows(fromTs, toTs));
    const days = new Set([localDay(fromTs), localDay(toTs - 1)]);
    const apps = rankApps([...days].flatMap((day) => store.topApps(day, 10)));
    return { stats, apps };
  }

  /** Builds yesterday's digest (or returns the one already built today). */
  function yesterdaysDigest(now = Date.now()) {
    const today = localDay(now);
    const saved = setting('digest:last', '');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.builtOn === today) return parsed;
    }
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const { stats, apps } = periodFacts(midnight.getTime() - DAY_MS, midnight.getTime());
    const text = digestText(stats, apps);
    const digest = { builtOn: today, day: localDay(midnight.getTime() - DAY_MS), ...(text ?? { title: null, lines: [] }) };
    store.setSetting('digest:last', JSON.stringify(digest));
    return digest;
  }

  // Once a day, with the first reading after 7:00, sends yesterday's digest.
  async function maybeSendDigest(now = Date.now()) {
    if (new Date(now).getHours() < DIGEST_HOUR) return;
    const today = localDay(now);
    if (setting('digest:sentOn', '') === today) return;
    store.setSetting('digest:sentOn', today);
    if (setting('digest', 'on') !== 'on') return;
    const digest = yesterdaysDigest(now);
    if (!digest.title) return; // the laptop was barely used yesterday
    const fired = await alerts.raise(
      { kind: 'digest', cooldownMs: 20 * 3600_000, severity: 'good', title: digest.title, body: digest.lines.join(' ') },
      now,
    );
    fired.forEach((alert) => broadcast('alert', alert));
  }

  // Measuring takes about a second, so share one reading between callers.
  function energyNow() {
    if (Date.now() - energyCache.at < ENERGY_CACHE_MS) return Promise.resolve(energyCache.data);
    energyCache.pending ??= energyUsers()
      .then((data) => {
        energyCache = { at: Date.now(), pending: null, data };
        watchForHog(data);
        recordAppEnergy(data);
        return data;
      })
      .catch((err) => {
        energyCache.pending = null;
        throw err;
      });
    return energyCache.pending;
  }

  // On battery, each measurement adds to the day's per-app totals for the digest.
  function recordAppEnergy(energy) {
    const now = Date.now();
    const state = latest?.derived?.state;
    const onBattery = state === 'discharging' || state === 'draining_on_ac';
    // Count the time since the last measurement, at most two minutes of it.
    const minutes = appEnergyAt == null ? 1 : Math.min(2, (now - appEnergyAt) / 60_000);
    appEnergyAt = onBattery ? now : null;
    if (onBattery && energy.apps.length) store.recordAppEnergy(localDay(now), energy, minutes);
  }

  // Every fresh measurement, whoever asked for it, feeds the hog watch.
  function watchForHog(energy) {
    const hog = hogs.observe(energy, latest);
    if (!hog) return;
    alerts.raise(hogAlert(hog)).then(
      (fired) => fired.forEach((alert) => broadcast('alert', alert)),
      (err) => console.error('[hogs] alert failed:', err.message),
    );
  }

  const hogTimer = setInterval(() => {
    const state = latest?.derived?.state;
    if (state === 'discharging' || state === 'draining_on_ac') energyNow().catch(() => {});
    else hogs.observe(null, latest); // on the charger: clear any earlier hog
  }, HOG_CHECK_MS);

  const savedSummary = () => {
    const raw = store.getSetting('summary', '');
    return raw ? JSON.parse(raw) : null;
  };

  // One request at a time: a second click while one is running shares its result.
  function writeSummary() {
    summaryPending ??= (async () => {
      const energy = await energyNow().catch(() => null);
      const now = Date.now();
      const digest = buildDigest({ store, latest, energy, health: healthTrend(store.healthDays()) });
      const builtin = builtinSummary({
        ...periodFacts(now - DAY_MS, now),
        latest,
        chargerReport: chargers.report(now),
      });
      const { text, engine, note } = await writeSummaryText({ digest, builtin, apiKey: apiKey() });
      const summary = { ts: now, text, model: engine.label, engine: engine.kind, note };
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
      tick(); // switch to the live poll rate right away
      return;
    }

    // `fresh=1` (sent by the Mac app the moment the power source changes) or a
    // reading older than a few seconds triggers a new read before answering.
    // The Mac app's notification stream. Unlike /events it does not make the
    // collector poll faster, so having the app running costs nothing extra.
    if (pathname === '/notifications') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      notifiers.add(res);
      req.on('close', () => notifiers.delete(res));
      return;
    }

    // Shows a sample notification, so people can see what alerts look like.
    if (pathname === '/api/notify-test' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request refused' });
      deliver({
        kind: 'test',
        severity: 'good',
        title: 'Battery Speed notifications work',
        body: 'Alerts look like this. Click one to open Battery Speed.',
        ts: Date.now(),
      }).then((shown) => json(res, 200, { shown, via: notifiers.size ? 'app' : 'system' }));
      return;
    }

    if (pathname === '/api/now') {
      const stale = !latest || Date.now() - latest.ts > 4000;
      if (searchParams.get('fresh') === '1' || stale) {
        tick().then(() => json(res, 200, latest));
        return;
      }
      return json(res, 200, latest);
    }

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
        alerts: store.recentAlerts(Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 8))),
        ...settingsView(),
      });
    }

    if (pathname === '/api/health') return json(res, 200, healthTrend(store.healthDays()));

    if (pathname === '/api/chargers') {
      try {
        const report = chargers.report(Date.now(), { refresh: searchParams.get('fresh') === '1' });
        return json(res, 200, { ...report, current: latest?.externalConnected ? (latest.adapter?.watts ?? null) : null });
      } catch (err) {
        console.error('[chargers] report failed:', err.message);
        return json(res, 500, { error: err.message });
      }
    }

    if (pathname === '/api/energy') {
      energyNow().then(
        (data) => {
          const hog = hogs.current();
          const { title, body } = hog ? hogAlert(hog) : {};
          json(res, 200, { ...data, hog: hog && { ...hog, title, body } });
        },
        (err) => json(res, 500, { error: err.message }),
      );
      return;
    }

    if (pathname === '/api/summary' && req.method === 'GET') {
      summaryEngine(apiKey()).then((engine) =>
        json(res, 200, { summary: savedSummary(), ready: true, engine, digest: yesterdaysDigest() }),
      );
      return;
    }

    // The Mac app raises calendar warnings through here, so they are saved,
    // listed and delivered like every other alert.
    if (pathname === '/api/alerts/raise' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request refused' });
      readJsonBody(req).then(
        async (body) => {
          if (typeof body.kind !== 'string' || !body.kind.startsWith('calendar_') || !body.title || !body.body) {
            return json(res, 400, { error: 'Only calendar alerts can be raised here' });
          }
          const fired = await alerts.raise({
            kind: body.kind.slice(0, 120),
            cooldownMs: 12 * 3600_000,
            severity: 'warning',
            title: String(body.title).slice(0, 200),
            body: String(body.body).slice(0, 500),
          });
          fired.forEach((alert) => broadcast('alert', alert));
          json(res, 200, { raised: fired.length > 0 });
        },
        (err) => json(res, 400, { error: err.message }),
      );
      return;
    }

    if (pathname === '/api/settings' && req.method === 'GET') return json(res, 200, settingsView());

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
          if (UNPLUG_LEVELS.includes(String(body.unplugAt))) store.setSetting('unplugAt', String(body.unplugAt));
          if (typeof body.digest === 'boolean') store.setSetting('digest', body.digest ? 'on' : 'off');
          if (typeof body.calendar === 'boolean') store.setSetting('calendar', body.calendar ? 'on' : 'off');
          json(res, 200, settingsView());
        },
        (err) => json(res, 400, { error: err.message }),
      );
      return;
    }

    serveStatic(decodeURIComponent(pathname), res);
  });

  const close = () => {
    clearTimeout(timer);
    clearInterval(hogTimer);
    clearInterval(notifierPing);
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
