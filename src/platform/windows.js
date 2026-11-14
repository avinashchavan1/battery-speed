// Windows reader: battery classes from WMI, queried through the PowerShell
// that ships with Windows. No admin rights required.
//
// Windows reports energy (mWh) and power (mW); they are converted to the app's
// charge units (mAh, mA) with the pack voltage, which keeps time and health
// ratios exact.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FALLBACK_VOLTS = 11.4; // typical 3-cell pack, used only if voltage is missing
const UNKNOWN_RUNTIME = 100_000; // Win32_Battery reports 71582788 for "unknown"

// One PowerShell start per sample, so everything is gathered in a single script.
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$s = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus | Select-Object -First 1
$f = Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity | Select-Object -First 1
$d = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStaticData | Select-Object -First 1
$c = Get-CimInstance -Namespace root\\wmi -ClassName BatteryCycleCount | Select-Object -First 1
$b = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1
[pscustomobject]@{
  hasBattery      = [bool]($s -or $b)
  remainingMwh    = $s.RemainingCapacity
  chargeRateMw    = $s.ChargeRate
  dischargeRateMw = $s.DischargeRate
  voltageMv       = $s.Voltage
  powerOnline     = $s.PowerOnline
  charging        = $s.Charging
  fullMwh         = $f.FullChargedCapacity
  designMwh       = $d.DesignedCapacity
  cycleCount      = $c.CycleCount
  percent         = $b.EstimatedChargeRemaining
  runtimeMin      = $b.EstimatedRunTime
} | ConvertTo-Json -Compress
`;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Turns the script's JSON into a normalised sample. Exported for tests. */
export function normalise(w, ts = Date.now()) {
  if (!w || !w.hasBattery) {
    throw new Error('No battery found. Battery Speed needs a laptop with a battery.');
  }

  const volts = num(w.voltageMv) ? w.voltageMv / 1000 : FALLBACK_VOLTS;
  const toMah = (mwh) => (num(mwh) != null && mwh > 0 ? Math.round(mwh / volts) : null);

  const externalConnected = w.powerOnline === true;
  const charging = w.charging === true;
  const rate = charging ? num(w.chargeRateMw) : num(w.dischargeRateMw);
  const batteryPowerMw = rate != null ? (charging ? rate : -rate) : null;

  const remainingMah = toMah(w.remainingMwh);
  const fullMah = toMah(w.fullMwh);
  const percent =
    num(w.percent) ?? (remainingMah != null && fullMah ? Math.round((remainingMah / fullMah) * 100) : null);
  const runtime = num(w.runtimeMin);

  return {
    ts,
    percent: percent != null ? Math.min(100, percent) : null,
    remainingMah,
    fullMah,
    nominalMah: null,
    designMah: toMah(w.designMwh),
    cycleCount: num(w.cycleCount) || null, // 0 means "not reported"
    designCycles: null,
    voltageMv: num(w.voltageMv),
    amperageMa: batteryPowerMw != null ? Math.round(batteryPowerMw / volts) : null,
    batteryPowerMw,
    // Windows does not report what the adapter delivers or the total system
    // draw while plugged in. On battery, the battery's output is the load.
    adapterInMw: externalConnected ? null : 0,
    systemLoadMw: externalConnected ? null : batteryPowerMw != null ? -batteryPowerMw : null,
    tempC: null,
    externalConnected,
    isCharging: charging,
    fullyCharged: externalConnected && !charging && percent != null && percent >= 99,
    notChargingReason: 0,
    slowChargingReason: 0,
    adapter: externalConnected ? { watts: null, voltageMv: null, currentMa: null, name: null, wireless: false } : null,
    gauge: {
      toEmptyMin: !externalConnected && runtime != null && runtime > 0 && runtime < UNKNOWN_RUNTIME ? runtime : null,
      toFullMin: null,
    },
  };
}

export async function read() {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Could not read the battery through PowerShell.');
  }
  return normalise(parsed);
}
