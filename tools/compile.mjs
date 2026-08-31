#!/usr/bin/env node
/**
 * Turn a day of recorded sightings into a replay the web player can load.
 *
 * This is where the raw pings stop jumping around: each vehicle's day is
 * map-matched to the route shape (see lib/match.mjs), so every sample carries
 * a position *along the road* as well as the GPS fix it came from. The player
 * interpolates the former and can show you the latter.
 *
 *   npm run compile -- --date 2026-08-28 --line 99
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, die } from './lib/args.mjs';
import { vehicleKey } from './lib/siri.mjs';
import { matchVehicle, splitRuns } from './lib/match.mjs';
import { buildShape } from '../src/replay/geo.js';
import { zonedMidnightUnix } from '../src/replay/time.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();
const timeZone = args.tz ?? 'Europe/London';

const routePath = args.route ?? join(ROOT, 'data/routes/wave-99.route.json');
if (!existsSync(routePath)) die(`no route file at ${routePath}`);
const route = JSON.parse(readFileSync(routePath, 'utf8'));

const date = args.date;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) die('pass --date YYYY-MM-DD');

const inPath = args.in ?? join(ROOT, 'data/snapshots', `${date}.ndjson`);
if (!existsSync(inPath)) die(`no recording at ${inPath} — record one first with \`npm run record\``);

const line = args.line ? String(args.line) : route.line;
// Compiled replays live under public/ so the dev server and a static build
// both serve them without a copy step. Raw recordings stay in data/.
const replayDir = join(ROOT, 'public/replays');
const outPath = args.out ?? join(replayDir, `${route.id}-${date}.json`);

const shape = buildShape(route.coordinates);
const dayStart = zonedMidnightUnix(date, timeZone);

// --- read ------------------------------------------------------------------

const byVehicle = new Map();
let read = 0;
let skipped = 0;
for (const raw of readFileSync(inPath, 'utf8').split('\n')) {
  if (!raw) continue;
  let r;
  try {
    r = JSON.parse(raw);
  } catch {
    skipped++;
    continue;
  }
  read++;
  if (line && String(r.line) !== line) continue;
  const key = vehicleKey(r);
  if (!byVehicle.has(key)) byVehicle.set(key, []);
  byVehicle.get(key).push({ ...r, t: r.t - dayStart });
}

if (!byVehicle.size) {
  die(`no sightings for line ${line} in ${inPath} — check --line against the PublishedLineName in the feed`);
}

// --- match -----------------------------------------------------------------

const vehicles = [];
let totalSamples = 0;
let offRoute = 0;

for (const [key, pings] of [...byVehicle].sort(([a], [b]) => a.localeCompare(b))) {
  pings.sort((a, b) => a.t - b.t);
  // Two pings from the same second are the same sighting seen twice.
  const deduped = pings.filter((p, i) => i === 0 || p.t !== pings[i - 1].t);
  const matched = matchVehicle(deduped, shape);
  const runs = splitRuns(matched);
  if (!runs.length) continue; // never actually worked this route

  const t = [];
  const s = [];
  const dir = [];
  const lon = [];
  const lat = [];
  for (const m of matched) {
    t.push(Math.round(m.t));
    // -1 marks a sample that could not be placed on the route: a dead-run to
    // the depot, a diversion, or a bad fix. The player draws these at their
    // raw position instead of on the road.
    s.push(m.onRoute ? Math.round(m.s) : -1);
    dir.push(m.dir);
    lon.push(round5(m.lon));
    lat.push(round5(m.lat));
    if (!m.onRoute) offRoute++;
  }
  totalSamples += matched.length;

  const first = deduped[0];
  vehicles.push({
    id: key,
    ref: first.vehicleRef,
    operator: first.operatorRef,
    samples: { t, s, dir, lon, lat },
    runs: runs.map((r) => ({
      from: Math.round(r.samples[0].t),
      to: Math.round(r.samples[r.samples.length - 1].t),
      dir: r.dir,
      destination: lastNonNull(r.samples.map((x) => x.destinationName)),
      journeyRef: lastNonNull(r.samples.map((x) => x.journeyRef)),
    })),
  });
}

function round5(n) {
  return Math.round(n * 1e5) / 1e5;
}
function lastNonNull(xs) {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] != null) return xs[i];
  return null;
}

if (!vehicles.length) die(`no vehicle ever matched the route shape — is ${routePath} the right line?`);

const allT = vehicles.flatMap((v) => [v.samples.t[0], v.samples.t[v.samples.t.length - 1]]);

const replay = {
  version: 1,
  source: {
    kind: args['source-kind'] ?? 'bods-recording',
    recording: inPath.replace(`${ROOT}/`, ''),
    compiledAt: new Date().toISOString(),
  },
  date,
  timeZone,
  dayStartUnix: dayStart,
  window: [Math.min(...allT), Math.max(...allT)],
  route: {
    id: route.id,
    line: route.line,
    name: route.name,
    operator: route.operator,
    terminals: route.terminals,
    directions: route.directions,
    approximateShape: route.source?.approximate === true,
    coordinates: route.coordinates,
    timingPoints: route.timingPoints ?? [],
  },
  vehicles,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(replay));
writeManifest();

/**
 * Rebuild the index the player reads to populate its replay picker, so
 * compiling a new day is all it takes to make that day selectable.
 */
function writeManifest() {
  const entries = [];
  for (const file of readdirSync(replayDir).sort()) {
    if (!file.endsWith('.json') || file === 'index.json') continue;
    const r = JSON.parse(readFileSync(join(replayDir, file), 'utf8'));
    entries.push({
      file,
      date: r.date,
      line: r.route.line,
      name: r.route.name,
      operator: r.route.operator,
      vehicles: r.vehicles.length,
      window: r.window,
      sourceKind: r.source.kind,
    });
  }
  writeFileSync(join(replayDir, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
}

const pct = totalSamples ? ((offRoute / totalSamples) * 100).toFixed(1) : '0.0';
console.log(`read ${read} sightings${skipped ? ` (${skipped} unparseable lines skipped)` : ''}`);
console.log(`matched ${vehicles.length} vehicles, ${totalSamples} samples, ${pct}% off-route`);
console.log(`wrote ${outPath}`);
