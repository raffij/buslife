/**
 * Geometry helpers shared by the offline map-matcher (tools/) and the
 * in-browser player (src/). Everything here is plain ESM with no
 * dependencies so both runtimes can import the same code.
 *
 * Distances are metres. Positions are [lon, lat] to match GeoJSON.
 */

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Great-circle distance in metres between two [lon, lat] points. */
export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * A route shape: the ordered coordinates of the road the buses drive, plus
 * the cumulative distance to each vertex. Positions along the route are
 * expressed as a single number `s` — metres travelled from the first
 * coordinate — which is what makes interpolation follow the road instead of
 * cutting across it.
 */
export function buildShape(coords) {
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error(`a shape needs at least 2 coordinates, got ${coords?.length ?? 0}`);
  }
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + haversine(coords[i - 1], coords[i]);
  }
  // Scale factor for the equirectangular approximation used when projecting
  // points onto segments. Over a route tens of km long the error is
  // centimetres, and it keeps the hot loop free of trig.
  const midLat = coords[Math.floor(coords.length / 2)][1];
  return { coords, cum, length: cum[cum.length - 1], lonScale: Math.cos(midLat * DEG) };
}

/** Index of the last vertex at or before distance `s`. */
function vertexBefore(shape, s) {
  const { cum } = shape;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, cum.length - 2);
}

/** The [lon, lat] sitting `s` metres along the shape, clamped to its ends. */
export function pointAtDistance(shape, s) {
  const { coords, cum, length } = shape;
  if (s <= 0) return [coords[0][0], coords[0][1]];
  if (s >= length) return [coords[coords.length - 1][0], coords[coords.length - 1][1]];
  const i = vertexBefore(shape, s);
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 0 ? (s - cum[i]) / segLen : 0;
  const a = coords[i];
  const b = coords[i + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Compass bearing (degrees clockwise from north) of the road at distance `s`. */
export function bearingAtDistance(shape, s) {
  const { coords, length } = shape;
  const eps = Math.min(25, length / 2);
  const a = pointAtDistance(shape, Math.max(0, Math.min(length - eps, s - eps / 2)));
  const b = pointAtDistance(shape, Math.max(eps, Math.min(length, s + eps / 2)));
  const dx = (b[0] - a[0]) * shape.lonScale;
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dx, dy) / DEG + 360) % 360;
}

/**
 * Project a point onto the shape, returning how far along the route it lands
 * and how far off the road it was. Searching can be restricted to a window of
 * the route (`minS`/`maxS`), which is how the matcher stops a bus on the
 * seafront from snapping to the same road on its return leg.
 */
export function projectToShape(shape, point, minS = 0, maxS = Infinity) {
  const { coords, cum, lonScale } = shape;
  const from = Math.max(0, vertexBefore(shape, Math.max(0, minS)));
  const to = Math.min(coords.length - 2, vertexBefore(shape, Math.min(shape.length, maxS)));
  let best = { s: 0, offset: Infinity };
  for (let i = from; i <= to; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const ax = (point[0] - a[0]) * lonScale;
    const ay = point[1] - a[1];
    const bx = (b[0] - a[0]) * lonScale;
    const by = b[1] - a[1];
    const segSq = bx * bx + by * by;
    const t = segSq > 0 ? Math.max(0, Math.min(1, (ax * bx + ay * by) / segSq)) : 0;
    const s = cum[i] + t * (cum[i + 1] - cum[i]);
    if (s < minS || s > maxS) continue;
    const offset = haversine(point, pointAtDistance(shape, s));
    if (offset < best.offset) best = { s, offset };
  }
  return best;
}

/**
 * The coordinates of the road between two distances along it — used to draw
 * the trail a bus has just covered so the tail hugs the route.
 */
export function sliceShape(shape, s0, s1) {
  const { coords, cum, length } = shape;
  const lo = Math.max(0, Math.min(s0, s1));
  const hi = Math.min(length, Math.max(s0, s1));
  if (hi - lo < 1) return [];
  const out = [pointAtDistance(shape, lo)];
  for (let i = vertexBefore(shape, lo) + 1; i < coords.length && cum[i] < hi; i++) {
    out.push([coords[i][0], coords[i][1]]);
  }
  out.push(pointAtDistance(shape, hi));
  return out;
}

/**
 * Project a point onto a single segment `i -> i+1` of the shape. This is the
 * primitive the matcher scans with, so it does no allocation and returns the
 * squared planar offset — cheap to compare, converted to metres only for the
 * few candidates that survive.
 */
export function projectToSegment(shape, point, i) {
  const { coords, cum, lonScale } = shape;
  const a = coords[i];
  const b = coords[i + 1];
  const ax = (point[0] - a[0]) * lonScale;
  const ay = point[1] - a[1];
  const bx = (b[0] - a[0]) * lonScale;
  const by = b[1] - a[1];
  const segSq = bx * bx + by * by;
  const t = segSq > 0 ? Math.max(0, Math.min(1, (ax * bx + ay * by) / segSq)) : 0;
  const dx = ax - bx * t;
  const dy = ay - by * t;
  return { s: cum[i] + t * (cum[i + 1] - cum[i]), offsetSq: dx * dx + dy * dy };
}
