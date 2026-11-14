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
  return process.env.BATTERY_SIMULATE === 'limited' ? asLimitedSystem(sample) : sample;
}

// Development aid: BATTERY_SIMULATE=limited makes this machine report only what
// Windows, Linux and Intel Macs can, to check the dashboard copes without the rest.
function asLimitedSystem(s) {
  return {
    ...s,
    adapterInMw: s.externalConnected ? null : 0,
    systemLoadMw: s.externalConnected ? null : s.batteryPowerMw != null ? -s.batteryPowerMw : null,
    adapter: s.adapter && { ...s.adapter, watts: null, voltageMv: null, currentMa: null, name: null },
    designCycles: null,
    gauge: { toEmptyMin: null, toFullMin: null },
  };
}

// `npm run sample` prints one reading, handy for checking the collector alone.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await readBattery(), null, 2));
}
