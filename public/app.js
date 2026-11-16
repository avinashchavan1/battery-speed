// Dashboard: sidebar navigation, the live overview, and the other sections.

import {
  $, el, svgEl, icon, tween, getJson,
  fmtW, fmtSignedW, fmtInt, fmtDuration, fmtClock, fmtDayClock, flowWord,
} from './fmt.js';
import { chart, renderCharts, wireCharts } from './charts.js';
import { sfx } from './sfx.js';

const HISTORY_REFRESH_MS = 60_000;
const ENERGY_REFRESH_MS = 30_000;
const HEALTH_REFRESH_MS = 60 * 60_000;
const MAX_ALERTS_SHOWN = 20;
const VIEWS = ['overview', 'history', 'energy', 'chargers', 'alerts', 'health', 'summary'];
const CHARGERS_REFRESH_MS = 5 * 60_000;

const state = {
  view: 'overview',
  latest: null,
  previous: null, // { external, state } of the sample before, for change sounds
  alerts: [],
  freshAlertId: null,
  health: null,
  chargers: null,
  chargerKey: null, // plug state and rating, to reload charger memory when it changes
  summary: null,
  summaryReady: true,
};

const STATE_ICON = {
  charging: 'bolt',
  draining_on_ac: 'warning',
  discharging: 'battery',
  full: 'check',
  holding: 'pause',
  connecting: 'plug',
};

const setIcon = (useId, name) => $(useId).setAttribute('href', `#i-${name}`);
const setText = (id, text) => {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
};

// ---------- navigation ----------

function showView(name) {
  state.view = VIEWS.includes(name) ? name : 'overview';
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== state.view;
  for (const link of document.querySelectorAll('#nav a')) {
    if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('content').scrollTop = 0;
  if (state.view === 'history') renderCharts(); // charts size themselves once visible
  if (state.view === 'energy' || state.view === 'overview') loadEnergy();
  if (state.view === 'alerts') $('alerts-badge').hidden = true;
  if (state.view === 'chargers') loadChargers();
}

function wireNavigation() {
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  showView(location.hash.slice(1));
}

// ---------- overview ----------

// What the time estimate rests on, as a caption under the details.
function etaNote(d) {
  if (d.etaMin == null) return '';
  const parts = [];
  if (d.etaKind === 'full') {
    parts.push(
      d.etaBasis === 'learned'
        ? 'Time until full is based on how this battery has charged before.'
        : 'Time until full is a rough estimate that sharpens as charging history builds up.',
    );
  }
  if (d.typical) {
    parts.push(`At your usual on-battery draw of ${d.typical.watts.toFixed(1)} W it would last ${fmtDuration(d.typical.minutes)}.`);
  }
  if (d.gaugeEtaMin != null) parts.push(`The battery's own estimate is ${fmtDuration(d.gaugeEtaMin)}.`);
  return parts.join(' ');
}

// More watts, faster dots: 1 W drifts, 100 W streams.
const flowSpeed = (mw) => `${Math.max(0.3, 2 - Math.log10(1 + Math.abs(mw ?? 8000) / 1000) * 0.85).toFixed(2)}s`;

function setArrow(id, { dir, tone, label, note, mw }) {
  const arrow = $(id);
  arrow.dataset.dir = dir;
  arrow.dataset.tone = tone;
  const speed = flowSpeed(mw);
  if (arrow.style.getPropertyValue('--dur') !== speed) arrow.style.setProperty('--dur', speed);
  setText(`${id}-label`, label);
  setText(`${id}-note`, note);
}

// One power box: a colored heading, a big number, and a line saying what it is.
// While figures are being read, a box says so instead of "Not reported".
let settling = false;

function setBox(name, { tone, eyebrow, watts, note }) {
  $(`card-${name}`).dataset.tone = tone;
  if (eyebrow) setText(`${name}-eyebrow`, eyebrow);
  setText(`${name}-watts`, watts ?? (settling ? 'Reading…' : 'Not reported'));
  $(`${name}-unit`).hidden = watts == null;
  setText(`${name}-note`, settling && watts == null ? 'New figures arrive within a minute.' : note);
}

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// The three numbers as one sum, in the order that reads naturally for the state.
function renderSum(terms) {
  const sum = $('equation');
  sum.hidden = !terms;
  if (!terms) return;
  sum.replaceChildren(
    ...terms.map((term) => {
      if (typeof term === 'string') return el('span', 'sum-op', term);
      const node = el('span', 'sum-term');
      node.dataset.tone = term.tone;
      node.append(el('b', null, `${fmtW(term.mw)} W`), el('span', null, term.text));
      return node;
    }),
  );
}

// One bar divided into its parts: where the power comes from, or where it goes.
function renderSplit(title, parts) {
  const split = $('split');
  split.hidden = !parts;
  if (!parts) return;
  const whole = parts.reduce((total, part) => total + Math.abs(part.mw), 0);
  setText('split-title', title);
  $('split-bar').replaceChildren(
    ...parts.map((part) => {
      const segment = el('span');
      segment.dataset.tone = part.tone;
      segment.style.flexGrow = String(Math.max(Math.abs(part.mw), whole * 0.01));
      return segment;
    }),
  );
  $('split-legend').replaceChildren(
    ...parts.map((part) => {
      const li = el('li');
      li.dataset.tone = part.tone;
      li.append(
        el('b', null, `${fmtW(part.mw)} W`),
        document.createTextNode(`${part.text} (${share(Math.abs(part.mw), whole)}%)`),
      );
      return li;
    }),
  );
}

// In one or two plain sentences: what this means for you, and what to do.
function meaning(s, d) {
  const eta = d.etaMin != null ? fmtDuration(d.etaMin) : null;
  if (s.settling) {
    return s.externalConnected
      ? 'You just plugged in. The battery reports new figures once a minute, so how much power the charger gives shows up within a minute.'
      : 'You just unplugged, so the battery is now powering everything. How much power the laptop uses shows up within a minute.';
  }
  switch (d.state) {
    case 'draining_on_ac':
      return (
        'The charger cannot keep up with what the laptop is doing, so the battery fills the gap and goes down even though you are plugged in.' +
        (eta ? ` At this rate it is empty in about ${eta}.` : '') +
        ' A stronger charger, or closing the heaviest app below, stops the drain.'
      );
    case 'charging':
      return (
        'The charger gives more than the laptop needs, and the extra is filling the battery.' +
        (eta ? ` It will be full in about ${eta}.` : '')
      );
    case 'full':
      return 'The battery is full. The charger is running the laptop on its own.';
    case 'holding':
      return `The charger is running the laptop on its own. The battery is being held at ${s.percent}% and left alone, which is normal battery care.`;
    default:
      return (
        'Nothing is plugged in, so the battery is powering everything.' +
        (eta ? ` At this rate it lasts about ${eta}.` : '')
      );
  }
}

function renderOverview(s) {
  const d = s.derived;
  settling = Boolean(s.settling);
  $('chip').dataset.severity = d.severity;
  setIcon('chip-icon', STATE_ICON[d.state] ?? 'battery');
  setText('headline', d.headline);

  const hasEta = d.etaMin != null;
  $('eta').hidden = !hasEta;
  if (hasEta) {
    setText('eta-value', fmtDuration(d.etaMin));
    setText('eta-label', d.etaKind === 'empty' ? 'remaining' : 'until full');
  }
  setText('eta-note', etaNote(d));
  setText('meaning', meaning(s, d));

  const plugged = s.externalConnected;
  const inMw = s.adapterInMw;
  const loadMw = s.systemLoadMw;
  const battMw = s.batteryPowerMw;
  const inKnown = inMw != null;
  const loadKnown = loadMw != null;
  // charging | draining | idle. A battery the system is holding still shows a
  // trickle either way; that counts as resting, to agree with the headline.
  const resting = d.state === 'holding' || d.state === 'full';
  const flow = resting ? 'idle' : flowWord(battMw ?? 0);
  const trickle = resting && Math.abs(battMw ?? 0) >= 50;
  const rated = s.adapter?.watts;
  const chargerName = rated ? `${rated} W charger` : 'charger';
  const atLimit = rated && inKnown && inMw >= rated * 900; // within 10% of the rating

  // 1. Power coming in
  setBox('charger', {
    tone: plugged ? 'in' : 'off',
    eyebrow: plugged ? 'Coming in' : 'No charger',
    watts: !plugged ? '0' : inKnown ? fmtW(inMw) : null,
    note: !plugged
      ? 'Nothing is plugged in.'
      : inKnown
        ? `from the ${chargerName}${atLimit ? ', the most it can give' : ''}`
        : `The ${chargerName} is connected. This system does not report how much it gives.`,
  });
  setArrow('pipe-in', {
    dir: plugged && (!inKnown || inMw > 50) ? 'forward' : 'idle',
    tone: plugged ? 'in' : 'off',
    label: plugged && inKnown ? `${fmtW(inMw)} W` : '',
    note: plugged ? 'charger to laptop' : 'nothing flowing',
    mw: inMw,
  });

  // 2. Power being used
  setBox('laptop', {
    tone: 'use',
    watts: loadKnown ? fmtW(loadMw) : null,
    note: loadKnown
      ? 'is what the laptop needs right now'
      : 'This system does not report total use while plugged in.',
  });

  // 3. The battery: taking power in, giving it out, or resting
  setArrow('pipe-batt', {
    dir: flow === 'charging' ? 'forward' : flow === 'draining' ? 'reverse' : 'idle',
    tone: flow === 'charging' ? 'charge' : flow === 'draining' ? 'drain' : 'idle',
    label: flow === 'idle' ? '' : `${fmtW(battMw)} W`,
    note: settling ? 'updating…' : flow === 'charging' ? 'into the battery' : flow === 'draining' ? 'battery to laptop' : 'nothing flowing',
    mw: battMw,
  });
  setBox('battery', {
    tone: flow === 'charging' ? 'charge' : flow === 'draining' ? 'drain' : 'idle',
    eyebrow: settling ? 'Battery' : flow === 'charging' ? 'Going into battery' : flow === 'draining' ? 'Coming out of battery' : 'Battery resting',
    watts: battMw == null ? null : flow === 'idle' && !trickle ? '0' : fmtW(battMw),
    note:
      flow === 'charging'
        ? 'is filling the battery'
        : flow === 'draining'
          ? plugged
            ? 'is the gap the battery has to cover'
            : 'The battery is powering everything.'
          : trickle
            ? 'Only a trickle. The battery is resting.'
            : 'Not charging and not draining.',
  });

  const cell = $('cell');
  cell.style.setProperty('--level', String(Math.max(0, Math.min(100, s.percent ?? 0))));
  cell.dataset.tone =
    flow === 'charging' || d.state === 'full'
      ? 'good'
      : s.percent <= 10
        ? 'critical'
        : s.percent <= 20 || d.state === 'draining_on_ac'
          ? 'warning'
          : 'accent';
  tween($('percent'), s.percent, (v) => String(Math.round(v)));
  $('scene').setAttribute('aria-label', `${d.headline}. ${d.detail}`);

  // The sum and the split bar need all three figures.
  if (inKnown && loadKnown && battMw != null) {
    const charger = { tone: 'in', mw: inMw };
    const laptop = { tone: 'use', mw: loadMw };
    if (flow === 'charging') {
      renderSum([
        { ...charger, text: 'from charger' }, '−',
        { ...laptop, text: 'used by laptop' }, '=',
        { tone: 'charge', mw: battMw, text: 'into battery' },
      ]);
      renderSplit(`Where the charger's ${fmtW(inMw)} W goes`, [
        { ...laptop, text: ' runs the laptop' },
        { tone: 'charge', mw: battMw, text: ' fills the battery' },
      ]);
    } else if (flow === 'draining' && plugged) {
      renderSum([
        { ...charger, text: 'from charger' }, '+',
        { tone: 'drain', mw: battMw, text: 'from battery' }, '=',
        { ...laptop, text: 'used by laptop' },
      ]);
      renderSplit(`Where the laptop's ${fmtW(loadMw)} W comes from`, [
        { ...charger, text: ' from the charger' },
        { tone: 'drain', mw: battMw, text: ' from the battery' },
      ]);
    } else if (flow === 'draining') {
      renderSum([{ tone: 'drain', mw: battMw, text: 'from battery' }, '=', { ...laptop, text: 'used by laptop' }]);
      renderSplit(`Where the laptop's ${fmtW(loadMw)} W comes from`, [
        { tone: 'drain', mw: battMw, text: ' from the battery' },
      ]);
    } else {
      // The two figures are measured separately, so they match only roughly.
      renderSum([{ ...charger, text: 'from charger' }, '≈', { ...laptop, text: 'used by laptop' }]);
      renderSplit(`Where the charger's ${fmtW(inMw)} W goes`, [{ ...charger, text: ' runs the laptop' }]);
    }
  } else {
    renderSum(null);
    renderSplit(null, null);
  }

  // Details
  setText(
    'row-charger',
    !plugged
      ? 'Not connected'
      : !rated
        ? 'Connected'
        : inKnown
          ? `${rated} W maximum · giving ${fmtW(inMw)} W now (${share(inMw, rated * 1000)}% of its limit)`
          : `${rated} W maximum`,
  );
  setText(
    'row-charge',
    s.remainingMah != null && s.fullMah != null
      ? `${s.percent}% · ${fmtInt(s.remainingMah)} of ${fmtInt(s.fullMah)} mAh`
      : `${s.percent}%`,
  );
  setText('row-time-label', d.etaKind === 'full' ? 'Time until full' : 'Time remaining');
  setText(
    'row-time',
    hasEta ? fmtDuration(d.etaMin) : d.state === 'full' ? 'Fully charged' : d.state === 'holding' ? 'Not charging' : '–',
  );
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

// ---------- health ----------

function setMeter(id, share, tone) {
  const meter = $(id);
  meter.hidden = share == null;
  if (share == null) return;
  if (tone) meter.dataset.tone = tone;
  meter.firstChild.style.width = `${Math.max(0, Math.min(100, share))}%`;
}

function healthNote() {
  const h = state.health;
  if (!h) return '';
  if (h.trend === 'fading') {
    const when = new Date(`${h.projection.date}T00:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' });
    return `Losing about ${h.lossPerMonthPercent}% a month. On this trend it reaches ${h.projection.targetPercent}% around ${when}.`;
  }
  if (h.trend === 'steady') return `Holding steady over the last ${Math.round(h.spanDays)} days.`;
  return `A trend appears after ${h.minSpanDays} days of readings. ${h.daysRecorded} recorded so far.`;
}

function renderHealth(s) {
  const health = s.fullMah && s.designMah ? Math.round((s.fullMah / s.designMah) * 100) : null;
  setText('h-health', health != null ? `${health}%` : 'Not reported');
  setMeter('h-health-meter', health, health == null ? null : health >= 80 ? 'good' : health >= 60 ? 'warn' : 'bad');
  setText(
    'h-capacity',
    s.fullMah != null ? `${fmtInt(s.fullMah)} mAh${s.designMah ? ` of ${fmtInt(s.designMah)} when new` : ''}` : 'Not reported',
  );

  const rated = s.designCycles;
  setText(
    'h-cycles',
    s.cycleCount == null ? 'Not reported' : rated ? `${fmtInt(s.cycleCount)} of ${fmtInt(rated)}` : fmtInt(s.cycleCount),
  );
  setMeter('h-cycles-meter', s.cycleCount != null && rated ? (s.cycleCount / rated) * 100 : null);
  setText('h-trend', health != null ? healthNote() : '');

  setText('h-voltage', s.voltageMv != null ? `${(s.voltageMv / 1000).toFixed(2)} V` : 'Not reported');
  setText(
    'h-current',
    s.amperageMa != null ? `${fmtInt(Math.abs(s.amperageMa))} mA ${s.amperageMa < 0 ? 'out' : 'in'}` : 'Not reported',
  );
  $('h-temp-row').hidden = s.tempC == null;
  if (s.tempC != null) setText('h-temp', `${s.tempC.toFixed(1)} °C`);
  setText(
    'h-charger',
    s.adapter
      ? [s.adapter.watts ? `${s.adapter.watts} W` : 'Connected', s.adapter.name].filter(Boolean).join(' · ')
      : 'Not connected',
  );
}

// Trend line of daily capacity, shown once there are a few days to draw.
function sparkline(values) {
  const w = 320;
  const h = 36;
  const min = Math.min(...values);
  const span = Math.max(0.5, Math.max(...values) - min);
  const px = (i) => 2 + (i / (values.length - 1)) * (w - 4);
  const py = (v) => h - 4 - ((v - min) / span) * (h - 8);
  const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: `M${values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join('L')}` }));
  return svg;
}

async function loadHealth() {
  try {
    state.health = await getJson('/api/health');
    const days = state.health.days;
    $('h-spark').replaceChildren(...(days.length >= 3 ? [sparkline(days.map((d) => d.percent))] : []));
    if (state.latest) renderHealth(state.latest);
  } catch (err) {
    console.warn('Could not load health trend:', err.message);
  }
}

// ---------- energy ----------

// Rows are updated in place so the bars glide to their new widths.
function renderEnergyList(list, empty, data) {
  const hogName = data.hog?.name;
  const isEnergy = data.metric === 'energy';
  const max = Math.max(1, ...data.apps.map((a) => a.power));
  while (list.children.length > data.apps.length) list.lastChild.remove();
  data.apps.forEach((app, i) => {
    let li = list.children[i];
    if (!li) {
      li = el('li');
      const track = el('span', 'bar-track');
      const bar = el('span', 'bar');
      bar.style.width = '0%';
      track.append(bar);
      li.append(el('span', 'name'), track, el('span', 'val'));
      list.append(li);
      li.getBoundingClientRect(); // lay out at 0% first, so the first width animates too
    }
    li.children[0].textContent = `${i + 1}. ${app.name}`;
    li.classList.toggle('is-hog', app.name === hogName);
    li.children[1].firstChild.style.width = `${(app.power / max) * 100}%`;
    li.children[2].textContent = isEnergy ? app.power.toFixed(1) : `${Math.round(app.power)}%`;
  });
  empty.hidden = data.apps.length > 0;
  empty.textContent = 'Nothing is working hard right now.';
}

// The top five show on Overview and on Energy; both read the same measurement.
async function loadEnergy() {
  if (document.hidden || (state.view !== 'energy' && state.view !== 'overview')) return;
  const lists = [
    [$('energy-top'), $('energy-top-empty')],
    [$('energy'), $('energy-empty')],
  ];
  try {
    const data = await getJson('/api/energy');
    for (const [list, empty] of lists) renderEnergyList(list, empty, data);
    // When one app is draining the battery, say so above both lists.
    for (const callout of [$('hog-overview'), $('hog-energy')]) {
      callout.hidden = !data.hog;
      if (data.hog) {
        callout.querySelector('.callout-title').textContent = data.hog.title;
        callout.querySelector('.callout-body').textContent = data.hog.body;
      }
    }
    const explain =
      data.metric === 'energy'
        ? 'Ranked by energy impact, the same figure Activity Monitor shows. A higher number uses more battery.'
        : 'Ranked by share of the processor in use, the closest stand-in for energy use on this system.';
    setText('energy-sub', explain);
    setText('energy-top-sub', `${explain} Quitting the app at the top saves the most.`);
  } catch {
    for (const [list, empty] of lists) {
      list.replaceChildren();
      empty.hidden = false;
      empty.textContent = 'Could not measure app activity.';
    }
  }
}

// ---------- chargers ----------

const VERDICT = {
  good: { label: 'Keeps up', icon: 'check' },
  weak: { label: "Can't keep up", icon: 'warning' },
  learning: { label: 'Still learning', icon: 'pause' },
};

function used(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, '') : Math.round(hours)} h`;
}

function renderChargers() {
  const data = state.chargers;
  if (!data) return;
  const today = new Date().toDateString();
  $('chargers').replaceChildren(
    ...data.chargers.map((c) => {
      const li = el('li');
      li.dataset.verdict = c.verdict;
      const name = el('span', 'c-name', `${c.watts} W charger`);
      if (c.watts === data.current) name.append(el('span', 'c-now', 'Connected now'));
      const verdict = el('span', 'verdict', VERDICT[c.verdict].label);
      verdict.dataset.verdict = c.verdict;
      const when = new Date(c.lastSeen).toDateString() === today ? `today at ${fmtClock(c.lastSeen)}` : fmtDayClock(c.lastSeen);
      const meta = [
        `Used ${used(c.minutes)} over ${c.sessions} ${c.sessions === 1 ? 'time' : 'times'}`,
        c.maxInW != null ? `gave up to ${c.maxInW} W` : null,
        `last used ${when}`,
      ].filter(Boolean).join(' · ');
      li.append(icon(VERDICT[c.verdict].icon), name, verdict, el('span', 'c-summary', c.summary), el('span', 'c-meta', meta));
      return li;
    }),
  );
  $('chargers-empty').hidden = data.chargers.length > 0;
  setText(
    'chargers-advice',
    data.busyW != null && data.recommendW != null
      ? `When busy, this laptop draws about ${Math.round(data.busyW)} W (it stays below that 95% of the time). ` +
        `A ${data.recommendW} W charger or bigger runs it and still charges the battery.`
      : '',
  );
  renderChargerRecord();
}

// On Overview: the connected charger's verdict, linking to the full record.
function renderChargerRecord() {
  const s = state.latest;
  const watts = s?.externalConnected ? s.adapter?.watts : null;
  const record = watts != null ? state.chargers?.chargers.find((c) => c.watts === watts) : null;
  $('row-record').hidden = !record;
  if (!record) return;
  const verdict = $('row-record-verdict');
  verdict.dataset.verdict = record.verdict;
  setText(
    'row-record-verdict',
    record.verdict === 'weak'
      ? `Can't keep up: fell short ${record.shortSharePct}% of the time`
      : VERDICT[record.verdict].label,
  );
}

async function loadChargers({ fresh = false } = {}) {
  try {
    state.chargers = await getJson(`/api/chargers${fresh ? '?fresh=1' : ''}`);
    renderChargers();
  } catch (err) {
    console.warn('Could not load charger memory:', err.message);
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

function renderNotifySetting({ notifications, notificationsAvailable, unplugAt, digest, calendar }) {
  if (unplugAt != null) $('setting-unplug').value = unplugAt;
  if (digest != null) $('setting-digest').checked = digest;
  if (calendar != null) $('setting-calendar').checked = calendar;
  const toggle = $('notify-toggle');
  toggle.checked = notifications;
  toggle.disabled = !notificationsAvailable;
  setText(
    'alerts-sub',
    notificationsAvailable
      ? 'Alerts are always listed here. Turn this on to also get them as notifications.'
      : 'Notifications are switched off for this copy of the app. Alerts are still listed here.',
  );
}

async function loadAlerts() {
  try {
    const data = await getJson(`/api/alerts?limit=${MAX_ALERTS_SHOWN}`);
    state.alerts = data.alerts;
    renderNotifySetting(data);
    renderAlerts();
  } catch (err) {
    console.warn('Could not load alerts:', err.message);
  }
}

function wireNotifyTest() {
  const button = $('notify-test');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await getJson('/api/notify-test', { method: 'POST' });
      button.textContent = result.shown ? 'Sent' : 'Could not send';
    } catch {
      button.textContent = 'Could not send';
    }
    setTimeout(() => {
      button.textContent = 'Send Test Notification';
      button.disabled = false;
    }, 2500);
  });
}

// The reminder settings: each change is saved at once.
function wireReminderSettings() {
  const save = async (patch, revert) => {
    try {
      renderNotifySetting(
        await getJson('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }),
      );
    } catch (err) {
      revert();
      console.warn('Could not save the setting:', err.message);
    }
  };
  const unplug = $('setting-unplug');
  let lastUnplug = unplug.value;
  unplug.addEventListener('change', () => {
    const before = lastUnplug;
    lastUnplug = unplug.value;
    save({ unplugAt: unplug.value }, () => (unplug.value = lastUnplug = before));
  });
  for (const [id, key] of [['setting-digest', 'digest'], ['setting-calendar', 'calendar']]) {
    const box = $(id);
    box.addEventListener('change', () => save({ [key]: box.checked }, () => (box.checked = !box.checked)));
  }
}

function wireNotifyToggle() {
  const toggle = $('notify-toggle');
  toggle.addEventListener('change', async () => {
    const wanted = toggle.checked;
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

// ---------- summary ----------

const PRIVACY = {
  local: 'Written by an open-source model running on this computer. Nothing leaves it.',
  builtin:
    'Written by Battery Speed itself from your history: free, and nothing leaves this computer. ' +
    'For AI-written summaries, install Ollama (ollama.com) with a model such as llama3.2.',
};

function renderDigest(digest) {
  const show = Boolean(digest?.title);
  $('digest-block').hidden = !show;
  if (!show) return;
  setText('digest-title', digest.title);
  $('digest-lines').replaceChildren(...digest.lines.map((line) => el('li', null, line)));
}

function renderSummary(summary, note) {
  $('summary-group').hidden = !summary;
  if (summary) {
    $('summary-text').replaceChildren(...summary.text.split(/\n\s*\n/).map((p) => el('p', null, p.trim())));
  }
  const message =
    note ??
    (summary
      ? `Written ${fmtDayClock(summary.ts)} by ${summary.model}.${summary.note ? ` ${summary.note}` : ''}`
      : '');
  $('summary-note').hidden = !message;
  $('summary-note').textContent = message;
  $('summary-button').textContent = summary ? 'Write Again' : 'Write Summary';
}

async function loadSummary() {
  try {
    const data = await getJson('/api/summary');
    state.summary = data.summary;
    state.summaryReady = data.ready;
    setText('summary-privacy', PRIVACY[data.engine?.kind] ?? PRIVACY.builtin);
    renderDigest(data.digest);
    renderSummary(state.summary);
  } catch (err) {
    console.warn('Could not load the saved summary:', err.message);
  }
}

function wireSummary() {
  const button = $('summary-button');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Writing…';
    try {
      const res = await fetch('/api/summary', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      state.summary = data.summary;
      renderSummary(state.summary);
      sfx.done();
    } catch (err) {
      // Keep any earlier summary on screen and say why the new one failed.
      renderSummary(state.summary, err.message);
    } finally {
      button.disabled = false;
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
        ? `${fmtInt(data.count)} ${data.count === 1 ? 'reading' : 'readings'} saved on this computer since ${fmtDayClock(data.since)}.`
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
  if (!s || s.settling) return; // figures are unknown for a moment; nothing to plot
  const last = chart.history[chart.history.length - 1];
  if (!last || s.ts > last.ts) chart.history.push(s);
  const cutoff = s.ts - chart.windowMin * 60_000;
  while (chart.history.length && chart.history[0].ts < cutoff) chart.history.shift();
}

function wireRange() {
  const buttons = document.querySelectorAll('#range button');
  for (const b of buttons) {
    b.addEventListener('click', () => {
      chart.windowMin = Number(b.dataset.window);
      for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
      chart.hoverTs = null;
      loadHistory({ fresh: true });
    });
  }
}

// ---------- sound toggle, connection, live feed ----------

function wireSound() {
  const button = $('sound-toggle');
  const show = () => {
    button.setAttribute('aria-pressed', String(sfx.enabled));
    button.title = sfx.enabled ? 'Sounds are on' : 'Sounds are off';
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
  if (fault) $('fault').textContent = `Could not read the battery. ${fault.message}`;
}

function onSample(s) {
  state.latest = s;
  chart.now = s.ts;
  renderOverview(s);
  renderHealth(s);
  playChangeSounds(s);
  // A charger plugged in, unplugged, or newly identified: refresh what is known about it.
  const key = `${s.externalConnected}:${s.adapter?.watts ?? ''}`;
  if (state.chargerKey !== null && key !== state.chargerKey) loadChargers({ fresh: true });
  state.chargerKey = key;
  renderChargerRecord();
}

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    if (d.meta) setText('version', `Battery Speed ${d.meta.version} on ${d.meta.platform}`);
    if (d.latest) onSample(d.latest);
    setConnection('live');
    setFault(d.fault);
    loadHistory({ fresh: true });
    loadAlerts();
    loadHealth();
    loadEnergy();
    loadSummary();
    loadChargers();
  });
  es.addEventListener('sample', (e) => {
    const s = JSON.parse(e.data);
    onSample(s);
    appendLive(s);
    setConnection('live');
    setFault(null);
    if (state.view === 'history') renderCharts();
  });
  es.addEventListener('alert', (e) => {
    const alert = JSON.parse(e.data);
    state.freshAlertId = alert.id;
    state.alerts = [alert, ...state.alerts].slice(0, MAX_ALERTS_SHOWN);
    renderAlerts();
    if (state.view !== 'alerts') $('alerts-badge').hidden = false;
    sfx.alert(alert.severity);
  });
  es.addEventListener('fault', (e) => setFault(JSON.parse(e.data)));
  es.onerror = () => setConnection('lost');
}

// Inside the Mac app, behave like one: no web page context menu.
if (document.documentElement.classList.contains('in-app')) {
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}

wireNavigation();
wireCharts();
wireRange();
wireNotifyToggle();
wireNotifyTest();
wireReminderSettings();
wireSummary();
wireSound();
connect();
setInterval(loadHistory, HISTORY_REFRESH_MS);
setInterval(loadEnergy, ENERGY_REFRESH_MS);
setInterval(loadHealth, HEALTH_REFRESH_MS);
setInterval(loadChargers, CHARGERS_REFRESH_MS);
document.addEventListener('visibilitychange', loadEnergy);
