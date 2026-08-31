import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedMidnightUnix, zoneOffsetSeconds, localDate, formatClock } from '../src/replay/time.mjs';

const LONDON = 'Europe/London';

test('midnight is found in the local zone, not UTC', () => {
  // Mid-summer: London is an hour ahead, so local midnight is 23:00 UTC the
  // day before. Anchoring to UTC midnight would shift every bus by an hour.
  const summer = zonedMidnightUnix('2026-08-28', LONDON);
  assert.equal(new Date(summer * 1000).toISOString(), '2026-08-27T23:00:00.000Z');

  const winter = zonedMidnightUnix('2026-01-15', LONDON);
  assert.equal(new Date(winter * 1000).toISOString(), '2026-01-15T00:00:00.000Z');
});

test('the clocks going forward makes a 23-hour day', () => {
  // British Summer Time starts on 29 March 2026.
  const start = zonedMidnightUnix('2026-03-29', LONDON);
  const next = zonedMidnightUnix('2026-03-30', LONDON);
  assert.equal(next - start, 23 * 3600);
});

test('the clocks going back makes a 25-hour day', () => {
  const start = zonedMidnightUnix('2026-10-25', LONDON);
  const next = zonedMidnightUnix('2026-10-26', LONDON);
  assert.equal(next - start, 25 * 3600);
});

test('offsets track summer time', () => {
  assert.equal(zoneOffsetSeconds(zonedMidnightUnix('2026-08-28', LONDON), LONDON), 3600);
  assert.equal(zoneOffsetSeconds(zonedMidnightUnix('2026-01-15', LONDON), LONDON), 0);
});

test('a replay offset reads back as the wall clock people saw', () => {
  const day = zonedMidnightUnix('2026-08-28', LONDON);
  assert.equal(formatClock(day, 14 * 3600 + 23 * 60 + 32, LONDON), '14:23:32');
  assert.equal(localDate(day + 12 * 3600, LONDON), '2026-08-28');
});

test('an offset past a clock change still reads as the wall clock', () => {
  // 12 hours into the day the clocks go back, the wall clock says 11:00.
  const day = zonedMidnightUnix('2026-10-25', LONDON);
  assert.equal(formatClock(day, 12 * 3600, LONDON), '11:00:00');
});
