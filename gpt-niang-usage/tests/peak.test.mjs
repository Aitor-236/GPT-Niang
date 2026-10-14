import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOLIDAY_VALLEY,
  describePeak,
  isPeakTime,
  nextPeakChangeAt,
  peakHolidayCoverage
} from '../runtime/peak.mjs';

// Beijing time to epoch seconds, so the expectations read like the rule does.
const beijing = (text) => Math.floor(Date.parse(text + '+08:00') / 1000);

test('weekday office hours in Beijing are peak', () => {
  // 2026-10-14 is a Wednesday.
  assert.equal(isPeakTime(beijing('2026-10-14T08:59:00')), false);
  assert.equal(isPeakTime(beijing('2026-10-14T09:00:00')), true);
  assert.equal(isPeakTime(beijing('2026-10-14T11:59:00')), true);
  assert.equal(isPeakTime(beijing('2026-10-14T12:00:00')), false);
  assert.equal(isPeakTime(beijing('2026-10-14T13:59:00')), false);
  assert.equal(isPeakTime(beijing('2026-10-14T14:00:00')), true);
  assert.equal(isPeakTime(beijing('2026-10-14T17:59:00')), true);
  assert.equal(isPeakTime(beijing('2026-10-14T18:00:00')), false);
  assert.equal(isPeakTime(beijing('2026-10-14T23:30:00')), false);
  assert.equal(isPeakTime(beijing('2026-10-14T02:00:00')), false);
});

test('weekends are valley all day, including the office hours', () => {
  assert.equal(new Date(Date.parse('2026-10-17T12:00:00+08:00')).getDay(), 6);
  assert.equal(isPeakTime(beijing('2026-10-17T10:00:00')), false);
  assert.equal(isPeakTime(beijing('2026-10-18T15:00:00')), false);
});

test('public holidays are valley all day even on a weekday', () => {
  // 2026-10-01 (National Day) is a Thursday.
  assert.equal(new Date(Date.parse('2026-10-01T12:00:00+08:00')).getDay(), 4);
  assert.equal(isPeakTime(beijing('2026-10-01T10:00:00')), false);
  // Mid-Autumn (2026-09-25, a Friday) is after the clarification took effect.
  assert.equal(new Date(Date.parse('2026-09-25T12:00:00+08:00')).getDay(), 5);
  assert.equal(isPeakTime(beijing('2026-09-25T15:00:00')), false);
  // A normal Thursday in the same month is still peak.
  assert.equal(isPeakTime(beijing('2026-10-08T10:00:00')), true);
  // Holidays *before* the 2026-09-19 clarification are deliberately left as
  // they were priced then (the reference implementation keeps the same cutoff,
  // so historical buckets do not change under it).
  assert.equal(isPeakTime(beijing('2026-06-19T15:00:00')), true);
});

test('the next switch lands on a rule boundary', () => {
  const change = nextPeakChangeAt(beijing('2026-10-14T11:30:00'));
  assert.equal(change, beijing('2026-10-14T12:00:00'));
  assert.equal(nextPeakChangeAt(beijing('2026-10-14T12:30:00')), beijing('2026-10-14T14:00:00'));
  // Friday evening: the next switch is Monday 09:00, because the weekend is valley.
  assert.equal(nextPeakChangeAt(beijing('2026-10-16T19:00:00')), beijing('2026-10-19T09:00:00'));
  // Friday 10:00 is peak, and the next change is the lunch break.
  assert.equal(nextPeakChangeAt(beijing('2026-10-16T10:00:00')), beijing('2026-10-16T12:00:00'));
});

test('describePeak carries the state, the switch and the wording', () => {
  const peak = describePeak(beijing('2026-10-14T10:00:00'));
  assert.equal(peak.isPeak, true);
  assert.equal(peak.nextChangeAt, beijing('2026-10-14T12:00:00'));
  assert.match(peak.peakHours, /9:00–12:00/);
  assert.match(peak.valleyNote, /周末/);
  const valley = describePeak(beijing('2026-10-14T20:00:00'));
  assert.equal(valley.isPeak, false);
  assert.equal(valley.nextChangeAt, beijing('2026-10-15T09:00:00'));
  assert.equal(describePeak(Number.NaN).isPeak, false);
});

test('the holiday table covers whole years, so the startup warning is meaningful', () => {
  const years = peakHolidayCoverage();
  assert.ok(years.includes(2026));
  const dates = Object.keys(HOLIDAY_VALLEY);
  assert.equal(dates.length, 33, 'the 2026 arrangement lists 33 holiday dates');
  assert.ok(dates.every(date => /^\d{4}-\d{2}-\d{2}$/.test(date)));
});
