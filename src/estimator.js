// Turns raw samples into a verdict: what state the battery is in, how long
// until empty or full, and a plain-language explanation.

const TAU_MS = 45_000; // smoothing time constant for the current
const DEAD_BAND_MA = 40; // below this the battery is effectively idle

const watts = (mw) => (Math.abs(mw) / 1000).toFixed(1);

export class Estimator {
  #profile;
  #ema = null;
  #lastTs = null;
  #lastFlow = null;

  /** @param profile learned charging and usage behaviour (see learning.js) */
  constructor(profile) {
    this.#profile = profile;
  }

  update(s) {
    const ma = s.amperageMa ?? 0;
    const flow = `${s.externalConnected}:${Math.abs(ma) < DEAD_BAND_MA ? 0 : Math.sign(ma)}`;

    // Restart smoothing whenever the direction of flow changes (plug, unplug,
    // or the load crossing what the adapter can supply).
    if (this.#ema == null || flow !== this.#lastFlow) {
      this.#ema = ma;
    } else {
      const dt = Math.max(0, s.ts - this.#lastTs);
      const alpha = 1 - Math.exp(-dt / TAU_MS);
      this.#ema += alpha * (ma - this.#ema);
    }
    this.#lastTs = s.ts;
    this.#lastFlow = flow;

    const smoothedMa = Math.round(this.#ema);
    const state = classify(s, smoothedMa);
    const eta = estimate(s, state, smoothedMa, this.#profile);
    return { state, smoothedMa, ...eta, ...describe(s, state) };
  }
}

function classify(s, ma) {
  // Plugged in moments ago: what the charger gives is not known yet.
  if (s.settling && s.externalConnected) return 'connecting';
  if (!s.externalConnected) return 'discharging';
  if (s.fullyCharged || (s.percent >= 99 && Math.abs(ma) < DEAD_BAND_MA)) return 'full';
  if (ma > DEAD_BAND_MA) return 'charging';
  if (ma < -DEAD_BAND_MA) return 'draining_on_ac';
  return 'holding';
}

function estimate(s, state, ma, profile) {
  const none = { etaMin: null, etaKind: null, etaBasis: null, gaugeEtaMin: null, typical: null };
  if (s.remainingMah == null || s.fullMah == null) return none;

  if ((state === 'discharging' || state === 'draining_on_ac') && ma < 0) {
    return {
      etaMin: Math.round((s.remainingMah / -ma) * 60),
      etaKind: 'empty',
      etaBasis: 'rate',
      gaugeEtaMin: s.gauge.toEmptyMin,
      // Only meaningful unplugged: how long this charge lasts at the usual draw.
      typical: state === 'discharging' ? profile.typicalTimeToEmpty(s) : null,
    };
  }

  if (state === 'charging' && ma > 0) {
    const toFull = profile.timeToFull(s, ma);
    if (!toFull) return none;
    return {
      etaMin: toFull.minutes,
      etaKind: 'full',
      etaBasis: toFull.basis,
      gaugeEtaMin: s.gauge.toFullMin,
      typical: null,
    };
  }

  return none;
}

function describe(s, state) {
  const inMw = s.adapterInMw;
  const loadMw = s.systemLoadMw;
  const battMw = s.batteryPowerMw ?? 0;
  const adapter = s.adapter?.watts ? `${s.adapter.watts} W adapter` : 'charger';
  // Some systems report only the battery's own flow, not adapter input or total load.
  const known = inMw != null && loadMw != null;

  if (s.settling) {
    return state === 'connecting'
      ? {
          severity: 'good',
          label: 'Charger connected',
          headline: 'Charger connected',
          detail: 'Reading how much power it gives. The battery reports new figures once a minute, so this takes up to a minute.',
        }
      : {
          severity: s.percent <= 10 ? 'critical' : s.percent <= 20 ? 'warning' : 'neutral',
          label: 'On battery',
          headline: 'Charger unplugged, running on battery',
          detail: 'Reading how much power the laptop is using. The battery reports new figures once a minute, so this takes up to a minute.',
        };
  }

  switch (state) {
    case 'draining_on_ac':
      return {
        severity: 'warning',
        label: 'Draining on charger',
        headline: 'Plugged in, but the battery is still draining',
        detail: known
          ? `The ${adapter} is delivering ${watts(inMw)} W while the laptop is using ${watts(loadMw)} W. ` +
            `The battery is covering the ${watts(battMw)} W gap.`
          : `The ${adapter} is connected, but the laptop needs more than it delivers. ` +
            `The battery is covering a ${watts(battMw)} W gap.`,
      };
    case 'charging':
      return {
        severity: 'good',
        label: 'Charging',
        headline: `Charging at ${watts(battMw)} W`,
        detail:
          (known
            ? `${watts(inMw)} W from the ${adapter}, ${watts(loadMw)} W used by the laptop.`
            : `Power from the ${adapter} is filling the battery.`) +
          (s.slowChargingReason ? ' The system reports this as slow charging.' : ''),
      };
    case 'discharging':
      return {
        severity: s.percent <= 10 ? 'critical' : s.percent <= 20 ? 'warning' : 'neutral',
        label: s.percent <= 10 ? 'Battery critical' : s.percent <= 20 ? 'Battery low' : 'On battery',
        headline: 'Running on battery',
        detail: `The laptop is using ${watts(loadMw ?? battMw)} W.`,
      };
    case 'full':
      return {
        severity: 'good',
        label: 'Full',
        headline: 'Fully charged',
        detail: `The ${adapter} is running the laptop directly${known ? ` (${watts(loadMw)} W)` : ''}.`,
      };
    default:
      return {
        severity: 'neutral',
        label: 'Not charging',
        headline: `Plugged in, holding at ${s.percent}%`,
        detail:
          `The ${adapter} is running the laptop directly${known ? ` (${watts(loadMw)} W)` : ''}. ` +
          'The battery is resting.',
      };
  }
}
