# 0001. Backfill past days from Open Innovations' BODS archive

- **Date:** 2026-08-31
- **Status:** Accepted

## Context

BODS itself has no history — it only ever answers "where is every bus right
now" — so `record.mjs` can only ever capture today, one 30-second poll at a
time, starting from whenever it's launched. That's fine for a day you're
deliberately watching, but it means there was no way to get a day that had
already happened, including "yesterday" — the first thing a real user asked
for once the recorder existed.

[Open Innovations](https://open-innovations.org/) run a public archive at
data.datalibrary.uk that has been polling the same BODS SIRI-VM feed every
~30s since 2025-06-18 and publishing the result as one zip per UTC calendar
day, per format (`sirivm`, `gtfsrt`, `timetables`). Their own tooling
(https://github.com/open-innovations/bods-archive) is Python; this repo is
Node throughout, so backfilling meant either shelling out to their scripts or
writing a small Node equivalent.

## Decision

Add `tools/fetch-archive.mjs`, a Node script that downloads the day-bundle(s)
needed for a requested **local** date, filters to one line client-side
(streaming — never holding a whole day's national traffic in memory), and
appends the result to `data/snapshots/<date>.ndjson` in exactly the format
`record.mjs` already produces. `compile.mjs` afterwards is identical either
way; the archive is a different way to fill in that one file, not a parallel
pipeline.

Two things this had to get right that a naive port of their Python tool
wouldn't have surfaced:

- **The UTC/local mismatch.** The archive is bundled by UTC day; a
  `Europe/London` day in BST is not one. Backfilling "yesterday" naively
  against a single UTC-dated bundle would silently drop the first hour of a
  summer day's service — no error, just buses that never appear before
  01:00. `utcDaysForLocalDate()` (tested against both DST transition days,
  not just an ordinary BST/GMT day) works out which one or two UTC bundles a
  local day actually needs.
- **Client-side filtering.** The archive's `archive_downloader.py` (per-poll
  files) and `BulkDownloader.py` (day-bundles) both exist; day-bundles were
  chosen because one HTTP request beats ~2,880 rate-limited ones, but a
  bundle is the *entire country's* SIRI-VM traffic for a day — easily
  hundreds of MB. There's no server-side filter, so `fetch-archive.mjs`
  streams each document out of the zip, parses it, keeps only the requested
  line, and discards the rest immediately rather than writing a day's
  national data to disk to filter it afterward.

**Alternatives considered:**

- *Wrap/shell out to their existing Python `archive_downloader.py`.*
  Rejected: adds a Python + pipenv dependency to an otherwise all-Node repo
  for a few hundred lines of logic that port cleanly, and their downloader
  fetches one file per 30s snapshot rather than the single day-bundle, which
  is slower and against a stated 1req/s rate limit we'd rather not lean on
  for routine use.
- *Download the whole day-bundle to disk, unzip fully, then filter.* Rejected
  on memory/disk grounds — the point of filtering to one line is that the
  output should be small; there's no reason to materialise the other ~99% of
  the country's buses first.
- *Trust the bundle's internal structure (flat XML) without checking.*
  Rejected — the archive's own per-poll download step is a raw `curl -o
  file.zip` of BODS' response body, so nothing rules out day-bundle entries
  being one more zip layer (BODS' own per-poll zip, bundled unmodified)
  rather than XML directly. `xmlDocumentsInBundle()` handles either shape
  rather than assuming one, since neither is documented.

Added `fflate` (zero native deps, ZIP + XML-friendly) as the one new
dependency this needed — no ZIP support exists in Node core.

## Consequences

Any BODS-recorded line, on any day since 2025-06-18, can now be replayed
without having to have been watching it live. This does mean depending on
someone else's free, unofficial infrastructure with no SLA — `fetch-archive.mjs`
caches what it downloads specifically so a re-run (a different `--line`, a
retry after a failure) doesn't hit their server again for the same day.

## Diagram

No system-map impact — this adds a second way to populate one existing file
(`data/snapshots/<date>.ndjson`), not a new component in the data flow the
architecture would show.
