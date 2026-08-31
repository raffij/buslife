/**
 * Talking to Open Innovations' BODS archive (data.datalibrary.uk).
 *
 * BODS itself only tells you where every bus is *right now* — it keeps no
 * history — which is why `record.mjs` has to sit and poll it live. Open
 * Innovations already runs that poll and publishes the result: a same-shaped
 * SIRI-VM feed, archived every ~30s since 2025-06-18, bundled into one zip
 * per UTC calendar day per data source. See
 * https://github.com/open-innovations/bods-archive for how it's built.
 *
 * This module holds the parts of talking to that archive that don't need a
 * network — which day-bundle(s) a local calendar day needs, and how to pull
 * SIRI-VM XML back out of one. `fetch-archive.mjs` does the actual
 * downloading.
 */

import { unzipSync } from 'fflate';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { zonedMidnightUnix } from '../../src/replay/time.mjs';

export const ARCHIVE_BASE_URL = 'https://data.datalibrary.uk/transport/BODS-ARCHIVE';

/** The day-bundle URL for one UTC calendar day of one format ('sirivm' or 'gtfsrt'). */
export function dayBundleUrl(format, { year, month, day }) {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${ARCHIVE_BASE_URL}/${format}/${y}/${m}/${d}/${format}-${y}${m}${d}.zip`;
}

/** The calendar date one day after `dateStr` (YYYY-MM-DD), as a plain calendar
 * calculation — this deliberately has nothing to do with time zones. */
export function nextDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Every calendar date from `startStr` to `endStr` inclusive (both YYYY-MM-DD).
 * `YYYY-MM-DD` sorts the same lexicographically as chronologically, so a
 * plain string comparison is enough to validate the range and to know when
 * to stop — no Date arithmetic needed beyond `nextDateStr`.
 */
export function dateRange(startStr, endStr) {
  if (startStr > endStr) throw new Error(`start date ${startStr} is after end date ${endStr}`);
  const MAX_DAYS = 400; // a range this long is almost certainly a typo'd year, not intent
  const out = [];
  let cursor = startStr;
  while (cursor <= endStr) {
    out.push(cursor);
    if (out.length > MAX_DAYS) throw new Error(`range exceeds ${MAX_DAYS} days (${startStr}..${endStr}) — check --start/--end`);
    cursor = nextDateStr(cursor);
  }
  return out;
}

/**
 * Which UTC calendar day(s) a local calendar day's bundle(s) must be pulled
 * from. The archive is organised by UTC day, but a local day is not one — in
 * British Summer Time, Europe/London midnight-to-midnight is 23:00 UTC to
 * 23:00 UTC the next day, so it straddles two UTC-dated bundles. Missing the
 * first one silently drops the earliest hour of service (and, worse, misses
 * it without any error — a bus running at 00:30 local just never appears).
 */
export function utcDaysForLocalDate(dateStr, timeZone) {
  const start = zonedMidnightUnix(dateStr, timeZone);
  const end = zonedMidnightUnix(nextDateStr(dateStr), timeZone);

  const days = [];
  let cursor = Math.floor(start / 86400) * 86400;
  while (cursor < end) {
    const d = new Date(cursor * 1000);
    days.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
    cursor += 86400;
  }
  return days;
}

/**
 * The SIRI-VM XML documents inside one day-bundle zip.
 *
 * The bundle's own structure isn't documented anywhere we could find, and
 * archive.sh's own download step is a raw `curl -o file.zip` of BODS'
 * response body — so a bundle entry might be the XML directly, or it might
 * be one more zip wrapping it (BODS' own per-poll response, bundled
 * unmodified). Handling both means this doesn't silently return zero
 * documents if Open Innovations changes which one they do.
 *
 * Yields `{ name, xml }` lazily so a caller can parse-and-discard one
 * document at a time rather than holding a whole day's XML in memory.
 */
export function* xmlDocumentsInBundle(zipBytes) {
  const entries = unzipSync(zipBytes);
  const decoder = new TextDecoder();
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // a directory entry
    if (name.toLowerCase().endsWith('.zip')) {
      for (const inner of xmlDocumentsInBundle(bytes)) yield inner;
      continue;
    }
    yield { name, xml: decoder.decode(bytes) };
  }
}

/**
 * Read XML entries from a ZIP file without loading the archive into Node's
 * heap. The runner has the portable `unzip` utility installed, and it can
 * seek to each entry in a multi-GB archive while this process only holds one
 * XML document (or nested per-poll ZIP) at a time.
 *
 * This is deliberately separate from xmlDocumentsInBundle(): the byte-based
 * helper is useful for small unit-test fixtures and callers that already have
 * bytes, while the archive fetch path must remain safe for 6GB bundles.
 */
export function* xmlDocumentsInZipFile(zipPath) {
  if (!existsSync(zipPath)) throw new Error(`no ZIP file at ${zipPath}`);

  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  for (const name of listing.split('\n')) {
    if (!name || name.endsWith('/')) continue;
    const bytes = execFileSync('unzip', ['-p', zipPath, name], { maxBuffer: 128 * 1024 * 1024 });
    if (name.toLowerCase().endsWith('.zip')) {
      yield* xmlDocumentsInBundle(bytes);
    } else {
      yield { name, xml: new TextDecoder().decode(bytes) };
    }
  }
}
