// Alert rules. Each rule fires on a change (a threshold crossed, a state that
// has lasted long enough) and then stays quiet for its cooldown, so the same
// situation never produces a stream of notifications.

import { notify } from './notify.js';

const MIN = 60_000;
const DRAIN_SUSTAINED_MS = 3 * MIN; // ignore short spikes above the adapter's output

const COOLDOWN = {
  draining_on_ac: 45 * MIN,
  low_20: 30 * MIN,
  low_10: 30 * MIN,
  eta_15: 20 * MIN,
  reached_80: 6 * 60 * MIN,
  full: 6 * 60 * MIN,
};

const watts = (mw) => (Math.abs(mw ?? 0) / 1000).toFixed(0);
const losingCharge = (state) => state === 'discharging' || state === 'draining_on_ac';

function duration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export class Alerts {
  #store;
  #enabled; // () => boolean: are desktop notifications switched on?
  #chargerRecord; // (watts) => what charger memory knows about that charger
  #deliver; // (alert) => Promise<boolean>: shows a desktop notification
  #lastFired;
  #prev = null; // previous { percent, state }
  #drainSince = null;

  constructor(store, enabled, chargerRecord = () => null, deliver = (a) => notify(a.title, a.body)) {
    this.#store = store;
    this.#enabled = enabled;
    this.#chargerRecord = chargerRecord;
    this.#deliver = deliver;
    this.#lastFired = store.lastAlertTimes();
  }

  /** Checks every rule against the newest sample; returns the alerts raised. */
  async evaluate(s, d) {
    const prev = this.#prev;
    const crossedDown = (level) =>
      losingCharge(d.state) &&
      s.percent <= level &&
      (!prev || prev.percent > level || !losingCharge(prev.state));

    this.#drainSince = d.state === 'draining_on_ac' ? (this.#drainSince ?? s.ts) : null;
    const left = d.etaKind === 'empty' && d.etaMin != null ? ` About ${duration(d.etaMin)} left.` : '';
    const candidates = [];

    if (this.#drainSince != null && s.ts - this.#drainSince >= DRAIN_SUSTAINED_MS) {
      candidates.push({
        kind: 'draining_on_ac',
        severity: 'warning',
        title: "Charger can't keep up",
        body:
          (s.adapterInMw != null && s.systemLoadMw != null
            ? `The ${s.adapter?.watts ? `${s.adapter.watts} W adapter` : 'charger'} delivers ${watts(s.adapterInMw)} W ` +
              `but the laptop is using ${watts(s.systemLoadMw)} W, so the battery is draining.`
            : `The charger is connected, but the battery is still losing ${watts(s.batteryPowerMw)} W.`) + left,
      });
    }
    if (crossedDown(10)) {
      candidates.push({
        kind: 'low_10',
        severity: 'critical',
        title: `Battery at ${s.percent}%`,
        body: `Plug in a stronger charger or save your work.${left}`,
      });
    } else if (crossedDown(20)) {
      candidates.push({
        kind: 'low_20',
        severity: 'warning',
        title: `Battery at ${s.percent}%`,
        body: `Running low.${left}`,
      });
    }
    if (d.etaKind === 'empty' && d.etaMin != null && d.etaMin <= 15) {
      candidates.push({
        kind: 'eta_15',
        severity: 'critical',
        title: `About ${duration(Math.max(1, d.etaMin))} of battery left`,
        body: `At ${s.percent}% and using ${watts(s.batteryPowerMw)} W from the battery. Save your work.`,
      });
    }
    // Reminder to unplug at the level chosen in Alerts (80% unless changed, or off).
    const unplugAt = Number(this.#store.getSetting?.('unplugAt', '80'));
    if (unplugAt && d.state === 'charging' && s.percent >= unplugAt && prev && prev.percent < unplugAt) {
      candidates.push({
        kind: 'reached_80',
        severity: 'good',
        title: `Charged to ${unplugAt}%, good time to unplug`,
        body: 'Batteries wear more slowly when they are not kept full, so unplugging around here helps it last.',
      });
    }
    // A charger just connected (or its rating just became known) that has fallen short before.
    const chargerWatts = s.externalConnected ? (s.adapter?.watts ?? null) : null;
    if (chargerWatts != null && prev && (!prev.external || prev.watts !== chargerWatts)) {
      const record = this.#chargerRecord(chargerWatts);
      if (record?.verdict === 'weak') {
        candidates.push({
          kind: `weak_charger_${chargerWatts}`,
          cooldownMs: 6 * 60 * MIN,
          severity: 'warning',
          title: `This ${chargerWatts} W charger can't keep up`,
          body:
            `Before, it fell short ${record.shortSharePct}% of the time, by up to ${record.maxShortW} W. ` +
            'Expect the battery to drain while you work hard' +
            (record.recommendW && record.recommendW > chargerWatts ? `; a ${record.recommendW} W charger would keep up.` : '.'),
        });
      }
    }
    if (d.state === 'full' && prev && prev.state !== 'full') {
      candidates.push({ kind: 'full', severity: 'good', title: 'Fully charged', body: 'The battery is at 100%.' });
    }

    this.#prev = { percent: s.percent, state: d.state, external: s.externalConnected, watts: chargerWatts };
    return this.#fire(candidates, s.ts);
  }

  /** Raises one alert from outside the per-sample rules (the energy-hog watch). */
  raise(candidate, ts = Date.now()) {
    return this.#fire([candidate], ts);
  }

  // Notifies and saves each candidate that is not inside its cooldown.
  async #fire(candidates, ts) {
    const fired = [];
    for (const c of candidates) {
      const last = this.#lastFired.get(c.kind);
      if (last != null && ts - last < (COOLDOWN[c.kind] ?? c.cooldownMs)) continue;
      this.#lastFired.set(c.kind, ts);
      const { cooldownMs, ...alert } = c;
      const notified = this.#enabled() ? await this.#deliver({ ...alert, ts }) : false;
      fired.push(this.#store.addAlert({ ...alert, ts, notified }));
    }
    return fired;
  }
}
