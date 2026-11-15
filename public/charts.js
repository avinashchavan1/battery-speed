// The two history charts (charge level, power flow), their shared crosshair,
// and the table view of the same data.

import { $, el, svgEl, fmtW, fmtSignedW, fmtClock, fmtDay, fmtDayClock, flowWord } from './fmt.js';

const M = { l: 40, r: 68, t: 14, b: 26 }; // chart margins

export const RANGE_LABELS = {
  15: 'last 15 minutes',
  60: 'last hour',
  360: 'last 6 hours',
  1440: 'last 24 hours',
  10080: 'last 7 days',
};

/** Shared chart state, filled in by app.js. */
export const chart = {
  history: [],
  bucketMs: 0,
  windowMin: 60,
  hoverTs: null,
  hoverChart: null,
  now: Date.now(),
  animate: false, // draw the lines in on the next render (set after a range loads)
};

// Precision of a point's timestamp follows the range being viewed.
const fmtPointTime = (ts) =>
  chart.windowMin >= 1440 ? fmtDayClock(ts) : fmtClock(ts, chart.windowMin <= 60);

const battery = (p) => p.batteryPowerMw ?? 0;

// Full detail where the system reports adapter input and total load (Apple
// Silicon Macs). Elsewhere only the battery's own flow is known, so the power
// chart shows that instead.
const FULL_POWER = [
  { get: (p) => p.adapterInMw, cls: 's-in', keyCls: 'key-in', name: 'From the charger' },
  { get: (p) => p.systemLoadMw, cls: 's-load', keyCls: 'key-load', name: 'Laptop is using' },
];
const BATTERY_ONLY_POWER = [
  { get: (p) => Math.max(battery(p), 0), cls: 's-in', keyCls: 'key-in', name: 'Into the battery' },
  { get: (p) => Math.max(-battery(p), 0), cls: 's-load', keyCls: 'key-load', name: 'Out of the battery' },
];

const CHARTS = [
  {
    id: 'charge',
    series: () => [{ get: (p) => p.percent, cls: 's-charge', keyCls: 'key-charge', name: 'Charge', area: true }],
    value: (raw) => raw,
    format: (v) => `${Math.round(v)}%`,
    domain: () => ({ step: 25, yMax: 100 }),
    extraRow: (p) => [`${fmtSignedW(p.batteryPowerMw)} W`, `Battery ${flowWord(battery(p))}`],
  },
  {
    id: 'power',
    series: (view) => (view.batteryOnly ? BATTERY_ONLY_POWER : FULL_POWER),
    value: (raw) => raw / 1000,
    format: (v) => `${v.toFixed(1)} W`,
    domain(max) {
      const top = Math.max(10, max);
      const step = [2, 5, 10, 20, 25, 50, 100].find((s) => top / s <= 5) ?? 200;
      return { step, yMax: Math.ceil(top / step) * step };
    },
    extraRow: (p) => [
      `${fmtSignedW(p.batteryPowerMw)} W`,
      `Battery ${flowWord(battery(p))} · ${Math.round(p.percent)}%`,
    ],
  },
];

/** The points in the selected range, and whether only battery flow is known. */
export function view() {
  const t0 = chart.now - chart.windowMin * 60_000;
  const inRange = chart.history.filter((p) => p.ts >= t0 && p.percent != null);
  const batteryOnly = inRange.some((p) => p.adapterInMw == null || p.systemLoadMw == null);
  const points = batteryOnly ? inRange.filter((p) => p.batteryPowerMw != null) : inRange;
  return { points, batteryOnly };
}

function nearestPoint(pts, ts) {
  let best = null;
  for (const p of pts) {
    if (!best || Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
  }
  return best;
}

// Ticks on clean local-clock boundaries, thinned so labels never touch.
function xTicks(t0, now, innerWidth) {
  const w = chart.windowMin;
  const stepMin = w <= 15 ? 5 : w <= 60 ? 15 : w <= 360 ? 60 : w <= 1440 ? 240 : 1440;
  const start = new Date(t0);
  start.setHours(0, 0, 0, 0);
  const ticks = [];
  for (let t = start.getTime(); t <= now; t += stepMin * 60_000) {
    if (t >= t0) ticks.push(t);
  }
  const keepEvery = Math.max(1, Math.ceil((ticks.length * 64) / innerWidth));
  return ticks
    .filter((_, i) => i % keepEvery === 0)
    .map((t) => ({ t, label: stepMin >= 1440 ? fmtDay(t) : fmtClock(t) }));
}

function drawChart(c, v) {
  const svg = $(`chart-${c.id}`);
  const tooltip = $(`tooltip-${c.id}`);
  const width = svg.clientWidth;
  const height = svg.clientHeight;
  if (!width || !height) return;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  svg.classList.toggle('draw', chart.animate);

  const pts = v.points;
  const series = c.series(v);
  const iw = width - M.l - M.r;
  const ih = height - M.t - M.b;
  const windowMs = chart.windowMin * 60_000;
  const now = chart.now;
  const t0 = now - windowMs;

  let max = 0;
  for (const p of pts) for (const sr of series) max = Math.max(max, c.value(sr.get(p)));
  const { step, yMax } = c.domain(max);
  const x = (t) => M.l + ((t - t0) / windowMs) * iw;
  const y = (val) => M.t + ih - (val / yMax) * ih;
  const baseY = y(0);

  // Gridlines and y ticks (the unit is named in the chart subtitle).
  for (let val = 0; val <= yMax; val += step) {
    svg.append(
      svgEl('line', { class: val === 0 ? 'baseline' : 'grid', x1: M.l, x2: M.l + iw, y1: y(val), y2: y(val) }),
      svgEl('text', { x: M.l - 8, y: y(val) + 4, 'text-anchor': 'end' }, String(val)),
    );
  }
  for (const tick of xTicks(t0, now, iw)) {
    svg.append(svgEl('text', { x: x(tick.t), y: height - 6, 'text-anchor': 'middle' }, tick.label));
  }

  if (pts.length < 2) {
    svg.append(
      svgEl('text', { class: 'empty', x: M.l + iw / 2, y: M.t + ih / 2, 'text-anchor': 'middle' },
        'Collecting samples…'),
    );
    tooltip.hidden = true;
    return;
  }

  // Split into runs so the line breaks where recording paused (sleep, shutdown).
  const gapMs = Math.max(90_000, chart.bucketMs * 3);
  const runs = [];
  pts.forEach((p, i) => {
    if (i === 0 || p.ts - pts[i - 1].ts > gapMs) runs.push([]);
    runs[runs.length - 1].push(p);
  });

  for (const sr of series) {
    for (const run of runs) {
      const coords = run.map((p) => `${x(p.ts).toFixed(1)},${y(c.value(sr.get(p))).toFixed(1)}`);
      if (sr.area) {
        const x0 = x(run[0].ts).toFixed(1);
        const x1 = x(run[run.length - 1].ts).toFixed(1);
        svg.append(
          svgEl('path', { class: `area ${sr.cls}`, d: `M${x0},${baseY}L${coords.join('L')}L${x1},${baseY}Z` }),
        );
      }
      // pathLength lets CSS draw the line in, whatever its real length.
      svg.append(svgEl('path', { class: `line ${sr.cls}`, d: `M${coords.join('L')}`, pathLength: 1 }));
    }
  }

  // End markers, with value labels only when they don't collide.
  const last = pts[pts.length - 1];
  const ends = series.map((sr) => {
    const val = c.value(sr.get(last));
    return { ...sr, val, cy: y(val) };
  });
  const labelsFit = ends.length < 2 || Math.abs(ends[0].cy - ends[1].cy) >= 16;
  for (const e of ends) {
    svg.append(svgEl('circle', { class: `dot ${e.cls}`, cx: x(last.ts), cy: e.cy, r: 4 }));
    if (labelsFit) {
      svg.append(svgEl('text', { class: 'end-label', x: x(last.ts) + 10, y: e.cy + 4 }, c.format(e.val)));
    }
  }

  // Hover layer: the crosshair snaps to the nearest sample and is shared by
  // both charts; the readout shows on the chart being pointed at.
  const hovered = chart.hoverTs != null ? nearestPoint(pts, chart.hoverTs) : null;
  if (hovered) {
    const hx = x(hovered.ts);
    svg.append(svgEl('line', { class: 'crosshair', x1: hx, x2: hx, y1: M.t, y2: M.t + ih }));
    for (const sr of series) {
      svg.append(svgEl('circle', { class: `dot ${sr.cls}`, cx: hx, cy: y(c.value(sr.get(hovered))), r: 4 }));
    }
  }
  if (hovered && chart.hoverChart === c.id) showTooltip(c, series, tooltip, hovered, x(hovered.ts), width);
  else tooltip.hidden = true;
}

function showTooltip(c, series, tt, p, px, width) {
  const row = (keyCls, value, name) => {
    const r = el('div', 'tt-row');
    if (keyCls) r.append(el('span', `key ${keyCls}`));
    r.append(el('span', 'tt-value', value), el('span', 'tt-name', name));
    return r;
  };
  tt.replaceChildren(
    el('div', 'tt-time', fmtPointTime(p.ts)),
    ...series.map((sr) => row(sr.keyCls, c.format(c.value(sr.get(p))), sr.name)),
    el('hr', 'tt-rule'),
    row(null, ...c.extraRow(p)),
  );
  tt.hidden = false;
  const w = tt.offsetWidth;
  const left = px + 14 + w > width ? px - 14 - w : px + 14;
  tt.style.left = `${Math.max(0, left)}px`;
}

function renderLegendAndCaptions(v) {
  const range = RANGE_LABELS[chart.windowMin];
  $('charge-sub').textContent = `Percent over the ${range}. Gaps are times the computer was asleep or off.`;
  $('power-sub').textContent = v.batteryOnly
    ? `Watts over the ${range}. This system reports only what flows into and out of the battery.`
    : `Watts over the ${range}. When the laptop uses more than the charger delivers, the battery covers the difference.`;
  $('legend-power').replaceChildren(
    ...CHARTS[1].series(v).map((sr) => {
      const li = el('li');
      li.append(el('span', `key ${sr.keyCls}`), document.createTextNode(sr.name));
      return li;
    }),
  );
  const [first, second] = CHARTS[1].series(v);
  $('th-a').textContent = first.name;
  $('th-b').textContent = second.name;
}

export function renderCharts() {
  const v = view();
  renderLegendAndCaptions(v);
  for (const c of CHARTS) drawChart(c, v);
  chart.animate = false;
  renderTable(v);
}

function renderTable(v = view()) {
  if (!$('table-view').open) return;
  const pts = v.points;
  const [a, b] = CHARTS[1].series(v);
  const rows = [];
  const n = Math.min(12, pts.length);
  for (let i = 0; i < n; i++) {
    rows.push(pts[Math.round(pts.length - 1 - (i * (pts.length - 1)) / Math.max(1, n - 1))]);
  }
  $('table-body').replaceChildren(
    ...rows.map((p) => {
      const tr = el('tr');
      for (const cell of [
        fmtPointTime(p.ts),
        `${fmtW(a.get(p))} W`,
        `${fmtW(b.get(p))} W`,
        `${fmtSignedW(p.batteryPowerMw)} W`,
        `${Math.round(p.percent)}%`,
      ]) {
        tr.append(el('td', null, cell));
      }
      return tr;
    }),
  );
}

export function wireCharts() {
  const clear = () => {
    chart.hoverTs = null;
    chart.hoverChart = null;
    renderCharts();
  };

  for (const c of CHARTS) {
    const svg = $(`chart-${c.id}`);

    svg.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const frac = (e.clientX - rect.left - M.l) / (rect.width - M.l - M.r);
      chart.hoverTs = chart.now - chart.windowMin * 60_000 * (1 - Math.max(0, Math.min(1, frac)));
      chart.hoverChart = c.id;
      renderCharts();
    });
    svg.addEventListener('pointerleave', clear);
    svg.addEventListener('blur', clear);

    svg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return clear();
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const pts = view().points;
      if (!pts.length) return;
      let index = pts.length - 1;
      if (chart.hoverTs != null) {
        index = pts.indexOf(nearestPoint(pts, chart.hoverTs)) + (e.key === 'ArrowLeft' ? -1 : 1);
      }
      chart.hoverTs = pts[Math.max(0, Math.min(pts.length - 1, index))].ts;
      chart.hoverChart = c.id;
      renderCharts();
    });

    new ResizeObserver(renderCharts).observe(svg.parentElement);
  }

  $('table-view').addEventListener('toggle', () => renderTable());
}
