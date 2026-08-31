/**
 * A reader for the SIRI-VM documents the Bus Open Data Service serves from
 * /api/v1/datafeed/.
 *
 * The payload is one flat repetition of <VehicleActivity> elements with no
 * mixed content and no attributes we care about, so a scanner over the few
 * tags we read is enough and keeps the recorder dependency-free. Anything
 * unrecognised is ignored rather than throwing: a national feed always has
 * some operator sending a field we have not seen.
 */

const ACTIVITY = /<VehicleActivity>([\s\S]*?)<\/VehicleActivity>/g;

/**
 * The per-tag matcher, built once per tag name and reused.
 *
 * This cache is the difference between compiling a regex and reusing one, and
 * on a national feed that is the whole ballgame: a BODS poll carries ~20k
 * vehicles and we read ~13 fields from each, so building these inline cost
 * ~260k regex compilations per document — the single most expensive thing the
 * archive backfill did. There are only ever a dozen or so distinct names, all
 * of them literals in this file, so the cache cannot grow unboundedly.
 */
const MATCHERS = new Map();
function matcher(name) {
  let re = MATCHERS.get(name);
  if (!re) {
    re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`);
    MATCHERS.set(name, re);
  }
  return re;
}

/** Read the text of the first `<tag>` in `xml`, namespace prefix and all. */
function tag(xml, name) {
  const m = xml.match(matcher(name));
  return m ? decode(m[1].trim()) : null;
}

/**
 * The line a `<VehicleActivity>` block is running, by the same rule
 * `parseSiriVm` records it: PublishedLineName is what an operator shows the
 * public, LineRef the internal identifier, and only the former is worth
 * matching a user's `--line` against when both exist.
 */
function lineOf(block) {
  return tag(block, 'PublishedLineName') ?? tag(block, 'LineRef');
}

function decode(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (whole, code) => {
    switch (code) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return String.fromCharCode(Number(code.slice(1)));
    }
  });
}

function num(xml, name) {
  const raw = tag(xml, name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a SIRI-VM document into one record per vehicle sighting.
 *
 * `t` is a unix timestamp in seconds. RecordedAtTime is the moment the
 * vehicle reported, which is what we want — the response timestamp only says
 * when BODS answered, and the two can be minutes apart for a late-reporting
 * operator.
 *
 * Pass `{ line }` to keep only the vehicles running that line. This is not
 * the same as filtering the result afterwards, and the difference matters:
 * the archive backfill wants ~10 buses out of a document carrying the whole
 * country's ~20k, and deciding on the line first means the other 99.95% cost
 * two tag reads instead of thirteen plus an object. On a real day-bundle that
 * is the difference between ~20 minutes of parsing and well under one.
 * Callers watching the live feed (record.mjs) want every bus and pass
 * nothing, which behaves exactly as before.
 */
export function parseSiriVm(xml, { line = null } = {}) {
  const responseAt = tag(xml, 'ResponseTimestamp');
  const out = [];
  // Every `<VehicleActivity>` the document held, whether or not it survived
  // the line filter. `records.length` can no longer answer "did this document
  // contain buses at all?" once filtering happens inside the parse, and that
  // is exactly the question the backfill needs to tell "the archive has no
  // data for this day" apart from "your --line is wrong".
  let scanned = 0;

  ACTIVITY.lastIndex = 0;
  let match;
  while ((match = ACTIVITY.exec(xml)) !== null) {
    const block = match[1];
    scanned++;

    if (line !== null) {
      // A value that appears nowhere in the block cannot be the block's line,
      // so this rejects almost everything without running a regex at all. It
      // is only a pre-filter — "99" also matches a Bearing of 99 or vehicle
      // 1990 — so anything that survives still has its line read properly.
      if (!block.includes(line)) continue;
      if (lineOf(block) !== line) continue;
    }

    const lon = num(block, 'Longitude');
    const lat = num(block, 'Latitude');
    // A vehicle with no fix is not a position; drop it rather than plotting
    // it at null island.
    if (lon === null || lat === null) continue;
    if (lon === 0 && lat === 0) continue;

    const recordedAt = tag(block, 'RecordedAtTime') ?? responseAt;
    const t = recordedAt ? Math.round(Date.parse(recordedAt) / 1000) : null;
    if (!Number.isFinite(t)) continue;

    const direction = (tag(block, 'DirectionRef') ?? '').toLowerCase();
    out.push({
      t,
      lon,
      lat,
      vehicleRef: tag(block, 'VehicleRef'),
      operatorRef: tag(block, 'OperatorRef'),
      line: lineOf(block),
      journeyRef: tag(block, 'DatedVehicleJourneyRef'),
      originName: tag(block, 'OriginName'),
      destinationName: tag(block, 'DestinationName'),
      originDeparture: tag(block, 'OriginAimedDepartureTime'),
      bearing: num(block, 'Bearing'),
      // BODS carries the direction as a word, and operators disagree about
      // which word. Keep the raw value too so compile can fall back to it.
      directionRef: direction || null,
    });
  }
  return { responseAt, records: out, scanned };
}

/**
 * The identity we track a bus by across a day.
 *
 * VehicleRef is unique only within an operator — plenty of operators number
 * their fleet from 1 — so the key has to carry the operator as well.
 */
export function vehicleKey(record) {
  return `${record.operatorRef ?? 'unknown'}:${record.vehicleRef ?? 'unknown'}`;
}
