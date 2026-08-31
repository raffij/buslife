import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine,
  buildShape,
  pointAtDistance,
  bearingAtDistance,
  projectToShape,
  sliceShape,
} from '../src/replay/geo.js';

// Bexhill station to Hastings station, roughly 7.5 km apart as the crow flies.
const BEXHILL = [0.4719, 50.8409];
const HASTINGS = [0.5731, 50.8578];

test('haversine measures a known distance', () => {
  const d = haversine(BEXHILL, HASTINGS);
  assert.ok(d > 7000 && d < 8000, `expected ~7.5km, got ${Math.round(d)}m`);
  assert.equal(haversine(BEXHILL, BEXHILL), 0);
});

test('a shape accumulates its segment lengths', () => {
  const shape = buildShape([[0, 50], [0, 50.01], [0, 50.02]]);
  assert.equal(shape.cum[0], 0);
  assert.ok(Math.abs(shape.length - 2 * haversine([0, 50], [0, 50.01])) < 0.001);
});

test('a shape needs at least two points', () => {
  assert.throws(() => buildShape([[0, 50]]), /at least 2/);
});

test('walking a distance along a shape lands back where it started', () => {
  const shape = buildShape([[0.40, 50.84], [0.45, 50.85], [0.50, 50.845], [0.55, 50.86]]);
  for (const frac of [0, 0.13, 0.5, 0.77, 1]) {
    const s = shape.length * frac;
    const point = pointAtDistance(shape, s);
    const back = projectToShape(shape, point);
    assert.ok(Math.abs(back.s - s) < 1, `round-tripped ${s} to ${back.s}`);
    assert.ok(back.offset < 1);
  }
});

test('distances past either end clamp to the terminals', () => {
  const shape = buildShape([[0.40, 50.84], [0.45, 50.85]]);
  assert.deepEqual(pointAtDistance(shape, -500), [0.40, 50.84]);
  assert.deepEqual(pointAtDistance(shape, shape.length + 500), [0.45, 50.85]);
});

test('a point beside the road reports how far off it is', () => {
  const shape = buildShape([[0.40, 50.84], [0.50, 50.84]]);
  const halfway = pointAtDistance(shape, shape.length / 2);
  const beside = [halfway[0], halfway[1] + 0.0009]; // ~100m north
  const hit = projectToShape(shape, beside);
  assert.ok(Math.abs(hit.offset - 100) < 10, `expected ~100m off, got ${hit.offset}`);
  assert.ok(Math.abs(hit.s - shape.length / 2) < 5);
});

test('the search window keeps a point off the wrong pass of a doubling-back route', () => {
  // Out along a road and back on the same line: every point has two answers.
  const shape = buildShape([[0.40, 50.84], [0.50, 50.84], [0.40, 50.84]]);
  const target = [0.45, 50.84];
  const outward = projectToShape(shape, target, 0, shape.length / 2);
  const back = projectToShape(shape, target, shape.length / 2, shape.length);
  assert.ok(outward.s < shape.length / 2);
  assert.ok(back.s > shape.length / 2);
  assert.ok(outward.offset < 1 && back.offset < 1);
});

test('a slice of the shape follows the road between two distances', () => {
  const shape = buildShape([[0.40, 50.84], [0.45, 50.86], [0.50, 50.84]]);
  const slice = sliceShape(shape, 0, shape.length);
  assert.equal(slice.length, 3, 'a full slice keeps the intermediate vertex');
  assert.ok(sliceShape(shape, 100, 100.5).length === 0, 'a zero-length slice is empty');
  const mid = sliceShape(shape, shape.length * 0.4, shape.length * 0.6);
  assert.ok(mid.length >= 2);
});

test('bearing follows the direction of travel', () => {
  const north = buildShape([[0, 50], [0, 50.05]]);
  assert.ok(Math.abs(bearingAtDistance(north, north.length / 2) - 0) < 2);
  const east = buildShape([[0, 50], [0.05, 50]]);
  assert.ok(Math.abs(bearingAtDistance(east, east.length / 2) - 90) < 2);
});
