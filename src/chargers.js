// Charger memory: how each charger has held up in real use, from the saved
// history. Chargers are told apart by their rated watts, the one identifying
// detail every charger reports.

const LOOKBACK_MS = 60 * 24 * 3600_000; // 60 days
const CACHE_MS = 5 * 60_000;
const MAX_GAP_MS = 60_000; // longer gaps between saved rows are sleep, not use
// Just after plugging in, older saves may still carry figures from before it.
const SETTLE_MS = 65_000;
const MIN_JUDGED_MS = 10 * 60_000; // judge a charger only after 10 minutes of use
const WEAK_SHARE = 0.05; // fell short at least 5% of the time...
const WEAK_GAP_MW = 2000; // ...by at least 2 W at some point
const CHARGE_HEADROOM_W = 10; // spare power a charger needs to also charge the battery
const STANDARD_SIZES = [30, 35, 45, 61, 65, 67, 70, 96, 100, 140];

const roundW = (mw) => Math.round(mw / 100) / 10;

/**
 * Summarises saved rows (oldest first) into one entry per charger, plus how
 * hard the laptop works. Pure, so it can be tested without a database.
 */
export function summariseChargers(rows) {
  const byWatts = new Map();
  const loads = [];
  let pluggedAt = null;
  let prev = null;

  rows.forEach((row, i) => {
    if (row.system_load_mw != null) loads.push(row.system_load_mw);

    const plugged = row.external === 1 && row.watts != null;
    const newSession = plugged && (!prev || prev.external !== 1 || prev.watts !== row.watts);
    if (newSession) pluggedAt = row.ts;
    prev = row;
    if (!plugged) return;

    let c = byWatts.get(row.watts);
    if (!c) {
      c = {
        watts: row.watts, ms: 0, drainMs: 0, chargeMs: 0, sessions: 0,
        maxInMw: null, maxShortMw: null, maxChargeMw: null, firstSeen: row.ts, lastSeen: row.ts,
      };
      byWatts.set(row.watts, c);
    }
    if (newSession) c.sessions += 1;
    c.lastSeen = row.ts;

    const next = rows[i + 1];
    const dt = next ? Math.min(next.ts - row.ts, MAX_GAP_MS) : 0;
    if (row.ts - pluggedAt < SETTLE_MS) return; // figures may predate plugging in

    c.ms += dt;
    if (row.adapter_in_mw != null) c.maxInMw = Math.max(c.maxInMw ?? 0, row.adapter_in_mw);
    if (row.state === 'draining_on_ac') {
      c.drainMs += dt;
      if (row.battery_mw != null) c.maxShortMw = Math.max(c.maxShortMw ?? 0, -row.battery_mw);
    } else if (row.state === 'charging') {
      c.chargeMs += dt;
      if (row.battery_mw != null) c.maxChargeMw = Math.max(c.maxChargeMw ?? 0, row.battery_mw);
    }
  });

  // How hard the laptop works: the draw it stays under 95% of the time.
  loads.sort((a, b) => a - b);
  const busyMw = loads.length >= 30 ? loads[Math.floor(loads.length * 0.95)] : null;
  const busyW = busyMw != null ? roundW(busyMw) : null;
  const recommendW =
    busyW != null ? (STANDARD_SIZES.find((size) => size >= busyW + CHARGE_HEADROOM_W) ?? 140) : null;

  const chargers = [...byWatts.values()]
    .map((c) => judge(c, recommendW, busyW))
    .sort((a, b) => b.lastSeen - a.lastSeen);
  return { chargers, busyW, recommendW };
}

function judge(c, recommendW, busyW) {
  const minutes = Math.round(c.ms / 60_000);
  const share = c.ms > 0 ? c.drainMs / c.ms : 0;
  const base = {
    watts: c.watts,
    minutes,
    sessions: c.sessions,
    lastSeen: c.lastSeen,
    shortSharePct: Math.round(share * 100),
    maxShortW: c.maxShortMw != null ? roundW(c.maxShortMw) : null,
    maxInW: c.maxInMw != null ? roundW(c.maxInMw) : null,
    maxChargeW: c.maxChargeMw != null ? roundW(c.maxChargeMw) : null,
  };

  if (c.ms < MIN_JUDGED_MS) {
    return { ...base, verdict: 'learning', summary: 'Not enough use yet to judge. Keep using it and a verdict appears after 10 minutes.' };
  }
  if (share >= WEAK_SHARE && (c.maxShortMw ?? 0) >= WEAK_GAP_MW) {
    return {
      ...base,
      verdict: 'weak',
      summary:
        `Couldn't keep up ${base.shortSharePct}% of the time, falling up to ${base.maxShortW} W short, ` +
        'so the battery drained while plugged in.' +
        (recommendW && recommendW > c.watts ? ` A ${recommendW} W charger would keep up.` : ''),
    };
  }
  // Kept up so far, but rated below what this laptop draws when busy.
  const untested = busyW != null && c.watts < busyW;
  return {
    ...base,
    verdict: 'good',
    summary:
      (base.maxChargeW != null
        ? `Kept up, and charged the battery at up to ${base.maxChargeW} W.`
        : 'Kept up the whole time it was plugged in.') +
      (untested ? ` It has only seen light use: when busy, this laptop draws about ${Math.round(busyW)} W, more than this charger gives.` : ''),
  };
}

/** Charger memory over the saved history, recomputed at most every few minutes. */
export class ChargerMemory {
  #store;
  #cache = null;
  #cachedAt = 0;

  constructor(store) {
    this.#store = store;
  }

  report(now = Date.now(), { refresh = false } = {}) {
    if (refresh || !this.#cache || now - this.#cachedAt > CACHE_MS) {
      this.#cache = summariseChargers(this.#store.chargerRows(now - LOOKBACK_MS));
      this.#cachedAt = now;
    }
    return this.#cache;
  }

  /** What is known about the charger with this rating, if anything. */
  lookup(watts, now = Date.now()) {
    if (watts == null) return null;
    const report = this.report(now);
    const charger = report.chargers.find((c) => c.watts === watts);
    return charger ? { ...charger, recommendW: report.recommendW } : null;
  }
}
