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
tools/record.mjs               poll the live BODS feed every 30s, append to data/snapshots/
tools/fetch-archive.mjs        backfill one past day from a third-party archive instead
tools/fetch-archive-range.mjs  the above, for a date range × one or more routes
tools/compile.mjs              map-match a day's sightings onto the route, write public/replays/
src/                           the web player (React + deck.gl + MapLibre)
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

## Backfill a past day from the archive

`record.mjs` can only ever watch today — BODS itself keeps no history, which
is the whole reason it has to be polled live. [Open Innovations' BODS
archive](https://data.datalibrary.uk/transport/BODS-ARCHIVE/) has already
been doing that polling since 2025-06-18 and publishes the result as one zip
per UTC day, so any day since then can be pulled in one shot instead of
waited for:

```
npm run fetch-archive -- --date 2026-08-30 --line 99
npm run compile -- --date 2026-08-30
```

A day-bundle is the *entire country's* traffic for that day (easily a few
hundred MB), so `fetch-archive.mjs` streams through it and keeps only
sightings matching `--line` (and `--operator`, if you pass one) — nothing
about the rest of the country's buses is written to disk. The downloaded
bundle itself is cached under `data/archive-cache/` (gitignored) so re-running
with a different `--line` doesn't re-download it.

`--date` is a **local** date (`Europe/London` by default, `--tz` to change
it) — in British Summer Time that spans two of the archive's UTC-dated
bundles, which `fetch-archive.mjs` works out and fetches both of
automatically; getting this wrong would silently drop the first hour of a
summer day's service rather than error.

Its output is the same shape and location `record.mjs` writes to
(`data/snapshots/<date>.ndjson`), so `compile.mjs` afterwards is identical
either way — the archive is a different way to fill that one file in, not a
separate pipeline.

### This runs automatically every day

[`.github/workflows/fetch-archive.yml`](.github/workflows/fetch-archive.yml)
does the above for "yesterday", for every route in `data/routes/`, on a
schedule — needing no API key (the archive is public) — and opens, validates,
and merges its own PR. Trigger it by hand (a specific date, a subset of
routes, or `force` to re-fetch one already backfilled) from the
[Actions tab](../../actions/workflows/fetch-archive.yml).

### Backfilling a whole range at once

For more than one day — filling in history from before this repo existed, or
after adding a new route — run the same tool directly over a range:

```
npm run fetch-archive-range -- --start 2026-08-01 --end 2026-08-07
npm run fetch-archive-range -- --start 2026-08-01 --end 2026-08-07 --routes wave-99,another-route
```

It skips any (date, route) pair already compiled — checked against
`public/replays/`, the one thing actually committed to the repo, not the
gitignored scratch space (`data/snapshots/`, `data/archive-cache/`) fetching
and compiling use along the way, which is empty again on every fresh
checkout (see
[decision 0001](docs/decisions/0001-backfill-from-the-open-innovations-archive.md)).
It keeps going past an individual failure rather than aborting the whole
range over one bad day, and prints a summary table at the end.

**A day-bundle is the whole country's traffic** (easily a few hundred MB), so
a wide range means a genuinely long, bandwidth-heavy run. Add `--check` (or
`--dry-run`) to see what a range would do — which dates/routes are already
covered and which would need fetching — without downloading or writing
anything, so you know what you're about to commit to before you commit to it:

```
npm run fetch-archive-range -- --start 2026-08-01 --end 2026-08-31 --check
```

[`.github/workflows/fetch-archive-range.yml`](.github/workflows/fetch-archive-range.yml)
runs the same thing from a `workflow_dispatch` trigger (`start_date`,
`end_date`, optional `routes`/`operator`/`force`/`dry_run`) from the
[Actions tab](../../actions/workflows/fetch-archive-range.yml) — `dry_run`
prints its report to the run's own summary page — and opens, validates, and
merges its own PR the same way the daily job does — see
[decision 0002](docs/decisions/0002-automate-the-daily-backfill.md) for why
that can't just lean on `ci.yml`'s existing checks, and
[decision 0003](docs/decisions/0003-generalise-the-backfill-to-a-range-and-multiple-routes.md)
for the range/multi-route generalisation itself.

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
npm test      # geometry, map-matcher, SIRI-VM parser, replay clock, archive, routes — 58 tests
npm run build # static build, output in dist/
```

`src/replay/` (geometry, timing, interpolation) and `tools/lib/` (map-matching,
SIRI-VM parsing) are plain ESM with no framework dependency, so the same code
map-matches offline in `compile.mjs` and interpolates live in the browser.

## Data sources

- **[Bus Open Data Service](https://www.bus-data.dft.gov.uk/)** — the SIRI-VM
  vehicle-location feed. Free API key, no rate limit stated for the datafeed
  endpoint at a sensible polling interval.
- **[Open Innovations' BODS archive](https://data.datalibrary.uk/transport/BODS-ARCHIVE/)**
  — a third-party archive of the same SIRI-VM feed, polled and published
  independently of this project since 2025-06-18 ([source](https://github.com/open-innovations/bods-archive)).
  No key required; be a good citizen of someone else's free infrastructure —
  `fetch-archive.mjs` caches what it downloads for exactly that reason.
- **[CARTO](https://carto.com/basemaps) / [OpenStreetMap](https://www.openstreetmap.org/copyright)**
  — the dark basemap tiles, no key required.

## Attribution

Basemap © CARTO, map data © OpenStreetMap contributors. Bus location data ©
operators and Bus Open Data Service, published under the
[Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
