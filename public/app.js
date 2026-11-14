// Dashboard: live reading, the animated power-flow scene, and the side cards.

import {
  $, el, svgEl, icon, tween, getJson,
  fmtW, fmtInt, fmtDuration, fmtClock, fmtDayClock, flowWord,
} from './fmt.js';
import { chart, renderCharts, wireCharts } from './charts.js';
import { sfx } from './sfx.js';

const HISTORY_REFRESH_MS = 60_000;
const ENERGY_REFRESH_MS = 30_000;
const HEALTH_REFRESH_MS = 60 * 60_000;
const MAX_ALERTS_SHOWN = 8;

const state = {
  latest: null,
  previous: null, // { external, state } of the sample before, for change sounds
  meta: null,
  alerts: [],
  freshAlertId: null,
  health: null,
  summary: null,
  summaryReady: true,
};

const STATE_ICON = {
  charging: 'bolt',
  draining_on_ac: 'warning',
  discharging: 'battery',
  full: 'check',
  holding: 'pause',
};

const setIcon = (useId, name) => $(useId).setAttribute('href', `#i-${name}`);
const setText = (id, text) => {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
};

// ---------- hero: status, time left, and the power-flow scene ----------

// What the time estimate rests on, in one line under the scene.
function etaNote(d) {
  if (d.etaMin == null) return '';
  const parts = [];
  if (d.etaKind === 'full') {
    parts.push(
      d.etaBasis === 'learned'
        ? 'Time to full is based on how this battery has charged before.'
        : 'Time to full is a rough estimate; it sharpens as charging history builds up.',
    );
  }
  if (d.typical) {
    parts.push(`At your usual on-battery draw (${d.typical.watts.toFixed(1)} W): ${fmtDuration(d.typical.minutes)}.`);
  }
  if (d.gaugeEtaMin != null) parts.push(`The battery's own estimate: ${fmtDuration(d.gaugeEtaMin)}.`);
  return parts.join(' ');
}

// More watts, faster dots: 1 W drifts, 100 W streams.
const flowSpeed = (mw) => `${Math.max(0.35, 2.4 - Math.log10(1 + Math.abs(mw ?? 8000) / 1000)).toFixed(2)}s`;

function setPipe(id, { dir, tone, label, mw }) {
  const pipe = $(id);
  pipe.dataset.dir = dir;
  pipe.dataset.tone = tone;
  const speed = flowSpeed(mw);
  if (pipe.style.getPropertyValue('--dur') !== speed) pipe.style.setProperty('--dur', speed);
  setText(`${id}-label`, label);
}

function renderHero(s) {
  const d = s.derived;
  const low = d.state === 'discharging' && s.percent <= 20;
  document.body.dataset.state = low ? (s.percent <= 10 ? 'critical' : 'low') : d.state;

  $('chip').dataset.severity = d.severity;
  setText('chip-label', d.label);
  setIcon('chip-icon', STATE_ICON[d.state] ?? 'battery');
  setText('headline', d.headline);
  setText('detail', d.detail);

  const hasEta = d.etaMin != null;
  $('eta').hidden = !hasEta;
  if (hasEta) {
    setText('eta-value', fmtDuration(d.etaMin));
    setText('eta-label', d.etaKind === 'empty' ? 'until empty' : 'until full');
  }
  setText('eta-note', etaNote(d));

  // Charger -> laptop
  const plugged = s.externalConnected;
  const inKnown = s.adapterInMw != null;
  $('node-charger').dataset.active = String(plugged);
  setText('charger-name', s.adapter?.watts ? `${s.adapter.watts} W charger` : 'Charger');
  setText('charger-value', !plugged ? 'Not plugged in' : inKnown ? `giving ${fmtW(s.adapterInMw)} W` : 'Connected');
  setPipe('pipe-in', {
    dir: plugged && (!inKnown || s.adapterInMw > 50) ? 'forward' : 'idle',
    tone: 'in',
    label: plugged && inKnown ? `${fmtW(s.adapterInMw)} W` : '',
    mw: s.adapterInMw,
  });

  // Laptop
  setText('laptop-value', s.systemLoadMw != null ? `using ${fmtW(s.systemLoadMw)} W` : 'In use');

  // Laptop <-> battery
  const flow = flowWord(s.batteryPowerMw ?? 0);
  setPipe('pipe-batt', {
    dir: flow === 'charging' ? 'forward' : flow === 'draining' ? 'reverse' : 'idle',
    tone: flow === 'charging' ? 'charge' : 'drain',
    label: flow === 'idle' ? 'Resting' : `${fmtW(s.batteryPowerMw)} W`,
    mw: s.batteryPowerMw,
  });

  // The battery
  const cell = $('cell');
  cell.style.setProperty('--level', String(Math.max(0, Math.min(100, s.percent ?? 0))));
  cell.dataset.flow = flow;
  cell.dataset.tone =
    d.state === 'charging' || d.state === 'full'
      ? 'good'
      : d.state === 'draining_on_ac'
        ? 'warning'
        : s.percent <= 10
          ? 'critical'
          : s.percent <= 20
            ? 'warning'
            : 'accent';
  tween($('percent'), s.percent, (v) => String(Math.round(v)));
  setText(
    'charge-mah',
    s.remainingMah != null && s.fullMah != null ? `${fmtInt(s.remainingMah)} of ${fmtInt(s.fullMah)} mAh` : '',
  );
  $('scene').setAttribute('aria-label', `${d.headline}. ${d.detail}`);
}

// Sounds for the moments worth hearing: plugging in, unplugging, reaching full.
function playChangeSounds(s) {
  const now = { external: s.externalConnected, state: s.derived.state };
  const before = state.previous;
  state.previous = now;
  if (!before) return;
  if (before.external !== now.external) (now.external ? sfx.plug : sfx.unplug)();
  else if (before.state !== 'full' && now.state === 'full') sfx.full();
}

// ---------- stat tiles ----------

const TILES = ['health', 'cycles', 'voltage', 'extra'];
const tiles = {};

function buildTiles() {
  $('details').replaceChildren(
    ...TILES.map((key, i) => {
      const card = el('div', 'card tile reveal');
      card.style.setProperty('--i', String(8 + i));
      const badge = el('span', 'title-icon');
      const glyph = icon('battery');
      badge.append(glyph);
      const label = el('span', 'tile-label');
      const head = el('div', 'tile-head');
      head.append(badge, label);

      const value = el('div', 'tile-value', '–');
      const ring = svgEl('svg', { class: 'ring', viewBox: '0 0 44 44', 'aria-hidden': 'true' });
      // pathLength=100 lets the dash offset be a plain percentage.
      const fill = svgEl('circle', { class: 'ring-fill', cx: 22, cy: 22, r: 18, pathLength: 100 });
      ring.append(svgEl('circle', { class: 'ring-track', cx: 22, cy: 22, r: 18 }), fill);
      const main = el('div', 'tile-main');
      main.append(value, ring);

      const sub = el('div', 'tile-sub');
      const sparkHost = el('div');
      const note = el('div', 'tile-note');
      card.append(head, main, sub, sparkHost, note);
      tiles[key] = { card, badge, use: glyph.firstChild, label, value, ring, fill, sub, sparkHost, note };
      return card;
    }),
  );
}

function setTile(key, { iconName, tint, label, value, sub = '', note = '', share = null, hint = '' }) {
  const t = tiles[key];
  t.use.setAttribute('href', `#i-${iconName}`);
  t.badge.className = `title-icon tint-${tint}`;
  t.ring.setAttribute('class', `ring tint-${tint}`);
  t.ring.style.visibility = share == null ? 'hidden' : 'visible';
  if (share != null) t.fill.style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, share)));
  t.card.title = hint;
  for (const [node, text] of [[t.label, label], [t.value, value], [t.sub, sub], [t.note, note]]) {
    if (node.textContent !== text) node.textContent = text;
  }
}

function healthNote() {
  const h = state.health;
  if (!h) return '';
  if (h.trend === 'fading') {
    const when = new Date(`${h.projection.date}T00:00:00`).toLocaleDateString([], { month: 'short', year: 'numeric' });
    return `Losing about ${h.lossPerMonthPercent}% a month. On this trend, ${h.projection.targetPercent}% around ${when}.`;
  }
  if (h.trend === 'steady') return `Holding steady over the last ${Math.round(h.spanDays)} days.`;
  return `Trend shows after ${h.minSpanDays} days of readings (${h.daysRecorded} so far).`;
}

function renderDetails(s) {
  const health = s.fullMah && s.designMah ? Math.round((s.fullMah / s.designMah) * 100) : null;
  setTile('health', {
    iconName: 'heart',
    tint: health == null ? 'neutral' : health >= 80 ? 'good' : health >= 60 ? 'yellow' : 'critical',
    label: 'Battery health',
    value: health != null ? `${health}%` : 'Not reported',
    sub: health != null ? `${fmtInt(s.fullMah)} of ${fmtInt(s.designMah)} mAh when new` : '',
    note: health != null ? healthNote() : '',
    share: health,
    hint: 'How much charge the battery can hold now, compared with when it was new.',
  });

  const rated = s.designCycles;
  setTile('cycles', {
    iconName: 'cycle',
    tint: 'blue',
    label: 'Charge cycles',
    value: s.cycleCount != null ? fmtInt(s.cycleCount) : 'Not reported',
    sub: s.cycleCount == null ? '' : rated ? `of ${fmtInt(rated)} it is rated for` : 'Full charges used so far',
    share: s.cycleCount != null && rated ? (s.cycleCount / rated) * 100 : null,
    hint: 'One cycle is a full 100% of charge used, even if spread over several top-ups.',
  });

  setTile('voltage', {
    iconName: 'pulse',
    tint: 'violet',
    label: 'Battery voltage',
    value: s.voltageMv != null ? `${(s.voltageMv / 1000).toFixed(2)} V` : 'Not reported',
    sub: s.amperageMa != null ? `${fmtInt(Math.abs(s.amperageMa))} mA ${s.amperageMa < 0 ? 'flowing out' : 'flowing in'}` : '',
    hint: 'The electrical pressure of the battery pack. It rises as the battery fills.',
  });

  if (s.tempC != null) {
    setTile('extra', {
      iconName: 'thermo',
      tint: s.tempC >= 40 ? 'critical' : 'orange',
      label: 'Battery temperature',
      value: `${s.tempC.toFixed(1)} °C`,
      sub: s.tempC >= 40 ? 'Running hot' : 'Normal range',
      hint: 'Batteries age faster when they stay hot.',
    });
  } else {
    setTile('extra', {
      iconName: 'plug',
      tint: 'aqua',
      label: 'Charger',
      value: s.adapter ? (s.adapter.watts ? `${s.adapter.watts} W` : 'Connected') : 'Unplugged',
      sub: s.adapter ? (s.adapter.name ?? 'Power adapter') : 'Running on battery',
      hint: 'The most power this charger can deliver.',
    });
  }
}

// Tiny trend line for the health tile, in the de-emphasis color.
function sparkline(values) {
  const w = 120;
  const h = 28;
  const min = Math.min(...values);
  const span = Math.max(0.5, Math.max(...values) - min);
  const px = (i) => 3 + (i / (values.length - 1)) * (w - 6);
  const py = (v) => h - 4 - ((v - min) / span) * (h - 8);
  const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  svg.append(
    svgEl('path', {
      d: `M${values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join('L')}`,
      'vector-effect': 'non-scaling-stroke',
    }),
  );
  return svg;
}

async function loadHealth() {
  try {
    state.health = await getJson('/api/health');
    const days = state.health.days;
    tiles.health.sparkHost.replaceChildren(...(days.length >= 3 ? [sparkline(days.map((d) => d.percent))] : []));
    if (state.latest) renderDetails(state.latest);
  } catch (err) {
    console.warn('Could not load health trend:', err.message);
  }
}

// ---------- energy use ----------

async function loadEnergy() {
  if (document.hidden) return;
  const empty = $('energy-empty');
  const list = $('energy');
  try {
    const data = await getJson('/api/energy');
    const isEnergy = data.metric === 'energy';
    setText(
      'energy-sub',
      isEnergy
        ? 'Energy impact of each app right now, the same figure Activity Monitor shows.'
        : 'Share of the processor each app is using right now, the closest stand-in for energy on this system.',
    );
    const max = Math.max(1, ...data.apps.map((a) => a.power));
    // Rows are updated in place so the bars glide to their new widths.
    while (list.children.length > data.apps.length) list.lastChild.remove();
    data.apps.forEach((app, i) => {
      let li = list.children[i];
      if (!li) {
        li = el('li');
        const track = el('span', 'bar-track');
        const bar = el('span', 'bar');
        bar.style.width = '0%';
        track.append(bar);
        li.append(el('span', 'name'), el('span', 'val'), track);
        list.append(li);
        li.getBoundingClientRect(); // lay out at 0% first, so the first width animates too
      }
      const value = isEnergy ? app.power.toFixed(1) : `${Math.round(app.power)}%`;
      li.children[0].textContent = app.name;
      li.children[1].textContent = value;
      li.children[2].firstChild.style.width = `${(app.power / max) * 100}%`;
      li.title = `${app.name}: ${isEnergy ? 'energy impact' : 'processor use'} ${value}`;
    });
    empty.hidden = data.apps.length > 0;
    empty.textContent = 'Nothing is working hard right now.';
  } catch {
    list.replaceChildren();
    empty.hidden = false;
    empty.textContent = 'Could not measure app activity.';
  }
}

// ---------- alerts ----------

function renderAlerts() {
  const today = new Date().toDateString();
  $('alerts').replaceChildren(
    ...state.alerts.map((a) => {
      const li = el('li', a.id === state.freshAlertId ? 'fresh' : null);
      li.dataset.severity = a.severity;
      const sameDay = new Date(a.ts).toDateString() === today;
      li.append(
        icon(a.severity === 'good' ? 'check' : 'warning'),
        el('span', 'alert-title', a.title),
        el('time', 'alert-time', sameDay ? fmtClock(a.ts) : fmtDayClock(a.ts)),
        el('span', 'alert-body', a.body),
      );
      return li;
    }),
  );
  $('alerts-empty').hidden = state.alerts.length > 0;
}

function renderNotifySetting({ notifications, notificationsAvailable }) {
  const toggle = $('notify-toggle');
  toggle.checked = notifications;
  toggle.disabled = !notificationsAvailable;
  setText(
    'alerts-sub',
    !notificationsAvailable
      ? 'Recorded here only. Notifications are switched off for this copy of the app.'
      : notifications
        ? 'Recorded here and sent as desktop notifications.'
        : 'Recorded here only. Desktop notifications are off.',
  );
}

async function loadAlerts() {
  try {
    const data = await getJson('/api/alerts');
    state.alerts = data.alerts;
    renderNotifySetting(data);
    renderAlerts();
  } catch (err) {
    console.warn('Could not load alerts:', err.message);
  }
}

function wireNotifyToggle() {
  const toggle = $('notify-toggle');
  toggle.addEventListener('change', async () => {
    const wanted = toggle.checked;
    sfx.tick();
    try {
      renderNotifySetting(
        await getJson('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notifications: wanted }),
        }),
      );
    } catch (err) {
      toggle.checked = !wanted; // the change did not save
      console.warn('Could not save the notification setting:', err.message);
    }
  });
}

// ---------- AI summary ----------

function renderSummary(summary, note) {
  const text = $('summary-text');
  text.hidden = !summary;
  if (summary) {
    text.replaceChildren(...summary.text.split(/\n\s*\n/).map((p) => el('p', null, p.trim())));
  }
  const message =
    note ??
    (summary
      ? `Written ${fmtDayClock(summary.ts)} by ${summary.model}.`
      : state.summaryReady
        ? ''
        : 'To switch this on, run "battery-speed key" in a terminal and paste a Claude API key.');
  $('summary-note').hidden = !message;
  $('summary-note').textContent = message;
  $('summary-button').textContent = summary ? 'Write a new summary' : 'Write summary';
}

async function loadSummary() {
  try {
    const data = await getJson('/api/summary');
    state.summary = data.summary;
    state.summaryReady = data.ready;
    renderSummary(state.summary);
  } catch (err) {
    console.warn('Could not load the saved summary:', err.message);
  }
}

function wireSummary() {
  const button = $('summary-button');
  button.addEventListener('click', async () => {
    sfx.tick();
    button.disabled = true;
    button.classList.add('busy');
    button.textContent = 'Writing…';
    try {
      const res = await fetch('/api/summary', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      state.summary = data.summary;
      renderSummary(state.summary);
      sfx.sparkle();
    } catch (err) {
      // Keep any earlier summary on screen and say why the new one failed.
      renderSummary(state.summary, err.message);
    } finally {
      button.disabled = false;
      button.classList.remove('busy');
    }
  });
}

// ---------- history ----------

let historyRequest = 0;

// Loads the saved history for the selected range. `fresh` marks a newly chosen
// range: the old charts dim while it loads, then the new lines draw in.
async function loadHistory({ fresh = false } = {}) {
  const request = ++historyRequest;
  if (fresh) document.body.classList.add('loading');
  try {
    const data = await getJson(`/api/history?minutes=${chart.windowMin}`);
    if (request !== historyRequest) return; // a newer request superseded this one
    chart.history = data.points;
    chart.bucketMs = data.bucketMs;
    chart.animate = fresh;
    appendLive(state.latest);
    setText(
      'history-note',
      data.count
        ? `${fmtInt(data.count)} ${data.count === 1 ? 'reading' : 'readings'} saved since ${fmtDayClock(data.since)}.`
        : '',
    );
  } catch (err) {
    console.warn('Could not load history:', err.message);
  } finally {
    if (request === historyRequest) {
      document.body.classList.remove('loading');
      renderCharts();
    }
  }
}

function appendLive(s) {
  if (!s) return;
  const last = chart.history[chart.history.length - 1];
  if (!last || s.ts > last.ts) chart.history.push(s);
  const cutoff = s.ts - chart.windowMin * 60_000;
  while (chart.history.length && chart.history[0].ts < cutoff) chart.history.shift();
}

function wireFilters() {
  const buttons = document.querySelectorAll('.filters button');
  for (const b of buttons) {
    b.addEventListener('click', () => {
      chart.windowMin = Number(b.dataset.window);
      for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
      chart.hoverTs = null;
      sfx.sweep();
      loadHistory({ fresh: true });
    });
  }
}

// ---------- sound toggle, connection, live feed ----------

function wireSound() {
  const button = $('sound-toggle');
  const show = () => {
    button.setAttribute('aria-pressed', String(sfx.enabled));
    button.title = sfx.enabled ? 'Sound effects are on. Click to mute.' : 'Sound effects are off. Click to turn on.';
    setIcon('sound-icon', sfx.enabled ? 'sound-on' : 'sound-off');
  };
  button.addEventListener('click', () => {
    sfx.setEnabled(!sfx.enabled);
    show();
  });
  show();
}

function setConnection(kind) {
  $('conn').dataset.state = kind;
  setText('conn-text', kind === 'live' ? 'Live' : kind === 'lost' ? 'Reconnecting…' : 'Connecting…');
}

function setFault(fault) {
  $('fault').hidden = !fault;
  if (fault) $('fault').textContent = `Could not read the battery: ${fault.message}`;
}

function onSample(s) {
  state.latest = s;
  chart.now = s.ts;
  renderHero(s);
  renderDetails(s);
  playChangeSounds(s);
}

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    state.meta = d.meta;
    if (d.meta) {
      $('platform').hidden = false;
      setText('platform', d.meta.platform);
      setText('version', `Version ${d.meta.version}.`);
    }
    if (d.latest) onSample(d.latest);
    setConnection('live');
    setFault(d.fault);
    loadHistory({ fresh: true });
    loadAlerts();
    loadHealth();
    loadEnergy();
    loadSummary();
  });
  es.addEventListener('sample', (e) => {
    const s = JSON.parse(e.data);
    onSample(s);
    appendLive(s);
    setConnection('live');
    setFault(null);
    renderCharts();
  });
  es.addEventListener('alert', (e) => {
    const alert = JSON.parse(e.data);
    state.freshAlertId = alert.id;
    state.alerts = [alert, ...state.alerts].slice(0, MAX_ALERTS_SHOWN);
    renderAlerts();
    sfx.alert(alert.severity);
  });
  es.addEventListener('fault', (e) => setFault(JSON.parse(e.data)));
  es.onerror = () => setConnection('lost');
}

// Stagger the entrance: each card rises a beat after the one before.
document.querySelectorAll('.reveal').forEach((node, i) => node.style.setProperty('--i', String(i)));

buildTiles();
wireCharts();
wireFilters();
wireNotifyToggle();
wireSummary();
wireSound();
connect();
setInterval(loadHistory, HISTORY_REFRESH_MS);
setInterval(loadEnergy, ENERGY_REFRESH_MS);
setInterval(loadHealth, HEALTH_REFRESH_MS);
document.addEventListener('visibilitychange', loadEnergy);
