// SQLite history. Uses Node's built-in driver, so there is nothing to install.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// The battery gauge only refreshes about once a minute, so identical readings
// are skipped and a heartbeat row is written every 30 s instead.
const HEARTBEAT_MS = 30_000;
const HEALTH_EVERY_MS = 10 * 60_000;
// Below this bucket size, raw rows are returned as they are.
const RAW_BELOW_MS = 30_000;

export class Store {
  #db;
  #insert;
  #upsertHealth;
  #lastKey = null;
  #lastTs = 0;
  #lastHealthTs = 0;

  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS samples (
        ts             INTEGER PRIMARY KEY,  -- unix ms
        percent        INTEGER,
        remaining_mah  INTEGER,
        full_mah       INTEGER,
        voltage_mv     INTEGER,
        amperage_ma    INTEGER,              -- signed, + is into the battery
        battery_mw     INTEGER,              -- signed, + is into the battery
        adapter_in_mw  INTEGER,
        system_load_mw INTEGER,
        external       INTEGER NOT NULL,     -- 1 when plugged in
        adapter_w      INTEGER,
        state          TEXT
      );

      -- One row per day, for tracking capacity fade over months.
      CREATE TABLE IF NOT EXISTS health (
        day         TEXT PRIMARY KEY,        -- local YYYY-MM-DD
        ts          INTEGER NOT NULL,
        full_mah    INTEGER,
        nominal_mah INTEGER,
        design_mah  INTEGER,
        cycle_count INTEGER
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id       INTEGER PRIMARY KEY,
        ts       INTEGER NOT NULL,
        kind     TEXT NOT NULL,
        severity TEXT NOT NULL,
        title    TEXT NOT NULL,
        body     TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0  -- 1 when a desktop notification was sent
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Added after the first release: how many readings a day's average covers.
    const healthCols = this.#db.prepare('PRAGMA table_info(health)').all();
    if (!healthCols.some((c) => c.name === 'readings')) {
      this.#db.exec('ALTER TABLE health ADD COLUMN readings INTEGER NOT NULL DEFAULT 1');
    }

    this.#insert = this.#db.prepare(`
      INSERT OR REPLACE INTO samples
        (ts, percent, remaining_mah, full_mah, voltage_mv, amperage_ma,
         battery_mw, adapter_in_mw, system_load_mw, external, adapter_w, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#upsertHealth = this.#db.prepare(`
      INSERT INTO health (day, ts, full_mah, nominal_mah, design_mah, cycle_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        ts = excluded.ts,
        -- The gauge's capacity estimate jitters, so keep the day's running average.
        full_mah = ROUND((full_mah * readings + excluded.full_mah) * 1.0 / (readings + 1)),
        nominal_mah = ROUND((nominal_mah * readings + excluded.nominal_mah) * 1.0 / (readings + 1)),
        readings = readings + 1,
        design_mah = excluded.design_mah, cycle_count = excluded.cycle_count
    `);
  }

  /** Saves a sample if it differs from the last one or the heartbeat is due. */
  record(s, state) {
    const key = [
      s.percent, s.remainingMah, s.amperageMa, s.adapterInMw, s.systemLoadMw,
      s.externalConnected, state,
    ].join('|');
    if (key === this.#lastKey && s.ts - this.#lastTs < HEARTBEAT_MS) return false;

    this.#insert.run(
      s.ts, s.percent, s.remainingMah, s.fullMah, s.voltageMv, s.amperageMa,
      s.batteryPowerMw, s.adapterInMw, s.systemLoadMw,
      s.externalConnected ? 1 : 0, s.adapter?.watts ?? null, state,
    );
    this.#lastKey = key;
    this.#lastTs = s.ts;

    if (s.ts - this.#lastHealthTs >= HEALTH_EVERY_MS) {
      const day = new Date(s.ts).toLocaleDateString('en-CA'); // YYYY-MM-DD, local
      this.#upsertHealth.run(day, s.ts, s.fullMah, s.nominalMah, s.designMah, s.cycleCount);
      this.#lastHealthTs = s.ts;
    }
    return true;
  }

  /** Points since `sinceTs`, averaged into at most `maxPoints` buckets. */
  history(sinceTs, maxPoints = 600) {
    const bucketMs = Math.ceil((Date.now() - sinceTs) / maxPoints);
    const cols = `
      percent,
      %(adapter_in_mw) AS adapterInMw,
      %(system_load_mw) AS systemLoadMw,
      %(battery_mw) AS batteryPowerMw`;

    if (bucketMs < RAW_BELOW_MS) {
      const points = this.#db
        .prepare(`SELECT ts, ${cols.replaceAll('%', '')} FROM samples WHERE ts >= ? ORDER BY ts`)
        .all(sinceTs);
      return { points, bucketMs: 0 };
    }

    // With a single MAX() aggregate, SQLite takes the bare `percent` column
    // from that same newest row in each bucket. The CAST matters: the driver
    // binds JS numbers as floats, and float division would never group.
    const points = this.#db
      .prepare(
        `SELECT MAX(ts) AS ts, ${cols.replaceAll('%', 'AVG')}
         FROM samples WHERE ts >= ? GROUP BY ts / CAST(? AS INTEGER) ORDER BY 1`,
      )
      .all(sinceTs, bucketMs);
    return { points, bucketMs };
  }

  stats() {
    return this.#db.prepare('SELECT COUNT(*) AS count, MIN(ts) AS since FROM samples').get();
  }

  /** Highest charging current seen in each 5% band: the battery's own limit there. */
  chargeBands(sinceTs) {
    return this.#db
      .prepare(
        `SELECT (percent / 5) * 5 AS band, COUNT(*) AS n, MAX(amperage_ma) AS maxMa
         FROM samples
         WHERE state = 'charging' AND amperage_ma > 0 AND ts >= ?
         GROUP BY band ORDER BY band`,
      )
      .all(sinceTs);
  }

  /** Average draw while running on battery. */
  typicalDischarge(sinceTs) {
    return this.#db
      .prepare(
        `SELECT COUNT(*) AS n, AVG(-amperage_ma) AS avgMa, AVG(-battery_mw) AS avgMw
         FROM samples
         WHERE state = 'discharging' AND amperage_ma < 0 AND ts >= ?`,
      )
      .get(sinceTs);
  }

  /** Time spent and power drawn in each state, for the AI summary digest. */
  stateBreakdown(sinceTs) {
    // Gaps between rows are capped so sleep is not counted as time in a state.
    return this.#db
      .prepare(
        `WITH d AS (
           SELECT state, system_load_mw, battery_mw, percent,
                  ts - LAG(ts) OVER (ORDER BY ts) AS dt
           FROM samples WHERE ts >= ?
         )
         SELECT state, SUM(MIN(dt, 60000)) AS ms, AVG(system_load_mw) AS avgLoadMw,
                MAX(system_load_mw) AS peakLoadMw, AVG(battery_mw) AS avgBattMw,
                MIN(percent) AS minPct, MAX(percent) AS maxPct
         FROM d WHERE dt IS NOT NULL GROUP BY state ORDER BY ms DESC`,
      )
      .all(sinceTs);
  }

  healthDays(limit = 400) {
    return this.#db
      .prepare(
        `SELECT day, full_mah AS fullMah, nominal_mah AS nominalMah, design_mah AS designMah,
                cycle_count AS cycleCount
         FROM (SELECT * FROM health ORDER BY day DESC LIMIT CAST(? AS INTEGER)) ORDER BY day`,
      )
      .all(limit);
  }

  addAlert(a) {
    const info = this.#db
      .prepare('INSERT INTO alerts (ts, kind, severity, title, body, notified) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.ts, a.kind, a.severity, a.title, a.body, a.notified ? 1 : 0);
    return { ...a, id: Number(info.lastInsertRowid) };
  }

  recentAlerts(limit = 8) {
    return this.#db
      .prepare(
        `SELECT id, ts, kind, severity, title, body, notified FROM alerts
         ORDER BY ts DESC, id DESC LIMIT CAST(? AS INTEGER)`,
      )
      .all(limit);
  }

  /** When each kind of alert last fired, so cooldowns survive restarts. */
  lastAlertTimes() {
    const rows = this.#db.prepare('SELECT kind, MAX(ts) AS ts FROM alerts GROUP BY kind').all();
    return new Map(rows.map((r) => [r.kind, r.ts]));
  }

  getSetting(key, fallback) {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.#db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  close() {
    this.#db.close();
  }
}
