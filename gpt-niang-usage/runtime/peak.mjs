// DeepSeek's peak / off-peak pricing window, as plain data plus two pure
// functions. The rule is the one the whale widget follows, which cites the
// official pricing note:
//
//   高峰时段 = 北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00
//   其余时段 —— 周末、调休上班的周末、以及中国法定节假日全天 —— 一律按空闲计费
//
// It only decides which label a widget shows; no money is computed here.

// [startHour, endHour) in Beijing time.
export const PEAK_HOURS = [[9, 12], [14, 18]];

// Weekends have been valley-priced since 2026-08-23 (Beijing), and public
// holidays all day since 2026-09-19. Both cutoffs are kept so the answer stays
// right if anyone asks about a moment before them.
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000);
const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000);

// Days that are valley all day: the *holiday* dates only. Make-up working days
// all fall on a weekend, which the weekend rule already covers.
//
// ⚠️ Extend this for the next year once the State Council publishes the
// arrangement (usually November); peakHolidayCoverage() reports what is missing
// and the widget logs a warning at startup.
export const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1
};

// Which years the holiday list above covers, for the startup warning.
export function peakHolidayCoverage() {
  return [...new Set(Object.keys(HOLIDAY_VALLEY).map(key => Number(key.slice(0, 4))))].sort();
}

function beijingDate(epochSec) {
  // China has no daylight saving, so shifting the epoch and reading UTC fields
  // gives the Beijing calendar time.
  return new Date(epochSec * 1000 + 8 * 3600 * 1000);
}

function isHolidayValley(date) {
  return Boolean(HOLIDAY_VALLEY[date.toISOString().slice(0, 10)]);
}

export function isPeakTime(epochSec) {
  const seconds = Number(epochSec);
  if (!Number.isFinite(seconds)) return false;
  const beijing = beijingDate(seconds);
  if (seconds >= WEEKEND_VALLEY_FROM_SEC) {
    const day = beijing.getUTCDay();
    if (day === 0 || day === 6) return false;
  }
  if (seconds >= HOLIDAY_VALLEY_FROM_SEC && isHolidayValley(beijing)) return false;
  const hour = beijing.getUTCHours();
  return PEAK_HOURS.some(([start, end]) => hour >= start && hour < end);
}

// The next moment the label changes, or null if there is none within two weeks
// (which the current rule never produces, but callers should not assume).
export function nextPeakChangeAt(epochSec) {
  const seconds = Number(epochSec);
  if (!Number.isFinite(seconds)) return null;
  const current = isPeakTime(seconds);
  const dayStart = Math.floor((seconds + 8 * 3600) / 86400) * 86400;
  for (let day = 0; day <= 12; day += 1) {
    for (const hour of [0, 9, 12, 14, 18]) {
      const candidate = dayStart + day * 86400 + hour * 3600 - 8 * 3600;
      if (candidate <= seconds + 1) continue;
      if (isPeakTime(candidate) !== current) return candidate;
    }
  }
  return null;
}

// Everything a widget needs: the state now, when it changes, and the rule in
// prose for the hover tooltip.
export function describePeak(epochSec, {next = nextPeakChangeAt(epochSec)} = {}) {
  const seconds = Number(epochSec);
  return {
    isPeak: isPeakTime(seconds),
    nextChangeAt: next,
    peakHours: '周一至周五 9:00–12:00、14:00–18:00（北京时间）',
    valleyNote: '其余时段（含周末与法定节假日）为优惠时段'
  };
}
