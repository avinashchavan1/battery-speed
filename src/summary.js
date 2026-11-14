// AI summary: a plain-language read of the last 24 hours, written by Claude.
//
// This is the one feature that sends data off this Mac, so it only ever runs
// when the user presses the button. What is sent: the digest built below
// (battery numbers, alert titles, and the names of the top energy-using apps).

const MODEL = 'claude-opus-5-5';
const DAY_MS = 24 * 3600_000;

const SYSTEM = `You write a short battery report for the owner of one laptop, from a JSON digest of the last 24 hours.

The reader wants to know what happened to their battery and what, if anything, to do about it. Write for someone who has not seen the numbers.

- Lead with the single most important finding.
- A null field means this system does not report that value; leave it out and do not guess at it.
- Use the digest's real numbers (watts, percent, minutes). Never invent a figure or a cause that the digest does not support. If the digest covers only a short time, say so rather than generalising.
- Then give at most three concrete suggestions, only where the data backs them. A charger that delivers less than the laptop uses, an app drawing unusual energy, and falling battery health are the kinds of things worth raising.
- Plain text only: two or three short paragraphs, no headings, no bullet symbols, no markdown. Under 140 words.`;

const round = (n, digits = 1) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

/** The data sent to the model. Kept small and free of anything identifying. */
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

/** Calls Claude. Resolves to { text, model } or throws an Error with a `.userMessage`. */
export async function generateSummary(digest, apiKey) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw userError('The Claude SDK is not installed. Run "npm install" in the project folder.');
  }

  // The key comes from ANTHROPIC_API_KEY or from `battery-speed key`. Without
  // one, the SDK falls back to its own sources (such as an `ant auth login` profile).
  const client = new Anthropic(apiKey ? { apiKey } : {});

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low' }, // a short summary of a small digest
      // If a safety classifier declines the request, re-run it on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(digest, null, 2) }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw userError('Claude rejected the API key. Run "battery-speed key" to set a working one.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw userError('Claude is rate limiting requests right now. Try again in a minute.');
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw userError('Could not reach the Claude API. Check the internet connection.');
    }
    if (err instanceof Anthropic.APIError) {
      throw userError(`The Claude API returned an error (${err.status ?? 'unknown'}).`, err);
    }
    // The SDK throws a plain error when it finds no credentials at all.
    throw userError(
      'No Claude API key set up yet. Run "battery-speed key" in a terminal to add one.',
      err,
    );
  }

  if (response.stop_reason === 'refusal') throw userError('Claude declined to write this summary.');
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) throw userError('Claude returned an empty summary.');
  return { text, model: response.model };
}

function userError(message, cause) {
  const err = new Error(message, { cause });
  err.userMessage = message;
  return err;
}
