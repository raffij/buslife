import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShape, pointAtDistance } from '../src/replay/geo.js';
import { matchVehicle, splitRuns } from '../tools/lib/match.mjs';

// A deliberately bendy route: if the matcher were interpolating between raw
// fixes rather than following the road, these corners are where it would show.
const SHAPE = buildShape([
  [0.28, 50.77], [0.32, 50.79], [0.33, 50.81], [0.35, 50.82], [0.39, 50.823],
  [0.42, 50.835], [0.43, 50.842], [0.47, 50.841], [0.51, 50.843], [0.53, 50.848],
  [0.56, 50.852], [0.573, 50.858], [0.583, 50.856],
]);

/** Deterministic noise, so a failure is always reproducible. */
function noiseFn(seed = 1) {
  let state = seed >>> 0;
  return (sigmaM) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    const u = Math.max(1e-9, state / 0x100000000);
    state = (state * 1664525 + 1013904223) >>> 0;
    const v = state / 0x100000000;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigmaM;
  };
}

/**
 * Drive a bus along the shape and report what BODS would have seen: a noisy
 * fix every 30 seconds. `truth` is kept so we can check what came back.
 */
function drive({ from, to, startT = 0, speed = 9, sigma = 25, seed = 7 }) {
  const noise = noiseFn(seed);
  const dir = Math.sign(to - from);
  const pings = [];
  const truth = [];
  for (let t = startT; ; t += 30) {
    const s = from + dir * speed * (t - startT);
    if (dir > 0 ? s > to : s < to) break;
    const [lon, lat] = pointAtDistance(SHAPE, s);
    pings.push({
      t,
      lon: lon + noise(sigma) / (111_320 * SHAPE.lonScale),
      lat: lat + noise(sigma) / 111_320,
    });
    truth.push(s);
  }
  return { pings, truth, dir };
}

function errorsAgainst(matched, truth) {
  return matched
    .map((m, i) => (m.onRoute ? Math.abs(m.s - truth[i]) : null))
    .filter((e) => e !== null)
    .sort((a, b) => a - b);
}

test('a noisy journey is recovered as a position along the road', () => {
  const { pings, truth } = drive({ from: 0, to: SHAPE.length });
  const matched = matchVehicle(pings, SHAPE);

  assert.equal(matched.length, pings.length);
  assert.ok(matched.every((m) => m.onRoute), 'every fix should land on the route');

  const errors = errorsAgainst(matched, truth);
  const median = errors[errors.length >> 1];
  assert.ok(median < 40, `median error ${median.toFixed(0)}m should be well under the GPS noise`);
  assert.ok(errors.at(-1) < 200, `worst error ${errors.at(-1).toFixed(0)}m`);
});

test('snapping pulls the bus back onto the road', () => {
  const { pings } = drive({ from: 0, to: SHAPE.length });
  const matched = matchVehicle(pings, SHAPE);
  // Every snapped position is on the shape by construction; what matters is
  // that it moved the fix by about the size of the error, not further.
  const moves = matched.map((m) => m.offset).filter((x) => x != null);
  assert.ok(Math.max(...moves) < 220);
});

test('direction of travel is recovered, both ways', () => {
  const out = matchVehicle(drive({ from: 0, to: SHAPE.length }).pings, SHAPE);
  const back = matchVehicle(drive({ from: SHAPE.length, to: 0, seed: 11 }).pings, SHAPE);

  const dirs = (m) => new Set(m.filter((x) => x.onRoute).map((x) => x.dir));
  assert.deepEqual([...dirs(out)], [1]);
  assert.deepEqual([...dirs(back)], [-1]);
});

test('two buses passing on the same stretch keep their own directions', () => {
  const east = drive({ from: 8000, to: 14000, seed: 3 });
  const west = drive({ from: 14000, to: 8000, seed: 4 });
  const a = matchVehicle(east.pings, SHAPE);
  const b = matchVehicle(west.pings, SHAPE);
  assert.ok(a.every((m) => m.dir === 1));
  assert.ok(b.every((m) => m.dir === -1));
});

test('a single wild fix is bridged rather than ending the journey', () => {
  const { pings } = drive({ from: 0, to: SHAPE.length });
  const victim = Math.floor(pings.length / 2);
  const clean = splitRuns(matchVehicle(pings, SHAPE));
  assert.equal(clean.length, 1);

  // Throw one fix 600m north — far enough that it cannot be on the route.
  const damaged = pings.map((p, i) =>
    i === victim ? { ...p, lat: p.lat + 600 / 111_320 } : p,
  );
  const matched = matchVehicle(damaged, SHAPE);
  assert.equal(matched[victim].bridged, true, 'the bad fix should be bridged');
  assert.equal(splitRuns(matched).length, 1, 'one bad fix must not split the journey');
});

test('a real departure from the route is not bridged over', () => {
  const { pings } = drive({ from: 0, to: SHAPE.length });
  const start = Math.floor(pings.length / 2);
  // Ten minutes away from the road: a diversion or a dead-run, not a blip.
  const damaged = pings.map((p, i) =>
    i >= start && i < start + 20 ? { ...p, lat: p.lat + 2500 / 111_320 } : p,
  );
  const matched = matchVehicle(damaged, SHAPE);
  assert.ok(matched.slice(start, start + 20).every((m) => !m.onRoute));
  assert.equal(splitRuns(matched).length, 2, 'the journey is broken either side of it');
});

test('a bus that turns round is split into two runs', () => {
  const out = drive({ from: 0, to: SHAPE.length, seed: 5 });
  const lastT = out.pings.at(-1).t;
  const back = drive({ from: SHAPE.length, to: 0, startT: lastT + 60, seed: 6 });
  const runs = splitRuns(matchVehicle([...out.pings, ...back.pings], SHAPE));

  assert.equal(runs.length, 2);
  assert.equal(runs[0].dir, 1);
  assert.equal(runs[1].dir, -1);
});

test('standing at a stop does not invent a change of direction', () => {
  const noise = noiseFn(21);
  const held = [];
  const [lon, lat] = pointAtDistance(SHAPE, 12000);
  for (let t = 0; t < 300; t += 30) {
    held.push({
      t,
      lon: lon + noise(25) / (111_320 * SHAPE.lonScale),
      lat: lat + noise(25) / 111_320,
    });
  }
  const moving = drive({ from: 12000, to: 18000, startT: 300, seed: 9 });
  const runs = splitRuns(matchVehicle([...held, ...moving.pings], SHAPE));
  assert.equal(runs.length, 1, 'the stand and the departure are one journey');
});

test('a long silence starts a fresh journey rather than inventing the middle', () => {
  const morning = drive({ from: 0, to: 6000, seed: 13 });
  const afternoon = drive({ from: 0, to: 6000, startT: 20_000, seed: 14 });
  const runs = splitRuns(matchVehicle([...morning.pings, ...afternoon.pings], SHAPE));
  assert.equal(runs.length, 2);
});
