// Sound effects, synthesised with the Web Audio API: no audio files to ship.
//
// Browsers only allow sound after the user has interacted with the page, so
// the audio context is created on the first click or key press. Until then,
// and whenever sound is switched off, every call here is a silent no-op.

const STORAGE_KEY = 'battery-speed-sound';

let ctx = null;
let enabled = true;
try {
  enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
} catch {
  // Storage can be unavailable (private windows); sound simply stays on.
}

function unlock() {
  if (!ctx) {
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtx) return;
    ctx = new AudioCtx();
  }
  if (ctx.state === 'suspended') ctx.resume();
}
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, unlock, { capture: true, passive: true });
}

/** One soft note: a sine or triangle with a quick fade in and out. */
function note({ freq, to = freq, at = 0, dur = 0.16, type = 'sine', gain = 0.07 }) {
  if (!enabled || !ctx || ctx.state !== 'running') return;
  const start = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, start + dur);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(amp).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

const sequence = (freqs, step, options = {}) =>
  freqs.forEach((freq, i) => note({ freq, at: i * step, ...options }));

export const sfx = {
  /** Charger connected: two rising notes. */
  plug: () => sequence([523.25, 783.99], 0.09, { dur: 0.2 }),
  /** Charger removed: two falling notes. */
  unplug: () => sequence([659.25, 392], 0.09, { dur: 0.2 }),
  /** Reached full: a short rising arpeggio. */
  full: () => sequence([523.25, 659.25, 783.99, 1046.5], 0.08, { dur: 0.22 }),
  /** A new alert, voiced by how serious it is. */
  alert(severity) {
    if (severity === 'good') sequence([659.25, 880], 0.1, { dur: 0.2 });
    else if (severity === 'critical') sequence([880, 880, 880], 0.16, { dur: 0.11, type: 'triangle', gain: 0.09 });
    else sequence([740, 587.33], 0.13, { dur: 0.16, type: 'triangle' });
  },
  /** A finished task, such as the summary arriving. */
  done: () => sequence([783.99, 1046.5], 0.08, { dur: 0.16, gain: 0.045 }),

  get enabled() {
    return enabled;
  },
  setEnabled(on) {
    enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      // Not saved; the choice still holds for this visit.
    }
    if (on) {
      unlock();
      this.done(); // confirms sound is on
    }
  },
};
