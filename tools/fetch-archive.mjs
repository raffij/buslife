#!/usr/bin/env node
/**
 * Backfill a day of sightings from Open Innovations' BODS archive instead of
 * recording it live.
 *
 * `record.mjs` only ever sees today, one poll at a time, because BODS itself
 * keeps no history — that's the whole reason it has to sit and watch.
 * https://data.datalibrary.uk/transport/BODS-ARCHIVE has already been
 * polling the same feed every ~30s since 2025-06-18 and publishes the result
 * as one zip per UTC calendar day, so any day since then can be backfilled
 * in one shot instead of waited for.
 *
 *   npm run fetch-archive -- --date 2026-08-30 --line 99
 *   npm run compile -- --date 2026-08-30
 *
 * A day-bundle is the whole country's SIRI-VM traffic and can run into the
 * multiple GB, so this streams the download to disk, then reads each ZIP
 * entry individually, filters it to the requested line, and discards it —
 * nothing about the other ~99% of the country's buses is held in memory at
 * once.
 */

import { appendFileSync, existsSync, mkdirSync, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, die } from './lib/args.mjs';
import { parseSiriVm, vehicleKey } from './lib/siri.mjs';
import { dayBundleUrl, nextDateStr, utcDaysForLocalDate, xmlDocumentsInZipFile } from './lib/archive.mjs';
import { zonedMidnightUnix } from '../src/replay/time.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const date = args.date;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) die('pass --date YYYY-MM-DD (a local date — see README)');

const timeZone = args.tz ?? 'Europe/London';
const line = args.line ? String(args.line) : null;
const operator = args.operator ? String(args.operator) : null;
const cacheDir = args['cache-dir'] ?? join(ROOT, 'data/archive-cache');
const outPath = args.out ?? join(ROOT, 'data/snapshots', `${date}.ndjson`);

if (!line) {
  die('pass --line (the archive is the whole country — filtering client-side is the entire point, see the module doc)');
}

const start = zonedMidnightUnix(date, timeZone);
const end = zonedMidnightUnix(nextDateStr(date), timeZone);
const utcDays = utcDaysForLocalDate(date, timeZone);

mkdirSync(cacheDir, { recursive: true });
mkdirSync(dirname(outPath), { recursive: true });

console.log(`fetching ${date} (${timeZone}) — needs ${utcDays.length} UTC day-bundle(s): ${utcDays.map((d) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`).join(', ')}`);

/** Download with one retry — a multi-hundred-MB transfer is worth retrying once before giving up. */
async function fetchWithRetry(url, destination) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const partial = `${destination}.part`;
    try {
      const res = await fetch(url);
      if (res.status === 404) return null; // no bundle for that day (before the archive started, or a gap)
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('response has no body');
      await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
      renameSync(partial, destination);
      return true;
    } catch (err) {
      if (existsSync(partial)) unlinkSync(partial);
      if (attempt === 2) throw err;
      console.log(`  retrying after: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

const matched = [];
let seen = new Set();
let docsRead = 0;
let recordsSeen = 0;

for (const utcDay of utcDays) {
  const label = `${utcDay.year}-${String(utcDay.month).padStart(2, '0')}-${String(utcDay.day).padStart(2, '0')}`;
  const cachePath = join(cacheDir, `sirivm-${label}.zip`);

  let bundleAvailable;
  if (existsSync(cachePath)) {
    console.log(`${label}: using cached bundle (${cachePath})`);
    bundleAvailable = true;
  } else {
    const url = dayBundleUrl('sirivm', utcDay);
    console.log(`${label}: downloading ${url}`);
    bundleAvailable = await fetchWithRetry(url, cachePath);
    if (!bundleAvailable) {
      console.log(`${label}: no bundle published (404) — skipping`);
      continue;
    }
    console.log(`${label}: downloaded to ${cachePath}`);
  }

  for (const { xml } of xmlDocumentsInZipFile(cachePath)) {
    docsRead++;
    if (docsRead % 500 === 0) process.stdout.write(`\r${label}: parsed ${docsRead} documents, ${matched.length} matches so far  `);

    let records;
    try {
      ({ records } = parseSiriVm(xml));
    } catch {
      continue; // one malformed document in a day's worth is not worth aborting for
    }

    for (const r of records) {
      recordsSeen++;
      if (String(r.line) !== line) continue;
      if (operator && r.operatorRef !== operator) continue;
      if (r.t < start || r.t >= end) continue; // outside the requested local day
      const id = `${vehicleKey(r)}@${r.t}`;
      if (seen.has(id)) continue;
      seen.add(id);
      matched.push(r);
    }
  }
  console.log(`\n${label}: done — ${docsRead} documents parsed so far, ${matched.length} matching sightings`);
}

if (!matched.length) {
  die(
    `no sightings for line ${line}${operator ? ` / operator ${operator}` : ''} on ${date}. ` +
      `Checked ${recordsSeen} vehicle records total across ${docsRead} documents — if that's 0, ` +
      `the archive may not have data for this day yet (it started 2025-06-18); if it's nonzero, ` +
      `double check --line against the PublishedLineName in the feed (try without --line filtering ` +
      `one document by hand if unsure).`,
  );
}

matched.sort((a, b) => a.t - b.t);
appendFileSync(outPath, matched.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${matched.length} sightings to ${outPath}`);
console.log(`now: npm run compile -- --date ${date}`);
