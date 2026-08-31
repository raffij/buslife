# 0004. Stream large archive bundles from disk

- **Date:** 2026-08-31
- **Status:** Accepted

## Context

The archive range workflow can encounter a SIRI-VM day-bundle around 6GB.
`fetch-archive.mjs` previously loaded the HTTP response into an
`ArrayBuffer`, then `fflate.unzipSync()` expanded the whole ZIP in memory.
That made a valid archive exceed the GitHub runner's Node heap before the
line filter could discard the country's unrelated traffic.

## Decision

Keep the implementation in Node, stream each HTTP response into the existing
per-day cache, and use the runner's `unzip` utility to list and extract one
ZIP entry at a time. Keep the existing byte-based `fflate` helper for small
fixtures and nested ZIP data, but do not use it for the outer multi-GB bundle.

The alternatives were increasing `--max-old-space-size`, which still
materialises the archive and depends on runner memory, and porting the
workflow to Python, which adds a second runtime without removing the need
for streaming ZIP extraction. A ZIP library dependency with streaming APIs
was also considered, but the workflow already runs on Ubuntu where `unzip`
is available and the Node implementation can avoid another production
dependency.

## Consequences

Peak Node memory is bounded by the ZIP listing, one XML entry (or nested
per-poll ZIP), and the filtered sightings. The complete bundle still needs
enough runner disk space because it is cached before parsing; interrupted
downloads are removed and retried from a `.part` file. This keeps the
existing retry and cache semantics while making multi-GB bundles viable.

## Diagram

No system-map impact — this changes the transport and buffering strategy for
an existing archive-fetch step, not the components or data flow.
