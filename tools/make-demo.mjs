#!/usr/bin/env node
/**
 * Generate a synthetic day of sightings in the BODS recording format.
 *
 * The point of this file is that the replayer has something to play the first
 * time you open it, without you having to sit and record a live feed for
 * eighteen hours first. It is NOT real data and is labelled as such
 * everywhere it surfaces.
 *
 * It writes raw-looking pings — GPS noise, dropped fixes, depot dead-runs —
 * and is then compiled by exactly the same `npm run compile` path as a real
 * recording, so the map-matcher gets a genuine workout rather than being fed
 * pre-cleaned positions.
 *
 * It also stages a disruption at 14:05, when buses towards Hastings start
 * being turned back at Glyne Gap for an hour, so the timeline has something
 * worth scrubbing to.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { buildShape, pointAtDistance, projectToShape } from '../src/replay/geo.js';
import { zonedMidnightUnix } from '../src/replay/time.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const date = args.date ?? '2026-08-28';
const timeZone = 'Europe/London';
const route = JSON.parse(
  readFileSync(args.route ?? join(ROOT, 'data/routes/wave-99.route.json'), 'utf8'),
);
const outPath = args.out ?? join(ROOT, 'data/snapshots', `demo-${date}.ndjson`);

const shape = buildShape(route.coordinates);
const dayStart = zonedMidnightUnix(date, timeZone);
const L = shape.length;

// A deterministic generator, so regenerating the demo does not churn the
// committed file for no reason.
let seed = 0x5eed1e;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function gauss(sigma) {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) * sigma;
}

const HOUR = 3600;
const LAYOVER = 11 * 60;
const HEADWAY = 20 * 60;
const SERVICE_START = 6 * HOUR;
const SERVICE_END = 23 * HOUR;
const PING_INTERVAL = 30;

// The disruption: for an hour, anything heading for Hastings is turned round
// at Glyne Gap and sent back the way it came.
const DISRUPTION = { from: 14 * HOUR + 5 * 60, to: 15 * HOUR + 5 * 60 };
const TURNBACK_S = projectToShape(shape, [0.5102, 50.8426]).s; // Glyne Gap

const timingS = route.timingPoints.map((tp) => projectToShape(shape, [tp.lon, tp.lat]).s);

/**
 * How fast a bus is moving at a point on the route. Buses are slow in town
 * and quick on the open coast road, they crawl in the afternoon peak, and
 * they pause at stops — which is what makes a replay look like buses rather
 * than beads on a wire.
 */
function speedAt(s, tOfDay) {
  const nearTown = timingS.some((ts) => Math.abs(ts - s) < 500);
  const mps = nearTown ? 4.6 : 9.2;
  const peak = tOfDay > 7.5 * HOUR && tOfDay < 9.5 * HOUR ? 0.72
    : tOfDay > 15.5 * HOUR && tOfDay < 18.5 * HOUR ? 0.68
    : 1;
  return Math.max(1.5, mps * peak * (1 + gauss(0.12)));
}

function dwellAt(s) {
  const stopping = timingS.some((ts) => Math.abs(ts - s) < 60);
  return stopping && rand() < 0.75 ? 12 + rand() * 30 : 0;
}

/** Simulate one journey, returning true positions along the route over time. */
function driveRun(startT, dir) {
  const samples = [];
  let s = dir === 1 ? 0 : L;
  let t = startT;
  let turnedBack = false;
  let step = 5; // integrate in 5s steps, emit a ping every 30s
  let sinceDwell = 0;

  while (t < SERVICE_END + HOUR) {
    const atEnd = dir === 1 ? s >= L : s <= 0;
    if (atEnd) break;

    if (
      !turnedBack &&
      dir === 1 &&
      t >= DISRUPTION.from &&
      t <= DISRUPTION.to &&
      s >= TURNBACK_S
    ) {
      // Turned round short of Hastings. The bus keeps its identity and
      // reverses, which is exactly the case the matcher has to get right.
      turnedBack = true;
      dir = -1;
      for (let held = 0; held < 90; held += PING_INTERVAL) {
        samples.push({ t: t + held, s, dir: 0 });
      }
      t += 90;
      continue;
    }

    s += speedAt(s, t) * step * dir;
    s = Math.max(0, Math.min(L, s));
    t += step;
    sinceDwell += step;

    if (sinceDwell >= PING_INTERVAL) {
      sinceDwell = 0;
      samples.push({ t, s, dir });
      const dwell = dwellAt(s);
      if (dwell) {
        for (let d = PING_INTERVAL; d < dwell; d += PING_INTERVAL) samples.push({ t: t + d, s, dir });
        t += dwell;
      }
    }
  }
  return { samples, endT: t, endDir: dir, turnedBack };
}

// --- build the day's blocks -------------------------------------------------

const fleet = [];
const records = [];
const DEPOT = [0.4646, 50.8681]; // a plausible yard inland of Bexhill, well off the route

let vehicleNumber = 36001;
// Enough buses to sustain the headway in both directions with layovers.
const needed = Math.ceil((65 * 60 + LAYOVER) / HEADWAY) * 2;

for (let i = 0; i < needed; i++) {
  const ref = String(vehicleNumber++);
  const half = Math.floor(needed / 2);
  const dir = i < half ? 1 : -1;
  const firstDeparture = SERVICE_START + (i % half) * HEADWAY;
  fleet.push({ ref, dir, firstDeparture });
}

for (const bus of fleet) {
  let t = bus.firstDeparture;
  let dir = bus.dir;

  // Out of the depot to the starting terminal, off-route the whole way.
  const start = pointAtDistance(shape, dir === 1 ? 0 : L);
  for (let k = 0; k < 8; k++) {
    const mix = k / 8;
    records.push(
      sighting(bus.ref, t - (8 - k) * 60, {
        lon: DEPOT[0] + (start[0] - DEPOT[0]) * mix,
        lat: DEPOT[1] + (start[1] - DEPOT[1]) * mix,
        dir: null,
        destination: 'Not in service',
      }),
    );
  }

  while (t < SERVICE_END) {
    const run = driveRun(t, dir);
    if (!run.samples.length) break;
    const destination = dir === 1 ? route.terminals.end : route.terminals.start;
    for (const sample of run.samples) {
      // One ping in forty never arrives: patchy coverage along the coast.
      if (rand() < 0.025) continue;
      const truth = pointAtDistance(shape, sample.s);
      // GPS error: mostly a few tens of metres, occasionally much worse.
      const sigma = rand() < 0.04 ? 130 : 22;
      const dLat = gauss(sigma) / 111_320;
      const dLon = gauss(sigma) / (111_320 * shape.lonScale);
      records.push(
        sighting(bus.ref, sample.t, {
          lon: truth[0] + dLon,
          lat: truth[1] + dLat,
          dir: sample.dir === 0 ? null : sample.dir,
          destination: run.turnedBack && sample.dir === -1 ? route.terminals.start : destination,
          journey: `${bus.ref}-${Math.round(t)}`,
        }),
      );
    }
    t = run.endT + LAYOVER;
    dir = run.endDir === 1 ? -1 : 1;
    if (run.turnedBack) dir = 1; // resumes its proper direction after the layover
  }
}

function sighting(ref, tOfDay, { lon, lat, dir, destination, journey }) {
  return {
    t: Math.round(dayStart + tOfDay),
    lon: Math.round(lon * 1e6) / 1e6,
    lat: Math.round(lat * 1e6) / 1e6,
    vehicleRef: ref,
    operatorRef: 'DEMO',
    line: route.line,
    journeyRef: journey ?? null,
    originName: dir === 1 ? route.terminals.start : route.terminals.end,
    destinationName: destination,
    originDeparture: null,
    bearing: null,
    directionRef: dir === 1 ? 'outbound' : dir === -1 ? 'inbound' : null,
  };
}

records.sort((a, b) => a.t - b.t || a.vehicleRef.localeCompare(b.vehicleRef));

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${records.length} synthetic sightings for ${fleet.length} vehicles to ${outPath}`);
console.log(`now: npm run compile -- --date ${date} --in ${outPath} --source-kind synthetic`);
