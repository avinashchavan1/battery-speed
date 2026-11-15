// Built-in analysis: turns saved history into plain-language findings, with
// no AI service and no key. Used for the morning digest and, when no AI model
// is available, for the written summary.

const MAX_GAP_MS = 60_000; // longer gaps between saved rows are sleep, not use
const MIN_NOTABLE_MS = 5 * 60_000;

export function duration(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Totals for one period of saved rows (oldest first). */
export function analysePeriod(rows) {
  const s = {
    trackedMs: 0, onBatteryMs: 0, drainOnChargerMs: 0, chargingMs: 0,
    batteryWh: 0, usedPct: 0, chargedPct: 0, lowest: null,
    avgLoadW: null, peakLoadW: null, drainByCharger: [],
  };
  const byCharger = new Map();
  let loadSum = 0;
  let loadMs = 0;

  rows.forEach((r, i) => {
    const next = rows[i + 1];
    const gap = next ? next.ts - r.ts : 0;
    const dt = Math.min(gap, MAX_GAP_MS);
    s.trackedMs += dt;
    if (r.percent != null) s.lowest = s.lowest == null ? r.percent : Math.min(s.lowest, r.percent);
    if (r.state === 'discharging') s.onBatteryMs += dt;
    if (r.state === 'charging') s.chargingMs += dt;
    if (r.state === 'draining_on_ac') {
      s.drainOnChargerMs += dt;
      if (r.watts != null) {
        const c = byCharger.get(r.watts) ?? { ms: 0, loadSum: 0, loadMs: 0 };
        c.ms += dt;
        // What the laptop drew while this charger was falling short.
        if (r.system_load_mw != null) {
          c.loadSum += r.system_load_mw * dt;
          c.loadMs += dt;
        }
        byCharger.set(r.watts, c);
      }
    }
    if (r.battery_mw != null && r.battery_mw < 0) s.batteryWh += (-r.battery_mw * dt) / 3.6e9; // mW x ms -> Wh
    if (r.system_load_mw != null && dt > 0) {
      loadSum += r.system_load_mw * dt;
      loadMs += dt;
      s.peakLoadW = Math.max(s.peakLoadW ?? 0, r.system_load_mw / 1000);
    }
    // Charge used or gained, only across rows close enough to be the same stretch of use.
    if (next && gap <= MAX_GAP_MS && r.percent != null && next.percent != null) {
      const change = next.percent - r.percent;
      if (change < 0) s.usedPct -= change;
      else s.chargedPct += change;
    }
  });

  if (loadMs > 0) s.avgLoadW = loadSum / loadMs / 1000;
  s.drainByCharger = [...byCharger]
    .map(([watts, c]) => ({ watts, ms: c.ms, loadW: c.loadMs > 0 ? c.loadSum / c.loadMs / 1000 : null }))
    .sort((a, b) => b.ms - a.ms);
  s.batteryWh = Math.round(s.batteryWh);
  return s;
}

/** Merges per-day app totals (several days) into one ranking with shares. */
export function rankApps(rows) {
  const byName = new Map();
  for (const r of rows) {
    const app = byName.get(r.name) ?? { name: r.name, total: 0, minutes: 0 };
    app.total += r.total;
    app.minutes = Math.max(app.minutes, r.minutes);
    byName.set(r.name, app);
  }
  const apps = [...byName.values()].sort((a, b) => b.total - a.total);
  const sum = apps.reduce((total, a) => total + a.total, 0);
  return apps.map((a) => ({ ...a, sharePct: sum > 0 ? Math.round((a.total / sum) * 100) : 0 }));
}

// Parts of the system that cannot be quit, left out of "biggest drain".
const SYSTEM = new Set(['WindowServer (display)', 'kernel_task (system)', 'Audio', 'Wi-Fi driver', 'launchd']);
const topUserApp = (apps) => apps.find((a) => !SYSTEM.has(a.name) && a.minutes >= 5) ?? null;

/** The morning digest: one title and a few short lines about a day. */
export function digestText(stats, apps) {
  if (stats.trackedMs < MIN_NOTABLE_MS) return null; // the laptop was barely used
  const lines = [];
  const title =
    stats.onBatteryMs >= MIN_NOTABLE_MS
      ? `Yesterday: ${duration(stats.onBatteryMs)} on battery`
      : 'Yesterday: plugged in most of the time';

  if (stats.usedPct > 0) {
    lines.push(
      `Used ${stats.usedPct}% of the battery` +
        (stats.batteryWh > 0 ? ` (${stats.batteryWh} Wh)` : '') +
        (stats.lowest != null ? `, down to ${stats.lowest}% at the lowest.` : '.'),
    );
  }
  const top = topUserApp(apps);
  if (top) lines.push(`Biggest drain: ${top.name}, ${top.sharePct}% of the energy measured on battery.`);
  for (const c of stats.drainByCharger.filter((c) => c.ms >= MIN_NOTABLE_MS)) {
    lines.push(`The ${c.watts} W charger fell short for ${duration(c.ms)}.`);
  }
  if (!lines.length) lines.push('Nothing unusual.');
  return { title, lines };
}

/**
 * The written summary when no AI model is available: the most important
 * finding, the numbers, and up to three suggestions backed by the data.
 */
export function builtinSummary({ stats, apps, latest, chargerReport }) {
  if (stats.trackedMs < MIN_NOTABLE_MS) {
    return 'There is not enough history from the last 24 hours to say much yet. Keep Battery Speed running and try again later.';
  }
  const paragraphs = [];
  const avg = stats.avgLoadW != null ? `${Math.round(stats.avgLoadW)} W` : null;
  const weak = stats.drainByCharger[0];
  const top = topUserApp(apps);

  // 1. The headline.
  if (weak && weak.ms >= 10 * 60_000) {
    paragraphs.push(
      `Your charger was the main problem. For ${duration(weak.ms)} you were plugged into the ${weak.watts} W charger and still losing charge, ` +
        `because it gives less than the laptop was using` +
        (weak.loadW != null ? ` (about ${Math.round(weak.loadW)} W at those times).` : '.'),
    );
  } else if (top && top.sharePct >= 35) {
    paragraphs.push(`${top.name} was the biggest drain on the battery, using ${top.sharePct}% of the energy measured while unplugged.`);
  } else if (stats.onBatteryMs >= MIN_NOTABLE_MS) {
    paragraphs.push(
      `A normal day. You spent ${duration(stats.onBatteryMs)} on battery and used ${stats.usedPct}% of the charge` +
        (avg ? `, with the laptop drawing about ${avg}.` : '.'),
    );
  } else {
    paragraphs.push('You were plugged in nearly all the time, so the battery barely worked.');
  }

  // 2. The numbers.
  const facts = [
    stats.onBatteryMs > 0 ? `${duration(stats.onBatteryMs)} on battery` : null,
    stats.chargingMs > 0 ? `${duration(stats.chargingMs)} charging` : null,
    stats.usedPct > 0 ? `${stats.usedPct}% of the charge used${stats.batteryWh > 0 ? ` (${stats.batteryWh} Wh)` : ''}` : null,
    stats.lowest != null ? `lowest level ${stats.lowest}%` : null,
  ].filter(Boolean);
  let numbers = facts.length ? `In the last 24 hours: ${facts.join(', ')}.` : '';
  if (avg && stats.peakLoadW != null) numbers += ` The laptop drew ${avg} on average and up to ${Math.round(stats.peakLoadW)} W at its busiest.`;
  if (numbers) paragraphs.push(numbers.trim());

  // 3. What to do, only where the data backs it.
  const tips = [];
  const rec = chargerReport?.recommendW;
  if (weak && weak.ms >= 10 * 60_000) {
    tips.push(
      rec && rec > weak.watts
        ? `Use a ${rec} W or bigger charger while you work; the ${weak.watts} W one cannot keep up.`
        : `Use a bigger charger while you work; the ${weak.watts} W one cannot keep up.`,
    );
  }
  if (top && top.sharePct >= 25) tips.push(`Quit ${top.name} when you do not need it on battery.`);
  if (latest?.fullMah && latest?.designMah) {
    const health = Math.round((latest.fullMah / latest.designMah) * 100);
    if (health < 80) {
      tips.push(
        `Battery health is ${health}%. Apple designs these batteries to keep 80% after 1,000 cycles` +
          (latest.cycleCount != null ? ` and this one is at ${latest.cycleCount}` : '') +
          ', so unplugging around 80% when you can is worth it.',
      );
    }
  }
  paragraphs.push(tips.length ? tips.join(' ') : 'Nothing needs changing.');
  return paragraphs.join('\n\n');
}
