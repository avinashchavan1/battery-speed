// Energy-hog watch, its cost estimate, and a regression test for the alert
// rules that crashed on a sustained drain while plugged in (1.1.0).

import test from 'node:test';
import assert from 'node:assert/strict';

import { HogWatch, estimateCost, hogAlert } from '../src/hogs.js';
import { Alerts } from '../src/alerts.js';

const MIN = 60_000;
const energy = (apps) => ({
  metric: 'energy',
  apps: apps.map(([name, power]) => ({ name, power })),
  total: apps.reduce((sum, [, power]) => sum + power, 0),
});
const onBattery = { systemLoadMw: 40_000, batteryPowerMw: -40_000, derived: { state: 'discharging', etaKind: 'empty', etaMin: 120 } };
const charging = { systemLoadMw: 40_000, batteryPowerMw: 20_000, derived: { state: 'charging' } };
const HOG = energy([['ffmpeg', 180], ['WindowServer (display)', 50], ['Slack', 20], ['Audio', 10]]);
const CALM = energy([['Slack', 54], ['WindowServer (display)', 40], ['Google Chrome', 22], ['Audio', 12]]);

test('an app has to hog the battery for a couple of minutes before it is named', () => {
  const watch = new HogWatch();
  assert.equal(watch.observe(HOG, onBattery, 0), null);
  assert.equal(watch.observe(HOG, onBattery, 1 * MIN), null);
  assert.equal(watch.current(), null);

  const hog = watch.observe(HOG, onBattery, 3 * MIN);
  assert.equal(hog.name, 'ffmpeg');
  assert.equal(hog.sharePct, 69);
  assert.equal(watch.observe(HOG, onBattery, 4 * MIN), null, 'announced once per episode');
  assert.equal(watch.current().name, 'ffmpeg', 'still shown on the dashboard');
});

test('a runaway process is named even next to a busy browser and display', () => {
  // Measured live: four `yes` processes alongside Chrome and the display.
  const readings = [
    [['yes', 113.6], ['Google Chrome', 58.3], ['WindowServer (display)', 51.4], ['Slack', 30]],
    [['yes', 84.7], ['WindowServer (display)', 65.9], ['Google Chrome', 58.9], ['Slack', 30]],
    [['yes', 109.2], ['WindowServer (display)', 54.9], ['Google Chrome', 53.7], ['Slack', 30]],
    [['yes', 86.8], ['WindowServer (display)', 56.5], ['Google Chrome', 51.2], ['Slack', 30]],
  ];
  const watch = new HogWatch();
  const results = readings.map((apps, i) => watch.observe(energy(apps), onBattery, i * MIN));
  assert.equal(results.at(-1)?.name, 'yes');
});

test('a spike that drops away resets the clock', () => {
  const watch = new HogWatch();
  watch.observe(HOG, onBattery, 0);
  watch.observe(CALM, onBattery, 1 * MIN);
  assert.equal(watch.observe(HOG, onBattery, 2 * MIN), null);
  assert.equal(watch.observe(HOG, onBattery, 3 * MIN), null, 'only 1 minute since it came back');
  assert.ok(watch.observe(HOG, onBattery, 5 * MIN));
});

test('ordinary use, the charger, and parts of the system are never named', () => {
  const watch = new HogWatch();
  for (let t = 0; t <= 10 * MIN; t += MIN) assert.equal(watch.observe(CALM, onBattery, t), null);

  const plugged = new HogWatch();
  for (let t = 0; t <= 10 * MIN; t += MIN) assert.equal(plugged.observe(HOG, charging, t), null);

  const system = new HogWatch();
  const display = energy([['WindowServer (display)', 200], ['Slack', 20]]);
  for (let t = 0; t <= 10 * MIN; t += MIN) assert.equal(system.observe(display, onBattery, t), null);
});

test('the cost is turned into watts and minutes of battery', () => {
  // Half of a 40 W draw: quitting it doubles the time left.
  assert.deepEqual(estimateCost(0.5, onBattery), { appW: 20, loadW: 40, minutesGained: 120 });

  // Plugged into a charger falling 10 W short, the app uses 20 W: the charger would cope without it.
  const weakCharger = { systemLoadMw: 53_000, batteryPowerMw: -10_000, derived: { state: 'draining_on_ac' } };
  assert.equal(estimateCost(0.4, weakCharger).chargerWouldCope, true);

  const alert = hogAlert({ name: 'ffmpeg', sharePct: 69, appW: 28, loadW: 40, minutesGained: 130 });
  assert.equal(alert.title, 'ffmpeg is draining your battery');
  assert.match(alert.body, /69% of the energy right now, roughly 28 W of the 40 W/);
  assert.match(alert.body, /add about 2 h 10 min of battery/);
});

test('the hog alert respects its cooldown', async () => {
  const store = { lastAlertTimes: () => new Map(), addAlert: (a) => a };
  const alerts = new Alerts(store, () => false);
  const alert = hogAlert({ name: 'ffmpeg', sharePct: 69, appW: 28, loadW: 40 });
  assert.equal((await alerts.raise(alert, 0)).length, 1);
  assert.equal((await alerts.raise(alert, 10 * MIN)).length, 0);
  assert.equal((await alerts.raise(alert, 31 * MIN)).length, 1);
});

test('regression: a sustained drain on a charger raises its alert instead of crashing', async () => {
  const store = { lastAlertTimes: () => new Map(), addAlert: (a) => a };
  const alerts = new Alerts(store, () => false);
  const sample = (ts) => ({
    ts, percent: 50, externalConnected: true, adapter: { watts: 45 },
    adapterInMw: 43_000, systemLoadMw: 56_000, batteryPowerMw: -13_000,
  });
  const d = { state: 'draining_on_ac', etaKind: 'empty', etaMin: 10 };
  const first = await alerts.evaluate(sample(0), d);
  assert.deepEqual(first.map((a) => a.kind), ['eta_15'], 'low time left fires at once');
  const fired = await alerts.evaluate(sample(4 * MIN), d);
  assert.deepEqual(fired.map((a) => a.kind), ['draining_on_ac'], 'the drain fires once it has lasted');
  assert.match(fired.find((a) => a.kind === 'draining_on_ac').body, /delivers 43 W but the laptop is using 56 W/);
});
