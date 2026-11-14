// The Windows and Linux readers cannot be run on the machine this app was
// developed on, so their parsing is pinned here against representative data.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { read as readLinux } from '../src/platform/linux.js';
import { normalise as normaliseWindows } from '../src/platform/windows.js';
import { normalise as normaliseMac } from '../src/platform/mac.js';
import { parsePs, parseWindowsProcesses } from '../src/energy.js';
import { Estimator } from '../src/estimator.js';

/** Builds a fake /sys/class/power_supply tree and returns its path. */
function sysfs(t, supplies) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bs-sysfs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, files] of Object.entries(supplies)) {
    mkdirSync(path.join(root, name));
    for (const [file, value] of Object.entries(files)) {
      writeFileSync(path.join(root, name, file), `${value}\n`);
    }
  }
  return root;
}

// ------------------------------------------------------------------ Linux

test('linux: energy-based battery, running on battery', async (t) => {
  const root = sysfs(t, {
    AC: { type: 'Mains', online: 0 },
    BAT0: {
      type: 'Battery', status: 'Discharging', capacity: 62, cycle_count: 211,
      voltage_now: 11_400_000, voltage_min_design: 11_400_000,
      energy_now: 31_920_000, energy_full: 51_300_000, energy_full_design: 57_000_000,
      power_now: 9_120_000,
    },
  });
  const s = await readLinux(root, 1);

  assert.equal(s.percent, 62);
  assert.equal(s.externalConnected, false);
  assert.equal(s.remainingMah, 2800); // 31.92 Wh / 11.4 V
  assert.equal(s.fullMah, 4500);
  assert.equal(s.designMah, 5000);
  assert.equal(s.batteryPowerMw, -9120);
  assert.equal(s.amperageMa, -800);
  assert.equal(s.systemLoadMw, 9120, 'on battery, the battery output is the load');
  assert.equal(s.adapterInMw, 0);
  assert.equal(s.adapter, null);
  assert.equal(s.cycleCount, 211);
});

test('linux: charge-based battery, charging from a USB-C supply', async (t) => {
  const root = sysfs(t, {
    'ucsi-source-psy-1': { type: 'USB', online: 1, voltage_now: 20_000_000, current_max: 3_250_000 },
    BAT1: {
      type: 'Battery', status: 'Charging', capacity: 40,
      voltage_now: 12_000_000, charge_now: 2_000_000, charge_full: 5_000_000,
      charge_full_design: 5_500_000, current_now: 1_500_000, temp: 312,
    },
  });
  const s = await readLinux(root, 1);

  assert.equal(s.externalConnected, true);
  assert.equal(s.isCharging, true);
  assert.equal(s.remainingMah, 2000);
  assert.equal(s.amperageMa, 1500);
  assert.equal(s.batteryPowerMw, 18_000); // 1.5 A x 12 V
  assert.equal(s.adapter.watts, 65); // 20 V x 3.25 A contract
  assert.equal(s.adapterInMw, null, 'adapter input is not reported on Linux');
  assert.equal(s.systemLoadMw, null);
  assert.equal(s.tempC, 31.2);
  assert.equal(s.cycleCount, null);
});

test('linux: a negative current_now still follows the status direction', async (t) => {
  const root = sysfs(t, {
    BAT0: {
      type: 'Battery', status: 'Discharging', capacity: 50, voltage_now: 10_000_000,
      charge_now: 2_500_000, charge_full: 5_000_000, current_now: -1_000_000,
    },
  });
  const s = await readLinux(root, 1);
  assert.equal(s.amperageMa, -1000);
  assert.equal(s.externalConnected, false, 'no mains entry: inferred from status');
});

test('linux: ignores peripheral batteries and fails clearly with none', async (t) => {
  const root = sysfs(t, {
    hidpp_battery_0: { type: 'Battery', scope: 'Device', capacity: 80 },
    AC: { type: 'Mains', online: 1 },
  });
  await assert.rejects(readLinux(root), /No battery found/);
});

// ------------------------------------------------------------------ Windows

const WINDOWS_BASE = {
  hasBattery: true, voltageMv: 12_000, fullMwh: 48_000, designMwh: 60_000, cycleCount: 150,
};

test('windows: running on battery', () => {
  const s = normaliseWindows(
    { ...WINDOWS_BASE, remainingMwh: 24_000, chargeRateMw: 0, dischargeRateMw: 12_000,
      powerOnline: false, charging: false, percent: 50, runtimeMin: 118 },
    1,
  );
  assert.equal(s.percent, 50);
  assert.equal(s.remainingMah, 2000); // 24 Wh / 12 V
  assert.equal(s.fullMah, 4000);
  assert.equal(s.designMah, 5000);
  assert.equal(s.batteryPowerMw, -12_000);
  assert.equal(s.amperageMa, -1000);
  assert.equal(s.systemLoadMw, 12_000);
  assert.equal(s.adapterInMw, 0);
  assert.equal(s.gauge.toEmptyMin, 118);
});

test('windows: charging, with the "unknown" runtime sentinel', () => {
  const s = normaliseWindows(
    { ...WINDOWS_BASE, remainingMwh: 12_000, chargeRateMw: 30_000, dischargeRateMw: 0,
      powerOnline: true, charging: true, percent: 25, runtimeMin: 71_582_788 },
    1,
  );
  assert.equal(s.externalConnected, true);
  assert.equal(s.isCharging, true);
  assert.equal(s.batteryPowerMw, 30_000);
  assert.equal(s.amperageMa, 2500);
  assert.equal(s.systemLoadMw, null);
  assert.equal(s.gauge.toEmptyMin, null);
  assert.equal(s.fullyCharged, false);
});

test('windows: missing optional classes still give a usable sample', () => {
  const s = normaliseWindows(
    { hasBattery: true, remainingMwh: null, chargeRateMw: null, dischargeRateMw: null, voltageMv: null,
      powerOnline: true, charging: false, fullMwh: null, designMwh: null, cycleCount: null,
      percent: 100, runtimeMin: null },
    1,
  );
  assert.equal(s.percent, 100);
  assert.equal(s.fullyCharged, true);
  assert.equal(s.remainingMah, null);
  assert.equal(s.batteryPowerMw, null);
});

test('windows: no battery fails clearly', () => {
  assert.throws(() => normaliseWindows({ hasBattery: false }), /No battery found/);
});

// ------------------------------------------------------------------ macOS

test('mac: Apple Silicon reports percent directly and has power telemetry', () => {
  const s = normaliseMac(
    {
      CurrentCapacity: 12, MaxCapacity: 100, CycleCount: 428, DesignCycleCount9C: 1000,
      AppleRawBatteryVoltage: 10_824, InstantAmperage: -990, ExternalConnected: true, IsCharging: true,
      BatteryData: { RemainingCapacity: 765, FullChargeCapacity: 6641, DesignCapacity: 8694 },
      PowerTelemetryData: { BatteryPower: -10_715, SystemPowerIn: 43_038, SystemLoad: 53_753 },
      AdapterDetails: { Watts: 45, AdapterVoltage: 20_000, Current: 2250, Description: 'pd charger' },
      AvgTimeToEmpty: 29, AvgTimeToFull: 65_535,
    },
    1,
  );
  assert.equal(s.percent, 12);
  assert.equal(s.remainingMah, 765);
  assert.equal(s.systemLoadMw, 53_753);
  assert.equal(s.adapter.watts, 45);
  assert.equal(s.gauge.toEmptyMin, 29);
  assert.equal(s.gauge.toFullMin, null);
});

test('mac: Intel reports capacity in mAh and has no power telemetry', () => {
  const s = normaliseMac(
    {
      CurrentCapacity: 3000, MaxCapacity: 6000, DesignCapacity: 7000, CycleCount: 300,
      Voltage: 12_000, Amperage: 1500, ExternalConnected: true, IsCharging: true,
      AdapterDetails: { Watts: 87 }, Temperature: 3010,
    },
    1,
  );
  assert.equal(s.percent, 50);
  assert.equal(s.remainingMah, 3000);
  assert.equal(s.fullMah, 6000);
  assert.equal(s.designMah, 7000);
  assert.equal(s.batteryPowerMw, 18_000);
  assert.equal(s.adapterInMw, null);
  assert.equal(s.systemLoadMw, null);
  assert.equal(s.tempC, 30.1);
});

// ------------------------------------------------------------------ shared logic

test('estimator copes with systems that report only the battery flow', () => {
  const profile = { timeToFull: () => ({ minutes: 90, basis: 'rough' }), typicalTimeToEmpty: () => null };
  const sample = normaliseWindows(
    { ...WINDOWS_BASE, remainingMwh: 12_000, chargeRateMw: 0, dischargeRateMw: 6000,
      powerOnline: true, charging: false, percent: 25, runtimeMin: null },
    1,
  );
  const d = new Estimator(profile).update(sample);
  assert.equal(d.state, 'draining_on_ac');
  assert.equal(d.etaKind, 'empty');
  assert.equal(d.etaMin, 120); // 1000 mAh at 500 mA
  assert.doesNotMatch(d.detail, /NaN|null|undefined/);
});

test('process lists are parsed and instances folded together', () => {
  assert.deepEqual(parsePs(' 12.5 firefox\n  3.0 Web Content\n  0.1 ps\n'), [
    ['firefox', 12.5],
    ['Web Content', 3],
  ]);
  assert.deepEqual(
    parseWindowsProcesses('[{"Name":"chrome#3","PercentProcessorTime":7},{"Name":"chrome","PercentProcessorTime":5}]'),
    [['chrome', 7], ['chrome', 5]],
  );
  assert.deepEqual(parseWindowsProcesses('{"Name":"code","PercentProcessorTime":9}'), [['code', 9]]);
  assert.deepEqual(parseWindowsProcesses(''), []);
});
