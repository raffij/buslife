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

/** Read the text of the first `<tag>` in `xml`, namespace prefix and all. */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? decode(m[1].trim()) : null;
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
 */
export function parseSiriVm(xml) {
  const responseAt = tag(xml, 'ResponseTimestamp');
  const out = [];

  ACTIVITY.lastIndex = 0;
  let match;
  while ((match = ACTIVITY.exec(xml)) !== null) {
    const block = match[1];
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
      line: tag(block, 'PublishedLineName') ?? tag(block, 'LineRef'),
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
  return { responseAt, records: out };
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
