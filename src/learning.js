// What the saved history teaches: how this battery actually charges, and how
// much power this Mac typically draws on battery. Refreshed every few minutes.

const REFRESH_MS = 10 * 60_000;
const LOOKBACK_MS = 60 * 24 * 3600_000; // 60 days
const BAND = 5; // percent
const MIN_BAND_SAMPLES = 5;
const MIN_DISCHARGE_SAMPLES = 60; // roughly half an hour on battery
const TAPER_KNEE = 80; // without history, assume charging slows past 80%
const TAPER_FACTOR = 0.5;
// A band's peak current is seen at its start; the average across it is lower.
const BAND_AVERAGE_FACTOR = 0.9;

export class Profile {
  #store;
  #refreshedAt = 0;
  #bands = new Map(); // band start % -> highest charging current seen (mA)
  #typical = null; // { avgMa, avgMw }

  constructor(store) {
    this.#store = store;
  }

  #refresh(now) {
    if (now - this.#refreshedAt < REFRESH_MS) return;
    this.#refreshedAt = now;
    const since = now - LOOKBACK_MS;

    this.#bands = new Map(
      this.#store
        .chargeBands(since)
        .filter((b) => b.n >= MIN_BAND_SAMPLES)
        .map((b) => [b.band, b.maxMa]),
    );

    const t = this.#store.typicalDischarge(since);
    this.#typical = t && t.n >= MIN_DISCHARGE_SAMPLES ? { avgMa: t.avgMa, avgMw: t.avgMw } : null;
  }

  /**
   * Minutes until full. Walks each remaining 5% band at today's charging
   * current, capped by the most this battery has ever accepted in that band,
   * which is what makes the last stretch slow.
   */
  timeToFull(s, ma, now = s.ts) {
    this.#refresh(now);
    if (!(ma > 0) || !s.fullMah) return null;

    const percentNow = Math.min(100, (s.remainingMah / s.fullMah) * 100);
    let hours = 0;
    let learnedBands = 0;
    let totalBands = 0;

    for (let band = Math.floor(percentNow / BAND) * BAND; band < 100; band += BAND) {
      const from = Math.max(band, percentNow);
      const bandMah = ((band + BAND - from) / 100) * s.fullMah;
      if (bandMah <= 0) continue;
      totalBands++;

      const seen = this.#bands.get(band);
      let rate;
      if (seen != null) {
        rate = Math.min(ma, seen * BAND_AVERAGE_FACTOR);
        learnedBands++;
      } else {
        rate = band >= TAPER_KNEE ? ma * TAPER_FACTOR : ma;
      }
      hours += bandMah / rate;
    }

    return {
      minutes: Math.round(hours * 60),
      // "learned" once history covers most of what is left to charge.
      basis: totalBands > 0 && learnedBands / totalBands >= 0.6 ? 'learned' : 'rough',
    };
  }

  /** Minutes the remaining charge would last at the usual on-battery draw. */
  typicalTimeToEmpty(s, now = s.ts) {
    this.#refresh(now);
    if (!this.#typical || !(this.#typical.avgMa > 0) || s.remainingMah == null) return null;
    return {
      minutes: Math.round((s.remainingMah / this.#typical.avgMa) * 60),
      watts: this.#typical.avgMw / 1000,
    };
  }
}
