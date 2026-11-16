// Summary: a plain-language read of the last 24 hours. Written by a local
// open-source model when one is installed, otherwise by the built-in analysis.
// Either way, nothing leaves this computer.

const DAY_MS = 24 * 3600_000;

const SYSTEM = `You write a short battery report for the owner of one laptop, from a JSON digest of the last 24 hours.

The reader wants to know what happened to their battery and what, if anything, to do about it. Write for someone who has not seen the numbers.

- Lead with the single most important finding.
- A null field means this system does not report that value; leave it out and do not guess at it.
- Use the digest's real numbers (watts, percent, minutes). Never invent a figure or a cause that the digest does not support. If the digest covers only a short time, say so rather than generalising.
- Then give at most three concrete suggestions, only where the data backs them. A charger that delivers less than the laptop uses, an app drawing unusual energy, and falling battery health are the kinds of things worth raising.
- Plain text only: two or three short paragraphs, no headings, no bullet symbols, no markdown. Under 140 words.`;

const round = (n, digits = 1) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

/** The data given to the local model. Kept small and free of anything identifying. */
export function buildDigest({ store, latest, energy, health, now = Date.now() }) {
  const since = now - DAY_MS;
  const byState = store.stateBreakdown(since).map((r) => ({
    state: r.state,
    minutes: Math.round(r.ms / 60_000),
    avgSystemWatts: round(r.avgLoadMw / 1000),
    peakSystemWatts: round(r.peakLoadMw / 1000),
    avgBatteryWatts: round(r.avgBattMw / 1000), // negative = draining
    minPercent: r.minPct,
    maxPercent: r.maxPct,
  }));

  return {
    hoursOfDataInWindow: round(byState.reduce((sum, s) => sum + s.minutes, 0) / 60),
    stateMeanings: {
      charging: 'plugged in, battery gaining charge',
      discharging: 'running on battery',
      draining_on_ac: 'plugged in but battery still losing charge because the laptop uses more than the adapter delivers',
      holding: 'plugged in, battery idle',
      full: 'plugged in at 100%',
    },
    now: latest && {
      percent: latest.percent,
      state: latest.derived.state,
      adapterRatedWatts: latest.adapter?.watts ?? null,
      adapterDeliveringWatts: round(latest.adapterInMw / 1000),
      systemUsingWatts: round(latest.systemLoadMw / 1000),
      minutesUntil: latest.derived.etaMin != null ? { [latest.derived.etaKind]: latest.derived.etaMin } : null,
    },
    last24hByState: byState,
    alertsLast24h: store
      .recentAlerts(20)
      .filter((a) => a.ts >= since)
      .map((a) => ({ minutesAgo: Math.round((now - a.ts) / 60_000), title: a.title })),
    health: latest && {
      percentOfDesignCapacity: round((latest.fullMah / latest.designMah) * 100),
      cycles: latest.cycleCount,
      ratedCycles: latest.designCycles,
      trend: health?.trend ?? 'learning',
      lossPerMonthPercent: health?.lossPerMonthPercent ?? null,
    },
    topAppsRightNow: {
      rankedBy: energy?.metric === 'energy' ? 'energy impact (unitless)' : 'CPU percent',
      apps: (energy?.apps ?? []).map((a) => ({ app: a.name, value: a.power })),
    },
  };
}

function userError(message, cause) {
  const err = new Error(message, { cause });
  err.userMessage = message;
  return err;
}

// ---------------------------------------------------------------- engines
//
// The summary is written by the best option available, both free and private:
//   1. a local open-source model through Ollama, if it is installed and has
//      a model (it runs on this computer)
//   2. the built-in analysis (src/analysis.js), which always works

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
// Preferred families, roughly from best at short factual writing to smallest.
const OLLAMA_PREFERRED = ['llama3.2', 'llama3.1', 'qwen2.5', 'qwen3', 'gemma3', 'gemma2', 'mistral', 'phi'];

/** The local model to use, or null if Ollama is not running or has no model. */
export async function findOllamaModel() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const { models = [] } = await res.json();
    if (!models.length) return null;
    const preferred = models.find((m) => OLLAMA_PREFERRED.some((family) => m.name.startsWith(family)));
    return (preferred ?? models[0]).name;
  } catch {
    return null;
  }
}

async function viaOllama(model, digest) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0.3 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(digest, null, 2) },
      ],
    }),
    signal: AbortSignal.timeout(180_000), // a small model on a laptop can take a while
  });
  if (!res.ok) throw userError(`The local model returned an error (${res.status}).`);
  const data = await res.json();
  // Some models write out their reasoning first; keep only the answer.
  const text = (data.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw userError('The local model returned an empty summary.');
  return text;
}

/** Which engine would write the summary right now. */
export async function summaryEngine() {
  const model = await findOllamaModel();
  if (model) return { kind: 'local', label: `${model}, running on this computer` };
  return { kind: 'builtin', label: 'built-in analysis' };
}

/**
 * Writes the summary with the best available engine. A failing AI engine
 * falls back to the built-in analysis, so the button always gives an answer.
 */
export async function writeSummaryText({ digest, builtin }) {
  const engine = await summaryEngine();
  try {
    if (engine.kind === 'local') return { text: await viaOllama(engine.label.split(',')[0], digest), engine };
  } catch (err) {
    console.error(`[summary] ${engine.kind} failed, using the built-in analysis:`, err.cause?.message ?? err.message);
    return {
      text: builtin,
      engine: { kind: 'builtin', label: 'built-in analysis' },
      note: `${err.userMessage ?? 'The AI model failed.'} Showing the built-in analysis instead.`,
    };
  }
  return { text: builtin, engine };
}
