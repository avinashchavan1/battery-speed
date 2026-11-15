// Reads one battery sample, whatever the operating system. Each platform
// reader returns the same shape, in plain units: mW, mA, mV, mAh, minutes.
// A field a platform cannot report is null, and the rest of the app adapts.

import { fileURLToPath } from 'node:url';

const PLATFORMS = {
  darwin: {
    label: 'macOS',
    load: () => import('./platform/mac.js'),
    liveMs: 2000,
    idleMs: 15_000,
    energyMetric: 'energy', // per-app energy impact, as in Activity Monitor
  },
  linux: {
    label: 'Linux',
    load: () => import('./platform/linux.js'),
    liveMs: 2000,
    idleMs: 15_000,
    energyMetric: 'cpu',
  },
  win32: {
    label: 'Windows',
    load: () => import('./platform/windows.js'),
    // Each sample starts PowerShell, so poll less often.
    liveMs: 5000,
    idleMs: 30_000,
    energyMetric: 'cpu',
  },
};

const platform = PLATFORMS[process.platform];

export const PLATFORM = platform && {
  id: process.platform,
  label: platform.label,
  liveMs: platform.liveMs,
  idleMs: platform.idleMs,
  energyMetric: platform.energyMetric,
};

let reader;

export async function readBattery() {
  if (!platform) {
    throw new Error(`Battery Speed does not support this system yet (${process.platform}).`);
  }
  reader ??= await platform.load();
  const sample = await reader.read();
  const mode = process.env.BATTERY_SIMULATE;
  return mode && SIMULATIONS[mode] ? SIMULATIONS[mode](sample) : sample;
}

// Development aid. BATTERY_SIMULATE reshapes this machine's real reading so
// every dashboard state can be checked without waiting for it to happen:
//   limited   only what Windows, Linux and Intel Macs report
//   charging  a strong charger with power to spare
//   draining  a weak charger that cannot keep up
//   connecting  the first minute after plugging in, before figures arrive
const plugged = (s, watts, inMw, loadMw) => {
  const batteryPowerMw = inMw - loadMw;
  return {
    ...s,
    externalConnected: true,
    isCharging: batteryPowerMw > 0,
    fullyCharged: false,
    adapter: { watts, voltageMv: 20_000, currentMa: (watts * 1000) / 20, name: 'pd charger', wireless: false },
    adapterInMw: inMw,
    systemLoadMw: loadMw,
    batteryPowerMw,
    amperageMa: Math.round((batteryPowerMw / (s.voltageMv ?? 11_400)) * 1000),
  };
};
const SIMULATIONS = {
  limited: (s) => ({
    ...s,
    adapterInMw: s.externalConnected ? null : 0,
    systemLoadMw: s.externalConnected ? null : s.batteryPowerMw != null ? -s.batteryPowerMw : null,
    adapter: s.adapter && { ...s.adapter, watts: null, voltageMv: null, currentMa: null, name: null },
    designCycles: null,
    gauge: { toEmptyMin: null, toFullMin: null },
  }),
  charging: (s) => plugged(s, 96, 83_000, 60_000),
  connecting: (s) => ({
    ...plugged(s, null, 0, 0),
    settling: true,
    amperageMa: null,
    batteryPowerMw: null,
    adapterInMw: null,
    systemLoadMw: null,
    gauge: { toEmptyMin: null, toFullMin: null },
  }),
  draining: (s) => plugged(s, 45, 43_000, 56_100),
};

// `npm run sample` prints one reading, handy for checking the collector alone.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await readBattery(), null, 2));
}
