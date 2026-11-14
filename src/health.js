// Capacity fade over time, from the one-row-per-day health table.

const DAY_MS = 24 * 3600_000;
const MIN_SPAN_DAYS = 14; // shorter than this, the gauge's jitter drowns the trend
const MIN_POINTS = 8;
const MAX_HORIZON_DAYS = 10 * 365;

const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

export function healthTrend(rows) {
  const days = rows
    .filter((r) => r.fullMah && r.designMah)
    .map((r) => ({
      day: r.day,
      fullMah: r.fullMah,
      percent: Math.round((r.fullMah / r.designMah) * 1000) / 10,
      cycleCount: r.cycleCount,
    }));

  const result = { days, daysRecorded: days.length, minSpanDays: MIN_SPAN_DAYS, trend: 'learning', projection: null };
  if (days.length < 2) return result;

  const first = days[0];
  const last = days[days.length - 1];
  const spanDays = dayNumber(last.day) - dayNumber(first.day);
  result.spanDays = spanDays;
  result.cyclesGained = (last.cycleCount ?? 0) - (first.cycleCount ?? 0);
  if (spanDays < MIN_SPAN_DAYS || days.length < MIN_POINTS) return result;

  // Least-squares line through capacity vs. day.
  const xs = days.map((d) => dayNumber(d.day));
  const ys = days.map((d) => d.fullMah);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
  });
  const slope = sxx > 0 ? sxy / sxx : 0; // mAh per day
  const designMah = rows[rows.length - 1].designMah;
  const fittedNow = my + slope * (xs[xs.length - 1] - mx);

  result.lossPerMonthPercent = Math.round(((-slope * 30) / designMah) * 1000) / 10;
  if (slope >= 0) {
    result.trend = 'steady';
    return result;
  }

  // When does the fitted line reach the next 10% step down?
  const percentNow = (fittedNow / designMah) * 100;
  const targetPercent = Math.ceil(percentNow / 10) * 10 - 10;
  const daysToTarget = (fittedNow - (targetPercent / 100) * designMah) / -slope;
  if (daysToTarget > MAX_HORIZON_DAYS) {
    result.trend = 'steady';
    return result;
  }

  result.trend = 'fading';
  result.projection = {
    targetPercent,
    date: new Date((xs[xs.length - 1] + daysToTarget) * DAY_MS).toISOString().slice(0, 10),
  };
  return result;
}
