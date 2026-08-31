import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildShape, pointAtDistance, haversine } from '../src/replay/geo.js';
import {
  vehicleStateAt,
  trailFor,
  fleetStateAt,
  runAt,
  OFF_ROUTE,
  ABSENT_GAP_S,
} from '../src/replay/position.js';

const replay = JSON.parse(readFileSync('public/replays/wave-99-2026-08-28.json', 'utf8'));
const shape = buildShape(replay.route.coordinates);

/** A bus driving a straight-ish stretch, sampled every 30s. */
function vehicle({ samples, runs }) {
  const cols = { t: [], s: [], dir: [], lon: [], lat: [] };
  for (const [t, s, dir] of samples) {
    const [lon, lat] = s === OFF_ROUTE ? [0.46, 50.87] : pointAtDistance(shape, s);
    cols.t.push(t);
    cols.s.push(s);
    cols.dir.push(dir);
    cols.lon.push(lon);
    cols.lat.push(lat);
  }
  return { id: 'TEST:1', ref: '1', operator: 'TEST', samples: cols, runs: runs ?? [] };
}

test('between two samples the bus is on the road, not on the straight line', () => {
  // Pick a stretch with a real bend in it and check the midpoint sits on the
  // shape rather than cutting the corner.
  const bend = 21_000;
  const v = vehicle({ samples: [[0, bend, 1], [30, bend + 300, 1]] });
  const mid = vehicleStateAt(v, shape, 15);

  const onRoad = pointAtDistance(shape, bend + 150);
  assert.ok(haversine([mid.lon, mid.lat], onRoad) < 1, 'midpoint should be the road midpoint');

  const a = pointAtDistance(shape, bend);
  const b = pointAtDistance(shape, bend + 300);
  const chord = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  assert.ok(
    haversine([mid.lon, mid.lat], chord) > 0.5,
    'and should differ from a straight line between the fixes',
  );
});

test('a bus is absent before its first and after its last sample', () => {
  const v = vehicle({ samples: [[100, 0, 1], [130, 300, 1]] });
  assert.equal(vehicleStateAt(v, shape, 99), null);
  assert.equal(vehicleStateAt(v, shape, 131), null);
  assert.ok(vehicleStateAt(v, shape, 100));
  assert.ok(vehicleStateAt(v, shape, 130));
});

test('a bus is not slid across a long silence', () => {
  const v = vehicle({ samples: [[0, 0, 1], [ABSENT_GAP_S + 60, 9000, 1]] });
  assert.equal(vehicleStateAt(v, shape, 300), null, 'nothing is known about the middle');
  assert.ok(vehicleStateAt(v, shape, 0), 'but the endpoints are still known');
  assert.equal(vehicleStateAt(v, shape, 60).s, 0, 'the last fix is held briefly, not moved');
});

test('an unplaceable fix is shown where it was reported, flagged off-route', () => {
  const v = vehicle({ samples: [[0, OFF_ROUTE, 0], [30, OFF_ROUTE, 0]] });
  const state = vehicleStateAt(v, shape, 15);
  assert.equal(state.status, 'off-route');
  assert.equal(state.s, null);
  assert.ok(Math.abs(state.lat - 50.87) < 1e-9);
});

test('speed and heading come from movement along the route', () => {
  const v = vehicle({ samples: [[0, 10_000, 1], [30, 10_300, 1]] });
  const forward = vehicleStateAt(v, shape, 15);
  assert.ok(Math.abs(forward.speedMps - 10) < 0.01);

  const w = vehicle({ samples: [[0, 10_300, -1], [30, 10_000, -1]] });
  const backward = vehicleStateAt(w, shape, 15);
  assert.ok(Math.abs(backward.speedMps - 10) < 0.01, 'speed is a magnitude');
  const apart = Math.abs(forward.bearing - backward.bearing) % 360;
  assert.ok(Math.abs(apart - 180) < 2, 'the two directions face opposite ways');
});

test('the trail follows the road and ends under the bus', () => {
  const v = vehicle({ samples: [[0, 20_000, 1], [30, 20_300, 1], [60, 20_600, 1]] });
  const trail = trailFor(v, shape, 60, 900);
  assert.ok(trail.length > 3, 'the trail picks up the road vertices in between');
  const head = vehicleStateAt(v, shape, 60);
  assert.ok(haversine(trail.at(-1), [head.lon, head.lat]) < 1);
  for (const point of trail) {
    // Every trail point should be on the route within a metre.
    assert.ok(point.length === 2 && Number.isFinite(point[0]));
  }
});

test('the trail only covers the window asked for', () => {
  const samples = [];
  for (let t = 0; t <= 1800; t += 30) samples.push([t, 5000 + t * 8, 1]);
  const v = vehicle({ samples });
  const short = trailFor(v, shape, 1800, 300);
  const long = trailFor(v, shape, 1800, 900);
  assert.ok(long.length > short.length);
});

test('the run gives the bus its destination', () => {
  const v = vehicle({
    samples: [[0, 0, 1], [30, 300, 1]],
    runs: [{ from: 0, to: 30, dir: 1, destination: 'Hastings', journeyRef: 'j1' }],
  });
  assert.equal(runAt(v, 15).destination, 'Hastings');
  assert.equal(runAt(v, 900), null);
  assert.equal(vehicleStateAt(v, shape, 15).run.destination, 'Hastings');
});

test('the fleet summary counts what is moving in the demo replay', () => {
  const midMorning = fleetStateAt(replay, shape, 10 * 3600);
  assert.equal(midMorning.tracked, replay.vehicles.length);
  assert.ok(midMorning.inService > 0, 'buses are running at 10am');
  assert.equal(midMorning.active.length, midMorning.inService + midMorning.offRoute);

  const smallHours = fleetStateAt(replay, shape, 3 * 3600);
  assert.equal(smallHours.active.length, 0, 'nothing runs at 3am');
});

test('every bus in the demo replay stays on its route while in service', () => {
  for (let t = replay.window[0]; t < replay.window[1]; t += 137) {
    for (const { state } of fleetStateAt(replay, shape, t).active) {
      if (state.status !== 'in-service') continue;
      assert.ok(state.s >= 0 && state.s <= shape.length, `s=${state.s} off the shape at t=${t}`);
      assert.ok(state.speedMps < 30, `${state.speedMps.toFixed(1)} m/s is not a bus`);
    }
  }
});
