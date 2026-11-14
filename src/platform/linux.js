// Linux reader: the kernel's power_supply class in sysfs. No root required.
//
// Drivers differ: some report charge (µAh) and current (µA), others energy
// (µWh) and power (µW). Everything is converted to the app's units (mAh, mA,
// mW) using the pack voltage, which keeps time and health ratios exact.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ROOT = '/sys/class/power_supply';

async function text(dir, name) {
  try {
    return (await readFile(path.join(dir, name), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function int(dir, name) {
  const raw = await text(dir, name);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function read(root = DEFAULT_ROOT, ts = Date.now()) {
  let names;
  try {
    names = await readdir(root);
  } catch {
    throw new Error(`Cannot read ${root}. Battery Speed needs a Linux laptop with a battery.`);
  }

  let battery = null;
  const supplies = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const type = await text(dir, 'type');
    // scope=Device marks a peripheral's battery (mouse, keyboard), not the laptop's.
    if (type === 'Battery' && (await text(dir, 'scope')) !== 'Device') battery ??= dir;
    else if (type && type !== 'Battery') supplies.push(dir);
  }
  if (!battery) throw new Error('No battery found. Battery Speed needs a laptop with a battery.');

  const status = await text(battery, 'status'); // Charging | Discharging | Full | Not charging | Unknown
  const voltageUv = await int(battery, 'voltage_now');
  const designUv = (await int(battery, 'voltage_min_design')) ?? voltageUv;
  const volts = voltageUv ? voltageUv / 1e6 : null;
  const refVolts = designUv ? designUv / 1e6 : volts;

  // µAh directly, or µWh divided by the pack voltage.
  const capacity = async (chargeKey, energyKey) => {
    const charge = await int(battery, chargeKey);
    if (charge != null) return charge / 1000;
    const energy = await int(battery, energyKey);
    return energy != null && refVolts ? energy / 1000 / refVolts : null;
  };
  const remainingMah = await capacity('charge_now', 'energy_now');
  const fullMah = await capacity('charge_full', 'energy_full');
  const designMah = await capacity('charge_full_design', 'energy_full_design');

  // Magnitudes: some drivers sign these, so the direction comes from `status`.
  const currentUa = await int(battery, 'current_now');
  const powerUw = await int(battery, 'power_now');
  let milliamps = currentUa != null ? Math.abs(currentUa) / 1000 : null;
  let milliwatts = powerUw != null ? Math.abs(powerUw) / 1000 : null;
  if (milliamps == null && milliwatts != null && volts) milliamps = milliwatts / volts;
  if (milliwatts == null && milliamps != null && volts) milliwatts = milliamps * volts;
  const direction = status === 'Charging' ? 1 : status === 'Discharging' ? -1 : 0;

  // Plugged in if any mains or USB supply is online.
  let online = null;
  let adapter = null;
  for (const dir of supplies) {
    const isOnline = await int(dir, 'online');
    if (isOnline == null) continue;
    online = online || isOnline === 1;
    if (isOnline !== 1) continue;
    // USB-C supplies expose the negotiated contract; plain barrel adapters do not.
    const uv = await int(dir, 'voltage_now');
    const maxUa = await int(dir, 'current_max');
    const watts = uv && maxUa ? Math.round((uv / 1e6) * (maxUa / 1e6)) : null;
    adapter ??= {
      watts: watts && watts >= 5 && watts <= 300 ? watts : null,
      voltageMv: uv ? Math.round(uv / 1000) : null,
      currentMa: maxUa ? Math.round(maxUa / 1000) : null,
      name: path.basename(dir),
      wireless: false,
    };
  }
  const externalConnected = online ?? status !== 'Discharging';

  const percentFile = await int(battery, 'capacity');
  const temp = await int(battery, 'temp'); // tenths of a degree C
  const batteryPowerMw = milliwatts != null ? Math.round(direction * milliwatts) : null;

  return {
    ts,
    percent: percentFile ?? (remainingMah != null && fullMah ? Math.round((remainingMah / fullMah) * 100) : null),
    remainingMah: remainingMah != null ? Math.round(remainingMah) : null,
    fullMah: fullMah != null ? Math.round(fullMah) : null,
    nominalMah: null,
    designMah: designMah != null ? Math.round(designMah) : null,
    cycleCount: (await int(battery, 'cycle_count')) || null, // 0 means "not reported"
    designCycles: null,
    voltageMv: voltageUv ? Math.round(voltageUv / 1000) : null,
    amperageMa: milliamps != null ? Math.round(direction * milliamps) : null,
    batteryPowerMw,
    // Linux does not report what the adapter delivers or the total system
    // draw while plugged in. On battery, the battery's output is the load.
    adapterInMw: externalConnected ? null : 0,
    systemLoadMw: externalConnected ? null : batteryPowerMw != null ? -batteryPowerMw : null,
    tempC: temp != null ? temp / 10 : null,
    externalConnected,
    isCharging: status === 'Charging',
    fullyCharged: status === 'Full',
    notChargingReason: 0,
    slowChargingReason: 0,
    adapter: externalConnected ? (adapter ?? { watts: null, voltageMv: null, currentMa: null, name: null, wireless: false }) : null,
    gauge: { toEmptyMin: null, toFullMin: null },
  };
}
