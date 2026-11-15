// Charger memory, the plug/unplug settling logic, and the alert it drives.

import test from 'node:test';
import assert from 'node:assert/strict';

import { summariseChargers } from '../src/chargers.js';
import { figuresPredateChange, settle } from '../src/platform/mac.js';
import { Estimator } from '../src/estimator.js';
import { Alerts } from '../src/alerts.js';

const MIN = 60_000;

/** Rows every 30 s for `minutes`, plugged into a charger of `watts`, in `state`. */
function session(start, minutes, watts, state, { batteryMw = 0, inMw = 40_000, loadMw = 40_000 } = {}) {
  const rows = [];
  for (let t = 0; t < minutes * MIN; t += 30_000) {
    rows.push({
      ts: start + t, external: 1, watts, state,
      adapter_in_mw: inMw, system_load_mw: loadMw, battery_mw: batteryMw,
    });
  }
  return rows;
}
const unplugged = (ts, loadMw = 20_000) => ({
  ts, external: 0, watts: null, state: 'discharging', adapter_in_mw: 0, system_load_mw: loadMw, battery_mw: -loadMw,
});

test('a charger that keeps falling short is judged weak, with a size that would keep up', () => {
  const rows = [
    ...session(0, 30, 45, 'draining_on_ac', { batteryMw: -14_000, inMw: 43_000, loadMw: 57_000 }),
    ...session(30 * MIN, 30, 45, 'charging', { batteryMw: 5000, inMw: 43_000, loadMw: 38_000 }),
  ];
  const { chargers, busyW, recommendW } = summariseChargers(rows);
  assert.equal(chargers.length, 1);
  const c = chargers[0];
  assert.equal(c.verdict, 'weak');
  assert.equal(c.maxShortW, 14);
  assert.ok(c.shortSharePct >= 45 && c.shortSharePct <= 55, `short share ${c.shortSharePct}`);
  assert.equal(busyW, 57);
  assert.equal(recommendW, 67, 'smallest standard size with 10 W to spare above 57 W');
  assert.match(c.summary, /67 W charger would keep up/);
});

test('figures from the first minute after plugging in are ignored', () => {
  // Stale "draining" rows right after plugging in, then a long healthy session.
  const rows = [
    unplugged(0),
    ...session(30_000, 1, 96, 'draining_on_ac', { batteryMw: -20_000 }),
    ...session(90_000, 30, 96, 'charging', { batteryMw: 30_000, inMw: 80_000, loadMw: 50_000 }),
  ];
  const [c] = summariseChargers(rows).chargers;
  assert.equal(c.verdict, 'good');
  assert.equal(c.maxShortW, null);
  assert.equal(c.maxChargeW, 30);
  assert.equal(c.sessions, 1);
});

test('a charger used only briefly is still learning; chargers are told apart by watts', () => {
  const rows = [
    ...session(0, 20, 100, 'charging', { batteryMw: 40_000 }),
    unplugged(20 * MIN),
    ...session(21 * MIN, 5, 65, 'charging', { batteryMw: 10_000 }),
  ];
  const { chargers } = summariseChargers(rows);
  assert.deepEqual(chargers.map((c) => [c.watts, c.verdict]), [[65, 'learning'], [100, 'good']]);
});

test('a small charger that has only seen light use says so', () => {
  const rows = [
    ...Array.from({ length: 60 }, (_, i) => unplugged(i * 30_000, 55_000)), // busy on battery
    ...session(40 * MIN, 30, 30, 'holding', { inMw: 20_000, loadMw: 20_000 }),
  ];
  const [c] = summariseChargers(rows).chargers;
  assert.equal(c.verdict, 'good');
  assert.match(c.summary, /only seen light use/);
});

test('sleep gaps between saved rows do not count as use', () => {
  const rows = [
    ...session(0, 5, 45, 'draining_on_ac', { batteryMw: -10_000 }),
    ...session(8 * 60 * MIN, 20, 45, 'charging', { batteryMw: 10_000 }), // 8 hours later
  ];
  const [c] = summariseChargers(rows).chargers;
  assert.ok(c.minutes <= 26, `counted ${c.minutes} minutes`);
});

// ------------------------------------------------------------------ settling

test('figures published before a plug or unplug are recognised as stale', () => {
  assert.equal(figuresPredateChange(1000, 2000), true); // published, then the change
  assert.equal(figuresPredateChange(3000, 2000), false); // published after the change
  assert.equal(figuresPredateChange(null, 2000), false); // no timestamp: trust the figures
  assert.equal(figuresPredateChange(1000, null), false); // no change seen yet
});

test('the minute after plugging in reads as "Charger connected", never as draining', () => {
  const sample = settle({
    ts: 1, percent: 60, remainingMah: 3000, fullMah: 5000, externalConnected: true,
    amperageMa: -1500, batteryPowerMw: -17_000, adapterInMw: 0, systemLoadMw: 17_000,
    adapter: { watts: 45 }, gauge: { toEmptyMin: 90, toFullMin: null },
  });
  assert.equal(sample.batteryPowerMw, null);
  assert.equal(sample.adapter.watts, null);
  const profile = { timeToFull: () => null, typicalTimeToEmpty: () => null };
  const d = new Estimator(profile).update(sample);
  assert.equal(d.state, 'connecting');
  assert.equal(d.headline, 'Charger connected');
  assert.equal(d.etaMin, null);
});

// ------------------------------------------------------------------ alert

test('plugging in a charger with a poor record raises one warning', async () => {
  const saved = [];
  const store = { lastAlertTimes: () => new Map(), addAlert: (a) => (saved.push(a), a) };
  const record = { verdict: 'weak', shortSharePct: 25, maxShortW: 26, recommendW: 65 };
  const alerts = new Alerts(store, () => false, (watts) => (watts === 45 ? record : null));
  const sample = (ts, external, watts) => ({
    ts, percent: 80, externalConnected: external, adapter: external ? { watts } : null,
  });
  const d = { state: 'holding', etaKind: null, etaMin: null };

  await alerts.evaluate(sample(0, false), { ...d, state: 'discharging' });
  const fired = await alerts.evaluate(sample(1000, true, 45), d);
  assert.deepEqual(fired.map((a) => a.kind), ['weak_charger_45']);
  assert.match(fired[0].body, /fell short 25% of the time, by up to 26 W\. .*; a 65 W charger would keep up\./);
  assert.equal('cooldownMs' in saved[0], false);

  await alerts.evaluate(sample(2000, false), { ...d, state: 'discharging' });
  const again = await alerts.evaluate(sample(3000, true, 45), d);
  assert.equal(again.length, 0, 'quiet within the cooldown');

  await alerts.evaluate(sample(4000, false), { ...d, state: 'discharging' });
  assert.equal((await alerts.evaluate(sample(5000, true, 100), d)).length, 0, 'no record, no warning');
});
