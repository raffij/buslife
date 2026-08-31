/**
 * Reading a replay: where every bus was at a given moment.
 *
 * Samples arrive every ~30 seconds, so playback has to fill in between them.
 * The trick that makes it look like buses rather than drifting dots is that
 * interpolation happens in `s` — metres along the route — and the position is
 * read back off the road afterwards. A bus rounding the bend at Glyne Gap
 * follows the bend, because there is nowhere else for it to be.
 *
 * Samples the matcher could not place on the route (`s === OFF_ROUTE`) fall
 * back to interpolating the raw fixes, which is the honest thing to do: we do
 * not know what road it was on.
 */

import { pointAtDistance, bearingAtDistance, sliceShape } from './geo.js';

/** Sentinel for a sample the matcher could not put on the route. */
export const OFF_ROUTE = -1;

/**
 * Longer than this between two samples and we stop drawing the bus, rather
 * than sliding it smoothly across a gap we know nothing about.
 */
export const ABSENT_GAP_S = 900;

/**
 * How long a bus keeps showing at its last known position before we admit we
 * have lost it. Live bus maps do the same: a fix is good for a minute or two,
 * not forever.
 */
export const STALE_HOLD_S = 120;

/** Index of the last sample at or before `t`. */
function lastAtOrBefore(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The journey a vehicle was working at `t`, if any. */
export function runAt(vehicle, t) {
  return vehicle.runs.find((r) => t >= r.from && t <= r.to) ?? null;
}

/**
 * A vehicle's state at time `t`, or null if it was not being tracked then.
 *
 * @returns {{lon, lat, s, dir, status, speedMps, bearing, run}|null}
 */
export function vehicleStateAt(vehicle, shape, t) {
  const { t: times, s: alongs, dir: dirs, lon: lons, lat: lats } = vehicle.samples;
  if (t < times[0] || t > times[times.length - 1]) return null;

  const i = lastAtOrBefore(times, t);
  let j = Math.min(i + 1, times.length - 1);
  const t0 = times[i];

  // Nothing is known between two distant fixes, so rather than sliding the
  // bus across the gap we hold it briefly at the last one and then drop it.
  if (times[j] - t0 > ABSENT_GAP_S) {
    if (t - t0 > STALE_HOLD_S) return null;
    j = i;
  }

  const t1 = times[j];
  const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const dir = dirs[i] || dirs[j] || 0;
  const run = runAt(vehicle, t);

  if (alongs[i] !== OFF_ROUTE && alongs[j] !== OFF_ROUTE) {
    const s = alongs[i] + (alongs[j] - alongs[i]) * frac;
    const [lon, lat] = pointAtDistance(shape, s);
    const speedMps = t1 > t0 ? Math.abs(alongs[j] - alongs[i]) / (t1 - t0) : 0;
    // The road's bearing points one way; a bus driving the other way faces
    // the opposite direction along it.
    const bearing = (bearingAtDistance(shape, s) + (dir < 0 ? 180 : 0)) % 360;
    return { lon, lat, s, dir, status: 'in-service', speedMps, bearing, run };
  }

  return {
    lon: lons[i] + (lons[j] - lons[i]) * frac,
    lat: lats[i] + (lats[j] - lats[i]) * frac,
    s: null,
    dir,
    status: 'off-route',
    speedMps: 0,
    bearing: 0,
    run,
  };
}

/**
 * The path a vehicle covered over the last `seconds`, following the road
 * where we know it and the raw fixes where we do not.
 */
export function trailFor(vehicle, shape, t, seconds) {
  const { t: times, s: alongs, lon: lons, lat: lats } = vehicle.samples;
  const from = t - seconds;
  if (t < times[0]) return [];

  const head = vehicleStateAt(vehicle, shape, t);
  if (!head) return [];

  const path = [];
  const first = lastAtOrBefore(times, from);
  const last = lastAtOrBefore(times, t);

  for (let k = first; k < last; k++) {
    if (times[k + 1] - times[k] > ABSENT_GAP_S) {
      path.length = 0; // a silence: the trail restarts on the far side
      continue;
    }
    if (alongs[k] !== OFF_ROUTE && alongs[k + 1] !== OFF_ROUTE) {
      path.push(...sliceShape(shape, alongs[k], alongs[k + 1]));
    } else {
      path.push([lons[k], lats[k]], [lons[k + 1], lats[k + 1]]);
    }
  }
  path.push([head.lon, head.lat]);
  return path.length >= 2 ? path : [];
}

/** The raw GPS fixes behind a trail — what BODS actually reported. */
export function rawFixesFor(vehicle, t, seconds) {
  const { t: times, lon: lons, lat: lats } = vehicle.samples;
  const out = [];
  for (let k = lastAtOrBefore(times, t - seconds); k <= lastAtOrBefore(times, t); k++) {
    if (times[k] < t - seconds || times[k] > t) continue;
    out.push([lons[k], lats[k]]);
  }
  return out;
}

/**
 * What the fleet was doing at `t` — the counts along the top of the player.
 * "Tracked" is every vehicle that worked the route at any point in the day,
 * which is a bigger number than the ones moving right now.
 */
export function fleetStateAt(replay, shape, t) {
  const active = [];
  let inService = 0;
  let offRoute = 0;
  for (const vehicle of replay.vehicles) {
    const state = vehicleStateAt(vehicle, shape, t);
    if (!state) continue;
    active.push({ vehicle, state });
    if (state.status === 'in-service') inService++;
    else offRoute++;
  }
  return { active, inService, offRoute, tracked: replay.vehicles.length };
}
