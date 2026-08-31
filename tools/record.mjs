#!/usr/bin/env node
/**
 * Record a day of bus positions from the Bus Open Data Service.
 *
 * BODS publishes where every bus in the country is right now, and nothing
 * about where they were. To replay a day you have to have been watching, so
 * this polls the feed on a fixed interval and appends every new sighting to a
 * newline-delimited log — one file per local day, safe to stop and restart.
 *
 *   BODS_API_KEY=... npm run record -- --line 99 --bbox 0.26,50.75,0.61,50.88
 *
 * Get a key (free) from https://data.bus-data.dft.gov.uk/account/signup/.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, die } from './lib/args.mjs';
import { parseSiriVm, vehicleKey } from './lib/siri.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEED = 'https://data.bus-data.dft.gov.uk/api/v1/datafeed/';

const args = parseArgs();
const apiKey = args.key ?? process.env.BODS_API_KEY;
if (!apiKey) {
  die('no API key. Set BODS_API_KEY or pass --key. Sign up at https://data.bus-data.dft.gov.uk/account/signup/');
}

const intervalMs = Number(args.interval ?? 30) * 1000;
const outDir = args.out ?? join(ROOT, 'data/snapshots');
const stopAfterMs = args.hours ? Number(args.hours) * 3600 * 1000 : null;

const query = new URLSearchParams({ api_key: apiKey });
// Every filter is optional. Without one you get the whole country, which is
// ~20MB a poll — fine to record, slow to compile, so narrow it if you can.
if (args.bbox) query.set('boundingBox', String(args.bbox));
if (args.line) query.set('lineRef', String(args.line));
if (args.operator) query.set('operatorRef', String(args.operator));
const url = `${FEED}?${query}`;

/** Local-day stamp, so a recording lines up with the day people mean. */
function localDay(unixSeconds) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

/**
 * Sightings already on disk, so restarting mid-day resumes rather than
 * duplicating. A sighting is the same one if it is the same bus reporting the
 * same instant — BODS repeats a vehicle's last known position on every poll
 * until it reports again.
 */
function loadSeen(file) {
  const seen = new Set();
  if (!existsSync(file)) return seen;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      seen.add(`${vehicleKey(r)}@${r.t}`);
    } catch {
      // A half-written last line from a hard kill. Skip it.
    }
  }
  return seen;
}

mkdirSync(outDir, { recursive: true });

let day = null;
let file = null;
let seen = new Set();
let polls = 0;
let written = 0;
let consecutiveFailures = 0;
let stopping = false;

async function poll() {
  const res = await fetch(url, { headers: { accept: 'application/xml' } });
  if (res.status === 401 || res.status === 403) {
    die(`BODS rejected the API key (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { records } = parseSiriVm(await res.text());

  const now = Math.round(Date.now() / 1000);
  const today = localDay(now);
  if (today !== day) {
    day = today;
    file = join(outDir, `${day}.ndjson`);
    seen = loadSeen(file);
    console.log(`recording to ${file}${seen.size ? ` (resuming, ${seen.size} sightings already)` : ''}`);
  }

  const fresh = [];
  for (const r of records) {
    const id = `${vehicleKey(r)}@${r.t}`;
    if (seen.has(id)) continue;
    seen.add(id);
    fresh.push(r);
  }
  if (fresh.length) {
    appendFileSync(file, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
    written += fresh.length;
  }
  polls++;
  process.stdout.write(
    `\rpoll ${polls} · ${records.length} vehicles in feed · +${fresh.length} new · ${written} recorded  `,
  );
}

const started = Date.now();
console.log(`polling BODS every ${intervalMs / 1000}s${args.line ? ` for line ${args.line}` : ''}`);
console.log('press ctrl-c to stop\n');

process.on('SIGINT', () => {
  stopping = true;
  console.log(`\nstopped after ${polls} polls, ${written} sightings recorded to ${file}`);
  process.exit(0);
});

while (!stopping) {
  try {
    await poll();
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    // A recording is worth more than any single poll, so a blip must not end
    // the run — back off and keep going, and only give up if the feed is
    // properly gone.
    console.error(`\npoll failed (${consecutiveFailures}): ${err.message}`);
    if (consecutiveFailures >= 10) die('ten consecutive failures, giving up');
    await new Promise((r) => setTimeout(r, Math.min(60_000, 2 ** consecutiveFailures * 1000)));
    continue;
  }
  if (stopAfterMs && Date.now() - started >= stopAfterMs) {
    console.log(`\ndone: ${polls} polls, ${written} sightings recorded to ${file}`);
    break;
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
