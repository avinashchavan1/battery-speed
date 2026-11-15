// macOS reader: one battery sample from the IORegistry. No sudo required.
// Handles both Apple Silicon and Intel Macs, which report capacity differently.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePlist } from '../plist.js';

const run = promisify(execFile);

// The gauge reports 65535 when it has no estimate.
const minutesOrNull = (v) => (typeof v === 'number' && v > 0 && v < 65535 ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function readRaw() {
  const { stdout } = await run(
    '/usr/sbin/ioreg',
    ['-r', '-n', 'AppleSmartBattery', '-d', '1', '-a'],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const parsed = parsePlist(stdout);
  const raw = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!raw || typeof raw !== 'object') {
    throw new Error('No battery found. Battery Speed needs a Mac with a battery.');
  }
  return raw;
}

export function normalise(raw, ts = Date.now()) {
  const bd = raw.BatteryData ?? {};
  const tel = raw.PowerTelemetryData ?? {};
  const ad = raw.AdapterDetails ?? {};
  const ch = raw.ChargerData ?? {};

  // Apple Silicon reports CurrentCapacity as a percentage (MaxCapacity = 100);
  // Intel Macs report both in mAh.
  const current = num(raw.CurrentCapacity);
  const max = num(raw.MaxCapacity);
  const percentScale = max === 100;

  const voltageMv = num(raw.AppleRawBatteryVoltage) ?? num(raw.Voltage);
  // Signed: positive = current flowing into the battery, negative = out.
  const amperageMa = num(raw.InstantAmperage) ?? num(raw.Amperage);
  const externalConnected = raw.ExternalConnected === true;

  // mV * mA = µW. Telemetry gives the same figure directly when present.
  const batteryPowerMw =
    num(tel.BatteryPower) ??
    (voltageMv != null && amperageMa != null ? Math.round((voltageMv * amperageMa) / 1000) : null);

  // Intel Macs have no power telemetry: on charger, input and load stay unknown.
  const adapterInMw = externalConnected ? num(tel.SystemPowerIn) : 0;
  let systemLoadMw = num(tel.SystemLoad);
  if (systemLoadMw == null && adapterInMw != null && batteryPowerMw != null) {
    systemLoadMw = adapterInMw - batteryPowerMw;
  }

  const temperature = num(raw.Temperature) ?? num(raw.VirtualTemperature);

  return {
    ts,
    percent: max ? Math.round((current / max) * 100) : current,
    remainingMah: num(bd.RemainingCapacity) ?? num(raw.AppleRawCurrentCapacity) ?? (percentScale ? null : current),
    fullMah: num(bd.FullChargeCapacity) ?? num(raw.AppleRawMaxCapacity) ?? (percentScale ? null : max),
    nominalMah: num(bd.NominalChargeCapacity) ?? num(raw.NominalChargeCapacity),
    designMah: num(bd.DesignCapacity) ?? num(raw.DesignCapacity),
    cycleCount: num(raw.CycleCount),
    designCycles: num(raw.DesignCycleCount9C),
    voltageMv,
    amperageMa,
    batteryPowerMw,
    adapterInMw,
    systemLoadMw,
    tempC: temperature != null ? temperature / 100 : null,
    externalConnected,
    isCharging: raw.IsCharging === true,
    fullyCharged: raw.FullyCharged === true,
    notChargingReason: num(ch.NotChargingReason) ?? 0,
    slowChargingReason: num(ch.SlowChargingReason) ?? 0,
    adapter: externalConnected
      ? {
          watts: num(ad.Watts),
          voltageMv: num(ad.AdapterVoltage),
          currentMa: num(ad.Current),
          name: ad.Name || ad.Description || null,
          wireless: ad.IsWireless === true,
        }
      : null,
    gauge: {
      toEmptyMin: minutesOrNull(raw.AvgTimeToEmpty),
      toFullMin: minutesOrNull(raw.AvgTimeToFull),
    },
  };
}

/**
 * True if the battery chip last published its figures before the power
 * source changed. The chip publishes about once a minute, but the plugged-in
 * flag flips at once, so for up to a minute after plugging in or unplugging
 * the current and power figures still describe the old state.
 */
export function figuresPredateChange(publishedAtMs, changedAfterMs) {
  return publishedAtMs != null && changedAfterMs != null && publishedAtMs <= changedAfterMs;
}

/**
 * Marks a sample whose power figures are out of date. The plug state and the
 * charge level are current; the flows are unknown until the chip publishes.
 */
export function settle(s) {
  return {
    ...s,
    settling: true,
    amperageMa: null,
    batteryPowerMw: null,
    adapterInMw: s.externalConnected ? null : 0,
    systemLoadMw: null,
    adapter: s.externalConnected ? { watts: null, voltageMv: null, currentMa: null, name: null, wireless: false } : null,
    gauge: { toEmptyMin: null, toFullMin: null },
  };
}

let lastExternal = null;
let lastReadAt = null;
let changedAfter = null; // the change happened after this moment (the read before it)

export async function read() {
  const raw = await readRaw();
  const s = normalise(raw);
  if (lastExternal !== null && s.externalConnected !== lastExternal) changedAfter = lastReadAt;
  lastExternal = s.externalConnected;
  lastReadAt = s.ts;
  const publishedAt = typeof raw.UpdateTime === 'number' ? raw.UpdateTime * 1000 : null;
  return figuresPredateChange(publishedAt, changedAfter) ? settle(s) : s;
}
