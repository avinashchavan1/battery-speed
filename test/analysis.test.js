// Built-in analysis, morning digest, unplug reminder, and summary engine choice.

import test from 'node:test';
import assert from 'node:assert/strict';

import { analysePeriod, rankApps, digestText, builtinSummary } from '../src/analysis.js';
import { writeSummaryText } from '../src/summary.js';
import { Alerts } from '../src/alerts.js';

const MIN = 60_000;

/** One row every 30 s for `minutes`, falling or rising `pctPerMin`. */
function stretch(start, minutes, { state, percent, pctPerMin = 0, batteryMw = 0, loadMw = 20_000, external = 0, watts = null }) {
  const rows = [];
  for (let t = 0; t < minutes * MIN; t += 30_000) {
    rows.push({
      ts: start + t, state, external, watts, battery_mw: batteryMw, system_load_mw: loadMw,
      percent: Math.round(percent + (pctPerMin * t) / MIN),
    });
  }
  return rows;
}

const DAY = [
  // Two hours on battery at 20 W, falling from 90% to 50%.
  ...stretch(0, 120, { state: 'discharging', percent: 90, pctPerMin: -1 / 3, batteryMw: -20_000 }),
  // Then 40 minutes on a 45 W charger that cannot keep up.
  ...stretch(10 * 60 * MIN, 40, {
    state: 'draining_on_ac', percent: 50, pctPerMin: -0.1, batteryMw: -12_000, loadMw: 55_000, external: 1, watts: 45,
  }),
];
const APPS = rankApps([
  { name: 'ffmpeg', total: 6000, minutes: 60 },
  { name: 'WindowServer (display)', total: 3000, minutes: 120 },
  { name: 'Claude', total: 1000, minutes: 120 },
]);

test('a period is summed up without counting sleep', () => {
  const s = analysePeriod(DAY);
  // The last reading before the gap counts for up to a minute.
  assert.ok([120, 121].includes(Math.round(s.onBatteryMs / MIN)), `${s.onBatteryMs / MIN} min`);
  assert.equal(Math.round(s.drainOnChargerMs / MIN), 40);
  assert.ok(s.usedPct >= 42 && s.usedPct <= 46, `used ${s.usedPct}%`);
  assert.equal(s.batteryWh, 48); // 20 W for 2 h + 12 W for 40 min
  assert.deepEqual(s.drainByCharger.map((c) => [c.watts, Math.round(c.ms / MIN), c.loadW]), [[45, 40, 55]]);
  assert.ok(s.trackedMs < 3 * 60 * MIN, 'the 8-hour gap was not counted');
});

test('the morning digest names the time on battery, the biggest drain and a weak charger', () => {
  const digest = digestText(analysePeriod(DAY), APPS);
  assert.match(digest.title, /^Yesterday: 2 h( 1 min)? on battery$/);
  assert.match(digest.lines.join(' '), /Used \d+% of the battery \(48 Wh\)/);
  assert.match(digest.lines.join(' '), /Biggest drain: ffmpeg, 60%/);
  assert.match(digest.lines.join(' '), /The 45 W charger fell short for 40 min/);
});

test('a day the laptop was barely used gives no digest', () => {
  assert.equal(digestText(analysePeriod(stretch(0, 2, { state: 'discharging', percent: 50 })), []), null);
});

test('the built-in summary leads with the most important finding and backs each tip', () => {
  const text = builtinSummary({
    stats: analysePeriod(DAY),
    apps: APPS,
    latest: { fullMah: 6600, designMah: 8694, cycleCount: 428 },
    chargerReport: { recommendW: 65 },
  });
  const [headline, , tips] = text.split('\n\n');
  assert.match(headline, /^Your charger was the main problem/);
  assert.match(headline, /about 55 W at those times/, 'the draw while the charger fell short, not the day average');
  assert.match(tips, /Use a 65 W or bigger charger/);
  assert.match(tips, /Quit ffmpeg/);
  assert.match(tips, /Battery health is 76%/);
  assert.doesNotMatch(text, /NaN|undefined|null/);
});

test('with no Claude key and no local model, the built-in analysis writes the summary', async () => {
  // Point the local-model lookup at a port nothing listens on.
  process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
  const result = await writeSummaryText({ digest: {}, builtin: 'Built-in text.', apiKey: null });
  assert.equal(result.text, 'Built-in text.');
  assert.equal(result.engine.kind, 'builtin');
});

test('the unplug reminder follows the chosen level, and can be switched off', async () => {
  const run = async (level) => {
    const store = {
      lastAlertTimes: () => new Map(),
      addAlert: (a) => a,
      getSetting: (key, fallback) => (key === 'unplugAt' ? level : fallback),
    };
    const alerts = new Alerts(store, () => false);
    const s = (ts, percent) => ({ ts, percent, externalConnected: true, adapter: { watts: 96 } });
    const d = { state: 'charging', etaKind: 'full', etaMin: 30 };
    const fired = [];
    for (const [i, pct] of [78, 81, 84, 86, 89, 91].entries()) fired.push(...(await alerts.evaluate(s(i * MIN, pct), d)));
    return fired.filter((a) => a.kind === 'reached_80').map((a) => a.title);
  };
  assert.deepEqual(await run('80'), ['Charged to 80%, good time to unplug']);
  assert.deepEqual(await run('85'), ['Charged to 85%, good time to unplug']);
  assert.deepEqual(await run('off'), []);
});
