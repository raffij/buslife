# 0005. Keep the archive backfill in Node, and fix the algorithm instead

- **Date:** 2026-08-31
- **Status:** Accepted

## Context

[0004](0004-stream-large-archive-bundles-from-disk.md) stopped the archive
backfill from running out of heap on a multi-GB day-bundle, and it did. The
next run failed anyway — differently. Run 4 of `fetch-archive.yml`, on
`226ee86`, was **cancelled after 35 minutes**, not killed:

```
14:55:36  2026-08-29: downloading .../sirivm-20260829.zip
15:05:04  2026-08-29: downloaded            <- 9m28s, ~7 MB/s, network-bound
15:16:28  parsed  500 documents             <- includes ~5.5 min `unzip -Z1` listing
15:22:18  parsed 1000 documents             <- 350s / 500 docs = 1.4 docs/sec
15:28:05  parsed 1500 documents
15:30:30  ##[error]The operation was canceled.
```

A bundle holds ~2880 documents (one poll per ~30s) and a British Summer Time
local day straddles two of them, so at 1.4 docs/sec that is ~70 minutes of
parsing per route per day. A date range — the whole point of
[0003](0003-generalise-the-backfill-to-a-range-and-multiple-routes.md) — could
not finish inside the 6-hour job limit.

The obvious reading was that Node was the wrong tool and the fetch path wanted
a compiled language. Measured, that turned out to be wrong, and it was worth
finding out before committing to a rewrite. Benchmarking the parser against a
synthetic national document (20k vehicles, 17.7 MB, which is about what a BODS
poll carries):

| Variant | Per document | Per bundle |
| --- | --- | --- |
| As written | 413 ms | 19.8 min |
| Field regexes built once instead of per call | 269 ms | 12.9 min |
| Line matched before the record is built | 15 ms | 0.7 min |

Two defects, both algorithmic, neither about the runtime:

1. `tag()` in `tools/lib/siri.mjs` called `new RegExp(...)` on every field of
   every vehicle — roughly 260k regex compilations per document.
2. `fetch-archive.mjs` applied the `--line` filter to `parseSiriVm`'s
   *result*, so the whole country's ~20k vehicles were built as objects to
   keep the ~10 on one route.

With the parse fixed, the next cost was the reader: `unzip -Z1` to list, then
one `unzip -p` subprocess per entry. Each spawn re-opens the archive and
re-reads its central directory, so the cost scales with archive size — ~290 ms
per document against the real 4 GB bundle, plus ~5.5 minutes for the listing.
On 2880 entries that is most of an hour spent on process startup.

## Decision

Stay in Node. Fix the two algorithmic defects, and replace the
subprocess-per-entry reader with a single streaming inflate pass
(`fflate`'s `Unzip`, already a dependency) driven by `for await`, so
backpressure bounds memory the way the file handle did before.

Measured on a real bundle in Actions ([run 5][run5], 2872 documents of
2026-08-29): **1.4 -> 8.1 documents/sec**, so a bundle's read-and-parse went
from ~33.5 min to **5m55s**, a 5.7x end-to-end gain. The synthetic benchmark
above suggested more (the parse alone is ~34x); it doesn't materialise because
once the regex work is gone the cost is dominated by inflating ~5.5GB and
decoding it to strings, which is real work rather than waste. A local day is
now dominated by the ~7 min/bundle download, which is network-bound and which
no language changes.

The same run confirmed the filter is still correct on real data: 362 sightings
for line 99, all of them in the last ~120 documents of the 2026-08-29 bundle —
which is exactly right, since a BST local day takes only its final hour from
the preceding UTC day.

[run5]: https://github.com/raffij/buslife/actions/runs/33415620493

The alternatives:

- **Port to Go.** The strongest of the three languages asked about: `archive/zip`
  with `io.ReaderAt` seeks entries in a 4 GB file with no subprocess at all,
  it cross-compiles to a single static binary, and it needs no toolchain
  bootstrap in CI beyond `setup-go`. It was rejected because it does not
  address either real defect — a Go port of the same algorithm would build the
  same 20k discarded objects per document and land within small factors of
  where Node already was. The fixes here would have to be made in Go too, and
  would carry the same 34x. Worth revisiting only if a fixed Node path still
  proves too slow.
- **Port to Rust.** Faster still (`quick-xml`, `zip`, `rayon`), and the same
  objection applies with more force: it buys throughput this workload no
  longer needs, in exchange for a compile step on a data pipeline whose
  wall-clock is now mostly `fetch()` waiting on the network.
- **Port to C.** Rejected outright. No standard-library ZIP or XML, so it
  means vendoring both, and it puts manual memory management in front of 4 GB
  of third-party input parsed by hand. All of the risk, none of the upside
  over Go.
- **Raise `--max-old-space-size` / shard the range across matrix jobs.** Both
  buy headroom around a program doing ~1000x more work than it needs to,
  and neither makes a wide range affordable.

## Consequences

A local day's two bundles now read and parse in ~12 minutes rather than ~67,
so the job is dominated by its ~14 minutes of downloading and a multi-day
range is viable inside the job limit for the first time. Peak memory is
bounded by streaming backpressure plus an explicit cap, with the `unzip`
reader behind it when that cap trips.

`parseSiriVm(xml)` is unchanged for callers that want every vehicle — the
live recorder (`record.mjs`) passes no filter and still sees the whole feed,
though it does get the 1.6x from the regex cache. The filter is opt-in via
`parseSiriVm(xml, { line })`.

Filtering inside the parse means `records.length` can no longer answer "did
this document contain buses at all?", which is what told "the archive has no
data for this day" apart from "your `--line` is wrong". The parser now also
returns `scanned`, and `fetch-archive.mjs` counts that instead, so the
diagnostic still works.

The `unzip`-per-entry reader is kept as `xmlDocumentsInZipFileViaUnzip` and is
used automatically whenever the streaming read fails, at whatever point it
fails. It re-reads the bundle from the start, so `xmlDocumentsInZipFile` can
yield a document twice — safe for `fetch-archive.mjs`, which de-duplicates,
and documented on the function for anyone who counts documents instead.

### The streaming reader is not trustworthy on its own

Run 5 also found the limit of the streaming reader, and it is not a
theoretical one. The 2026-08-29 bundle streamed cleanly end to end. The
2026-08-30 bundle — the same source, the same shape, ~5.5GB like its
predecessor — exhausted a 4GB heap about 40 seconds in, after handing over
~128 entries:

```
17:02:50  2026-08-30: downloaded
17:03:47  FATAL ERROR: Reached heap limit Allocation failed
          Mark-Compact (reduce) 4094.7 (4096.8) -> 4094.3 (4096.8) MB
```

The root cause is not established: `fflate`'s streaming `Unzip` follows local
file headers itself, and something in that bundle appears to cost it the entry
boundaries, after which it accumulates rather than emitting. Reproducing it
needs the bundle, which is a 5.5GB download away from any dev machine.

So the reader is bounded by construction instead of by diagnosis. A single
entry, or the set of entries completed by one read and not yet consumed, may
not exceed 512MB — twenty-odd times a legitimate ~20MB poll document, so it
only trips on the runaway case. Exceeding it abandons the streaming read and
falls back to the `unzip` binary, which re-reads the bundle from the start;
`fetch-archive.mjs` keys sightings by vehicle and timestamp and drops repeats,
so that costs time rather than correctness. The failure mode is now "this day
takes ~15 minutes instead of ~6" rather than "the process dies and the day is
lost".

### Disk was never the constraint it looked like

The unbounded cache in `data/archive-cache/` was worth fixing, but not for the
reason first supposed. Measured on the runner, `/` is **145G with 85G
available**, not the ~14G assumed — a single local day's two bundles (~11GB
together) were never close to filling it, and no run has ever failed on disk.

`--prune-cache` is kept because a *wide range* still exceeds that: at ~5.5GB a
bundle and N+1 bundles for N dates, roughly a fortnight's backfill would
exhaust 85G. It drops each bundle once no remaining date needs it, keeping the
one consecutive dates share until the later is done. Both workflows pass it
and report `df -h /` either side, so if disk ever does become the limit it is
legible rather than mysterious. It is opt-in because locally the opposite
trade is usually right: re-downloading 5.5GB to fetch a second route for a
date already done costs more than the disk does.

Both workflows also gained an explicit `timeout-minutes`, so a job that is
going to fail on a stalled transfer says so well before the 6-hour default.

### `dry_run` and `force` never reached the scripts

Found by dispatching what was meant to be a safe dry run and watching it start
a real multi-GB download. Both workflows gated their flags on
`inputs.<name> == 'true'`, and for a `type: boolean` input that is always
false: `inputs.*` is a real boolean (unlike `github.event.inputs.*`, always a
string), and GitHub's `==` casts a boolean and a string to numbers before
comparing — `true` becomes 1, `'true'` becomes NaN. Both now test truthiness,
which is correct for a typed boolean, with the reasoning left in the workflow
files so it doesn't get "fixed" back.

### ...and behind it, a dry run could never have passed anyway

With `--check` finally reaching the scripts, the backfill finished in under a
second and the run failed at the next step instead:

```bash
for f in data/archive-cache/range-check.md data/archive-cache/range-summary.md; do
  [ -f "$f" ] && cat "$f" >> "$GITHUB_STEP_SUMMARY"
done
```

Only one of those files is ever written. Under `bash -e` a `for` loop exits
with its last iteration's status, so the step fails whenever the missing file
comes last. A real run writes `range-summary.md` — last, present, exit 0. A
`--check` run writes `range-check.md` and leaves `range-summary.md` missing in
last place: exit 1. Every dry run was going to fail here whatever the backfill
did, and it stayed invisible because the boolean bug meant no dry run ever got
this far. Each bug hid the other. Now an `if`, which is unconditionally 0.

Still outstanding, and not addressed here: a BST local day pulls two bundles
but needs only one hour from the first, and all 2880 of its documents are
parsed to find it. Skipping entries by filename timestamp would cut most of
that, but the bundle's internal naming isn't documented (see the note in
`archive.mjs`) and guessing it wrongly would silently drop sightings.

## Diagram

No system-map impact. This changes the parsing strategy and ZIP transport
inside the existing archive-fetch step — the components, connections, and
boundaries in `docs/architecture/` are untouched, exactly as in 0004.
