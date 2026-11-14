// Small shared helpers: DOM, formatting, and animated numbers.

export const $ = (id) => document.getElementById(id);
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const MINUS = '−';

export const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

export const svgEl = (name, attrs = {}, text) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
};

/** An icon from the sprite in index.html. */
export function icon(name, cls = 'icon') {
  const svg = svgEl('svg', { class: cls, 'aria-hidden': 'true' });
  svg.append(svgEl('use', { href: `#i-${name}` }));
  return svg;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const fmtW = (mw) => (mw == null ? '–' : (Math.abs(mw) / 1000).toFixed(1));
export const fmtSignedW = (mw) =>
  mw == null ? '–' : (mw <= -50 ? MINUS : mw >= 50 ? '+' : '') + fmtW(mw);
export const fmtInt = (n) => (n == null ? '–' : Math.round(n).toLocaleString('en-US'));

export function fmtDuration(min) {
  if (min < 1) return 'under 1 min';
  if (min > 24 * 60) return 'over 24 h';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const fmtClock = (ts, seconds = false) =>
  new Date(ts).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
export const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
export const fmtDayClock = (ts) => `${fmtDay(ts)}, ${fmtClock(ts)}`;

export const flowWord = (mw) => (mw <= -50 ? 'draining' : mw >= 50 ? 'charging' : 'idle');

export async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Counts a number up or down to its new value instead of snapping to it. */
export function tween(node, to, format, ms = 700) {
  if (to == null || Number.isNaN(to)) {
    cancelAnimationFrame(node._raf);
    node._v = null;
    node.textContent = '–';
    return;
  }
  const from = node._v ?? 0;
  node._v = to;
  cancelAnimationFrame(node._raf);
  // No animation frames run in a hidden tab, so set the value directly there.
  if (from === to || reducedMotion() || document.hidden) {
    node.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = format(from + (to - from) * eased);
    if (t < 1) node._raf = requestAnimationFrame(step);
  };
  node._raf = requestAnimationFrame(step);
}
