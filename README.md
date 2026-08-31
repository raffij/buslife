# buslife

Replay a day of real bus movements from [Bus Open Data Service](https://www.bus-data.dft.gov.uk/)
(BODS) location snapshots — a scrubbable map, sped up, with a live clock and
fleet tally. The example route is **The Wave (line 99)**, Stagecoach South
East's Eastbourne–Bexhill–Hastings coast service.

Deployed to GitHub Pages: **<https://raffij.github.io/buslife/>** (the synthetic
demo day, until a real one is compiled and pushed).

Inspired by [Neil Garratt's replay](https://x.com/NeilGarratt) of the 433's
meltdown in Croydon: BODS publishes where every bus in the country is *right
now* and nothing about where it's been, so seeing a day play back means
recording it yourself first.

## How it works

```
tools/record.mjs    poll the live BODS feed every 30s, append to data/snapshots/
tools/compile.mjs    map-match a day's sightings onto the route, write public/replays/
src/                 the web player (React + deck.gl + MapLibre)
```

Raw GPS pings are noisy — metres of jitter, the odd dropped fix, buses
sometimes reporting from the depot yard. `tools/compile.mjs` runs each
vehicle's day through a small [Viterbi](https://en.wikipedia.org/wiki/Viterbi_algorithm)
map-matcher (`tools/lib/match.mjs`) that snaps every ping onto the route
shape, so the player interpolates a position *along the road* rather than
between two noisy points in a field. Anything that can't be placed on the
route (a diversion, a dead-run) is kept and shown as off-route rather than
dropped.

## Try it now

The repo ships with a **synthetic demo day** (clearly labelled as such in the
app) so the player works before you've recorded anything real:

```
npm install
npm run dev
```

Open the printed URL. The demo day includes a staged disruption at 14:05 —
buses towards Hastings get turned back at Glyne Gap for an hour — so there's
something worth scrubbing to.

## Record a real day

1. Get a free API key from [the BODS signup page](https://data.bus-data.dft.gov.uk/account/signup/).
2. Record the live feed for line 99 (or any other line — see below):

   ```
   BODS_API_KEY=... npm run record -- --line 99 --bbox 0.26,50.75,0.61,50.88
   ```

   Leave it running for as much of the day as you want captured; `Ctrl-C` to
   stop, and re-running resumes rather than duplicating. It writes to
   `data/snapshots/<date>.ndjson`.

3. Compile the recording into a replay:

   ```
   npm run compile -- --date 2026-08-28
   ```

   This map-matches every vehicle, writes `public/replays/wave-99-<date>.json`,
   and rebuilds `public/replays/index.json` so the new day shows up in the
   player's date picker.

## Using a different route

`data/routes/wave-99.route.json` is the route shape the matcher snaps to — a
hand-traced approximation of the A259 coastal corridor (accurate to a few
hundred metres, flagged as such in the app). To follow a different line:

1. Get the real published geometry for that line (a GTFS `shapes.txt` from
   BODS' timetable data, or trace one by hand) and save it in the same shape
   as `wave-99.route.json` — `coordinates` as `[lon, lat]` pairs, plus
   `timingPoints` for named stops.
2. Point `record` and `compile` at it with `--route path/to/your.route.json`,
   and filter the feed to your line with `--line` / `--operator`.

## Development

```
npm test      # geometry, map-matcher, SIRI-VM parser, replay clock — 39 tests
npm run build # static build, output in dist/
```

`src/replay/` (geometry, timing, interpolation) and `tools/lib/` (map-matching,
SIRI-VM parsing) are plain ESM with no framework dependency, so the same code
map-matches offline in `compile.mjs` and interpolates live in the browser.

## Data sources

- **[Bus Open Data Service](https://www.bus-data.dft.gov.uk/)** — the SIRI-VM
  vehicle-location feed. Free API key, no rate limit stated for the datafeed
  endpoint at a sensible polling interval.
- **[CARTO](https://carto.com/basemaps) / [OpenStreetMap](https://www.openstreetmap.org/copyright)**
  — the dark basemap tiles, no key required.

## Attribution

Basemap © CARTO, map data © OpenStreetMap contributors. Bus location data ©
operators and Bus Open Data Service, published under the
[Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
