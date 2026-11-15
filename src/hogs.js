// Energy-hog watch: notices when one app is responsible for most of the power
// being used while the battery is draining, and estimates what that costs.
//
// It works from the same per-app measurement the dashboard shows (energy
// impact on macOS, CPU share on Windows and Linux) and turns an app's share
// of it into rough watts and minutes of battery.

const SUSTAIN_MS = 150_000; // must hold for about 2.5 minutes, not just a spike
// Busy in absolute terms: about one processor core flat out (energy impact on
// macOS and CPU percent elsewhere both read roughly 100 for that)...
const MIN_VALUE = { energy: 80, cpu: 80 };
// ...and a large part of everything measured. Tested against real use: a
// runaway process alongside a browser and the display sits at 30-45%.
const MIN_SHARE = 0.3;
const ALERT_COOLDOWN_MS = 30 * 60_000;

// Parts of the system that cannot be quit, so naming them would not help.
const SYSTEM = new Set([
  'WindowServer (display)', 'kernel_task (system)', 'Audio', 'Wi-Fi driver', 'launchd',
  'Xorg', 'Xwayland', 'gnome-shell', 'kwin_x11', 'kwin_wayland', 'systemd',
  'System', 'Idle', 'dwm', 'Memory Compression',
]);

const onBattery = (state) => state === 'discharging' || state === 'draining_on_ac';

function duration(min) {
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * What one app costs, from its share of the measured energy and the laptop's
 * total draw. Rough by nature: energy impact is not exactly watts.
 */
export function estimateCost(share, latest) {
  if (!latest) return {};
  const d = latest.derived ?? {};
  const loadMw =
    latest.systemLoadMw ?? (latest.batteryPowerMw != null && latest.batteryPowerMw < 0 ? -latest.batteryPowerMw : null);
  if (loadMw == null || loadMw <= 0) return {};
  const appW = (share * loadMw) / 1000;
  const loadW = loadMw / 1000;
  const cost = { appW: Math.round(appW), loadW: Math.round(loadW) };

  // Time left now versus with the app quit, at the same draw otherwise.
  if (d.etaKind === 'empty' && d.etaMin != null && loadW - appW > 1) {
    cost.minutesGained = Math.round(d.etaMin * (loadW / (loadW - appW)) - d.etaMin);
  }
  // On a charger that cannot keep up: would the charger cope without this app?
  if (d.state === 'draining_on_ac' && latest.batteryPowerMw != null) {
    cost.chargerWouldCope = appW >= -latest.batteryPowerMw / 1000;
  }
  return cost;
}

export function hogAlert(hog) {
  const parts = [
    `It is using ${hog.sharePct}% of the energy right now` +
      (hog.appW != null ? `, roughly ${hog.appW} W of the ${hog.loadW} W the laptop is drawing.` : '.'),
  ];
  if (hog.chargerWouldCope) parts.push('Without it, your charger could keep up.');
  else if (hog.minutesGained != null && hog.minutesGained >= 5) {
    parts.push(`Quitting it would add about ${duration(hog.minutesGained)} of battery.`);
  } else parts.push('Quitting it would make the battery last longer.');
  return {
    kind: `hog_${hog.name}`,
    cooldownMs: ALERT_COOLDOWN_MS,
    severity: 'warning',
    title: `${hog.name} is draining your battery`,
    body: parts.join(' '),
  };
}

export class HogWatch {
  #candidate = null; // { name, since } while an app looks like a hog
  #current = null; // the confirmed hog, for the dashboard
  #announced = null; // name of the hog already alerted for in this episode

  /**
   * Takes one per-app measurement and the latest battery reading. Returns the
   * hog when it has just been confirmed (time to alert), otherwise null.
   */
  observe(energy, latest, now = Date.now()) {
    const top = this.#topApp(energy);
    if (!top || !latest || !onBattery(latest.derived?.state)) {
      this.#candidate = null;
      this.#current = null;
      this.#announced = null;
      return null;
    }

    if (this.#candidate?.name !== top.name) this.#candidate = { name: top.name, since: now };
    if (now - this.#candidate.since < SUSTAIN_MS) {
      this.#current = null;
      return null;
    }

    this.#current = {
      name: top.name,
      sharePct: Math.round(top.share * 100),
      value: top.value,
      metric: energy.metric,
      since: this.#candidate.since,
      ...estimateCost(top.share, latest),
    };
    if (this.#announced === top.name) return null;
    this.#announced = top.name;
    return this.#current;
  }

  /** The confirmed hog right now, or null. */
  current() {
    return this.#current;
  }

  #topApp(energy) {
    if (!energy?.apps?.length || !(energy.total > 0)) return null;
    const app = energy.apps.find((a) => !SYSTEM.has(a.name));
    if (!app) return null;
    const share = app.power / energy.total;
    const minValue = MIN_VALUE[energy.metric] ?? MIN_VALUE.cpu;
    return share >= MIN_SHARE && app.power >= minValue ? { name: app.name, share, value: app.power } : null;
  }
}
