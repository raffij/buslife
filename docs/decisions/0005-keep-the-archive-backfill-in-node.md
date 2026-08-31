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

Measured through the repo's own code after the change: parse **34x** faster
(261 ms -> 7.7 ms per document), and read+parse together **13.0 -> 0.5
min/bundle**. A local day is now dominated by the ~9.5 min/bundle download,
which is network-bound and which no language changes.

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

A day that took ~70 minutes of parsing now takes well under one, so a
multi-day range is viable inside the job limit for the first time. Peak memory
stays bounded, now by streaming backpressure rather than by a file handle.

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
used automatically if the streaming reader fails before yielding anything —
it walks local file headers itself, so an archive built in a way `fflate`
doesn't handle degrades to the slower path that has read these bundles
before, rather than failing the run.

### Disk, once time stopped being the limit

Making the range affordable in time exposed the next runner limit: the shared
cache in `data/archive-cache/` was never pruned. A bundle is ~4GB and N local
dates span N+1 UTC days, so a week-long range wants ~32GB on a GitHub runner
with ~14GB free — it would have run out of disk instead of out of time.

`fetch-archive-range.mjs` now takes `--prune-cache`, which drops each bundle
as soon as no remaining date in the run needs it, bounding disk to the two or
three bundles actually in play while keeping the bandwidth saving that made
the cache worth having (consecutive local dates share a bundle, and the shared
one is explicitly kept). Both workflows pass it, and both now report `df -h /`
either side of the backfill so "no space left on device" is legible rather
than mysterious. It is opt-in because locally the opposite trade is usually
right: re-downloading 4GB to fetch a second route for a date already done
costs more than the disk does.

Both workflows also gained an explicit `timeout-minutes`, so a job that is
going to fail on a stalled transfer says so well before the 6-hour default.

Still outstanding, and not addressed here: a BST local day pulls two bundles
but needs only one hour from the first, and all 2880 of its documents are
parsed to find it. Skipping entries by filename timestamp would cut most of
that, but the bundle's internal naming isn't documented (see the note in
`archive.mjs`) and guessing it wrongly would silently drop sightings.

## Diagram

No system-map impact. This changes the parsing strategy and ZIP transport
inside the existing archive-fetch step — the components, connections, and
boundaries in `docs/architecture/` are untouched, exactly as in 0004.
