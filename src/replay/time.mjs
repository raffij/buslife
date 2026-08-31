/**
 * Time handling for replays.
 *
 * A replay is anchored to one instant — local midnight of the day it covers —
 * and every sample is an offset in seconds from it. Storing offsets rather
 * than seconds-since-midnight means the clock stays honest on the two days a
 * year when British Summer Time starts or ends and a local day is 23 or 25
 * hours long.
 */

/** How far ahead of UTC a zone is at a given instant, in seconds. */
export function zoneOffsetSeconds(unixSeconds, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(unixSeconds * 1000));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asIfUtc =
    Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
  return asIfUtc - unixSeconds;
}

/** The unix time of local midnight starting `dateStr` (YYYY-MM-DD) in `timeZone`. */
export function zonedMidnightUnix(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d) / 1000;
  // The offset depends on the instant, and the instant depends on the offset.
  // Two rounds settle it, including across a DST boundary.
  let guess = utcMidnight;
  for (let i = 0; i < 3; i++) guess = utcMidnight - zoneOffsetSeconds(guess, timeZone);
  return guess;
}

/** The local calendar date (YYYY-MM-DD) of an instant. */
export function localDate(unixSeconds, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

/** Wall-clock HH:MM:SS for an offset into a replay. */
export function formatClock(dayStartUnix, offsetSeconds, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date((dayStartUnix + offsetSeconds) * 1000));
}
