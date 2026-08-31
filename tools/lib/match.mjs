/**
 * Map-matching: turn a vehicle's jittery GPS pings into a position along the
 * route it is actually driving.
 *
 * Raw BODS pings are a location every ~30s with metres of noise, so playing
 * them back directly makes buses skate across fields and hop between
 * carriageways. Instead every ping is snapped to the route shape and reduced
 * to one number: `s`, the metres travelled from the route's first coordinate.
 * The player then interpolates `s` and reads the position back off the road,
 * so a bus can only ever be somewhere the route goes.
 *
 * Both directions share one shape: outbound runs s: 0 -> length, inbound runs
 * s: length -> 0. Direction is part of the matcher's state, which is what
 * separates a bus heading for Hastings from one on the same stretch of the
 * A259 heading the other way.
 *
 * The choice of snap is a Viterbi pass over candidate projections, in the
 * style of Newson & Krumm (2009): each ping proposes a few plausible points
 * on the road, and the cheapest consistent path through them wins. Emission
 * cost is how far off the road a candidate sits; transition cost is how badly
 * the implied travel along the road disagrees with the straight-line distance
 * the bus actually covered.
 */

import { haversine, projectToSegment, pointAtDistance } from '../../src/replay/geo.js';

export const DEFAULTS = {
  /** A ping further than this from the road is treated as off-route. */
  maxOffsetM: 220,
  /** Buses do not exceed this; anything faster is a bad match, not a bus. */
  maxSpeedMps: 30,
  /** Spread of the GPS noise, in metres — scales the emission cost. */
  gpsSigmaM: 35,
  /** Scales the transition cost. Newson & Krumm's beta. */
  betaM: 45,
  /** Cost of changing direction away from a terminus. */
  reversalCost: 260,
  /** Within this distance of either end, turning round is cheap. */
  turnaroundZoneM: 700,
  /**
   * A turn at a terminus still costs something. Free would leave the matcher
   * indifferent between a bus that turned and one that never did, and it
   * would settle the tie arbitrarily.
   */
  turnaroundCost: 6,
  /**
   * Movement below this between two pings says nothing about which way the
   * bus is facing — it is a bus standing at a stop, and the wobble is noise.
   */
  minDirectionalMoveM: 30,
  /** A gap longer than this ends the run — the bus was out of contact. */
  maxGapS: 420,
  /** Candidate snaps closer together than this are treated as the same one. */
  candidateSpacingM: 400,
  /** Candidates considered per ping. */
  maxCandidates: 4,
  /**
   * A spell off-route no longer than this, with the bus on the same road
   * heading the same way either side, is a bad fix rather than a departure
   * from the route, and gets bridged.
   */
  bridgeMaxS: 150,
};

/**
 * Plausible snaps for one ping: the local minima of "distance from this point
 * to the road", so a route that doubles back offers both passes as options
 * and the Viterbi pass decides between them.
 */
function candidatesFor(shape, point, opts) {
  const { coords } = shape;
  const found = [];
  let prev = null;
  let falling = false;

  // One pass along the road, keeping each point where the distance to the bus
  // stops falling and starts rising again.
  for (let i = 0; i < coords.length - 1; i++) {
    const hit = projectToSegment(shape, point, i);
    if (prev && falling && hit.offsetSq > prev.offsetSq) found.push(prev);
    falling = !prev || hit.offsetSq <= prev.offsetSq;
    prev = hit;
  }
  if (prev && falling) found.push(prev);

  // Only now pay for the trig, and only for the handful that survived.
  const maxSq = opts.maxOffsetM * opts.maxOffsetM;
  const scored = [];
  for (const c of found) {
    // The planar offset is in degrees-of-latitude units; convert once.
    const offset = haversine(point, pointAtDistance(shape, c.s));
    if (offset * offset <= maxSq) scored.push({ s: c.s, offset });
  }

  scored.sort((a, b) => a.offset - b.offset);
  const kept = [];
  for (const c of scored) {
    if (kept.length >= opts.maxCandidates) break;
    if (kept.some((k) => Math.abs(k.s - c.s) < opts.candidateSpacingM)) continue;
    kept.push(c);
  }
  return kept;
}

/** Cost of a candidate being this far off the road. */
function emissionCost(offset, opts) {
  return (offset * offset) / (2 * opts.gpsSigmaM * opts.gpsSigmaM);
}

/**
 * Cost of moving between two snaps. A well-matched pair travels about as far
 * along the road as the bus travelled through the air; a mismatched pair
 * implies a leap up and down the route that no bus made.
 */
function transitionCost(from, to, crowM, dtS, shape, opts) {
  const alongM = to.s - from.s;
  const moved = Math.abs(alongM);
  if (moved > opts.maxSpeedMps * dtS + 150) return Infinity;

  // Only a decisive move fixes the direction. A bus standing at a stop drifts
  // a few metres either way in the noise, and reading a heading off that is
  // what shreds a day's driving into dozens of imaginary journeys.
  if (moved >= opts.minDirectionalMoveM && Math.sign(alongM) !== to.dir) return Infinity;

  let cost = Math.abs(moved - crowM) / opts.betaM;
  if (from.dir !== to.dir) {
    const nearEnd = Math.min(from.s, shape.length - from.s) < opts.turnaroundZoneM;
    cost += (nearEnd ? opts.turnaroundCost : opts.reversalCost) / opts.betaM;
  }
  return cost;
}

/**
 * Snap one vehicle's pings to the shape.
 *
 * @param {{t: number, lon: number, lat: number}[]} pings ordered by time
 * @param {object} shape from buildShape()
 * @returns {{t, lon, lat, s, dir, offset, onRoute}[]} one entry per input ping
 */
export function matchVehicle(pings, shape, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const out = [];
  let segment = [];

  const flush = () => {
    if (segment.length) out.push(...matchSegment(segment, shape, opts));
    segment = [];
  };

  for (const ping of pings) {
    const prev = segment[segment.length - 1];
    // A long silence means we cannot reason about travel between the two
    // pings, so the Viterbi chain restarts rather than inventing a path.
    if (prev && ping.t - prev.t > opts.maxGapS) flush();
    segment.push(ping);
  }
  flush();
  return bridgeOffRoute(out, shape, opts);
}

/**
 * Repair isolated off-route samples.
 *
 * One wild fix in the middle of an otherwise clean journey is a GPS error,
 * not a bus leaving the route — but taken at face value it ends the run and
 * starts a new one, so a day's driving comes back shredded into fragments.
 * Where the bus is on the road, going the same way, at a plausible speed
 * either side of the gap, the samples in between are placed along the road
 * between the two and flagged as bridged.
 */
function bridgeOffRoute(samples, shape, opts) {
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].onRoute) continue;
    let j = i;
    while (j < samples.length && !samples[j].onRoute) j++;

    const before = samples[i - 1];
    const after = samples[j];
    const dt = before && after ? after.t - before.t : Infinity;
    const ds = before && after ? after.s - before.s : 0;
    const bridgeable =
      before?.onRoute &&
      after?.onRoute &&
      before.dir === after.dir &&
      dt <= opts.bridgeMaxS &&
      Math.abs(ds) <= opts.maxSpeedMps * dt;

    if (bridgeable) {
      for (let k = i; k < j; k++) {
        const s = before.s + ds * ((samples[k].t - before.t) / dt);
        const at = pointAtDistance(shape, s);
        samples[k] = {
          ...samples[k],
          s,
          dir: before.dir,
          onRoute: true,
          bridged: true,
          snappedLon: at[0],
          snappedLat: at[1],
        };
      }
    }
    i = j - 1;
  }
  return samples;
}

function matchSegment(pings, shape, opts) {
  /** @type {{cands: object[], costs: number[], back: number[]}[]} */
  const trellis = [];

  for (let i = 0; i < pings.length; i++) {
    const p = pings[i];
    const point = [p.lon, p.lat];
    const snaps = candidatesFor(shape, point, opts);
    // Each snap can be reached heading either way along the route.
    const cands = [];
    for (const snap of snaps) {
      cands.push({ s: snap.s, offset: snap.offset, dir: 1 });
      cands.push({ s: snap.s, offset: snap.offset, dir: -1 });
    }

    if (!cands.length) {
      // Off-route: a depot dead-run, a diversion, or a bad fix. Break the
      // chain so the next on-route ping starts fresh instead of being dragged
      // towards wherever this one landed.
      trellis.push(null);
      continue;
    }

    const prev = trellis[i - 1];
    const costs = new Array(cands.length).fill(Infinity);
    const back = new Array(cands.length).fill(-1);

    for (let c = 0; c < cands.length; c++) {
      const emit = emissionCost(cands[c].offset, opts);
      if (!prev) {
        costs[c] = emit;
        continue;
      }
      const dtS = Math.max(1, p.t - pings[i - 1].t);
      const crowM = haversine([pings[i - 1].lon, pings[i - 1].lat], point);
      for (let q = 0; q < prev.cands.length; q++) {
        if (!Number.isFinite(prev.costs[q])) continue;
        const step = transitionCost(prev.cands[q], cands[c], crowM, dtS, shape, opts);
        const total = prev.costs[q] + step;
        if (total < costs[c]) {
          costs[c] = total;
          back[c] = q;
        }
      }
      if (!Number.isFinite(costs[c])) {
        // No legal way in from the previous ping — allow a restart, priced so
        // it only wins when every continuation is genuinely impossible.
        costs[c] = Math.min(...prev.costs.filter(Number.isFinite)) + opts.reversalCost / opts.betaM;
        back[c] = -1;
      }
      costs[c] += emit;
    }
    trellis.push({ cands, costs, back });
  }

  // Walk the cheapest path back through the trellis, then hand each ping the
  // snap that path chose for it.
  const chosen = new Array(pings.length).fill(null);
  let i = trellis.length - 1;
  while (i >= 0) {
    const node = trellis[i];
    if (!node) {
      i--;
      continue;
    }
    let best = 0;
    for (let c = 1; c < node.costs.length; c++) if (node.costs[c] < node.costs[best]) best = c;
    let cursor = best;
    let j = i;
    while (j >= 0 && cursor >= 0 && trellis[j]) {
      chosen[j] = trellis[j].cands[cursor];
      cursor = trellis[j].back[cursor];
      j--;
    }
    i = j;
  }

  return pings.map((p, idx) => {
    const pick = chosen[idx];
    if (!pick) {
      return { ...p, s: null, dir: 0, offset: null, onRoute: false };
    }
    const snapped = pointAtDistance(shape, pick.s);
    return {
      ...p,
      s: pick.s,
      dir: pick.dir,
      offset: pick.offset,
      onRoute: true,
      snappedLon: snapped[0],
      snappedLat: snapped[1],
    };
  });
}

/**
 * Split matched pings into runs — one continuous trip along the route in one
 * direction. A run ends at a long gap, a turnaround, or a spell off-route.
 * Runs are what the player treats as a journey, and what the summary counts.
 */
export function splitRuns(matched, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const runs = [];
  let current = null;

  const close = () => {
    if (current && current.samples.length >= 2) runs.push(current);
    current = null;
  };

  for (const m of matched) {
    if (!m.onRoute) {
      close();
      continue;
    }
    const last = current?.samples[current.samples.length - 1];
    if (!last || m.t - last.t > opts.maxGapS || m.dir !== current.dir) {
      close();
      current = { dir: m.dir, samples: [] };
    }
    current.samples.push(m);
  }
  close();
  return runs;
}
