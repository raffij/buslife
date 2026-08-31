# 0003. Generalise the backfill to a date range and multiple routes

- **Date:** 2026-08-31
- **Status:** Accepted

## Context

0002 automated backfilling *yesterday*, for *line 99*. The next ask, once
that existed, was the natural generalisation: an arbitrary date range, and
whichever routes the repo has — not just the one it started with.

## Decision

`tools/fetch-archive-range.mjs` loops `--start`..`--end` (inclusive) ×
`--routes` (or every `data/routes/*.route.json` found, if omitted), skipping
a (date, route) pair already compiled unless `--force`, and — because a wide
range makes hitting something unavailable partway through likely rather than
exceptional — keeps going past an individual failure instead of aborting the
whole range over one bad day. It writes a Markdown + JSON summary either way.

`.github/workflows/fetch-archive-range.yml` is a thin `workflow_dispatch`
wrapper around it. `fetch-archive.yml` (0002's daily job) is now itself a
one-day call into the same tool rather than its own copy of the fetch+
compile+skip logic — the practical effect is that the daily job now covers
every route automatically, not just line 99, with no further edits needed
when a route is added.

The PR-open-and-merge dance both workflows need (validate in-job, since a
`GITHUB_TOKEN`-opened PR can't be gated by `ci.yml`'s own checks — see 0002)
is now `.github/actions/merge-replay-pr`, a composite action, rather than a
second copy of the same ~40 lines of git/gh choreography. Two near-identical
copies of something this correctness-sensitive (the idempotent branch
force-push, the "reuse an existing PR from a failed attempt" check) were one
edit away from drifting out of sync; a composite action makes that
structurally impossible instead of relying on remembering to update both.

**Alternatives considered:**

- *Run the range as a GitHub Actions matrix (one job per day, or per
  date×route), for parallel downloads.* Rejected: each matrix job is a
  separate runner with its own disk, so the whole point of the per-UTC-day
  cache — a date range's shared boundary days, and multiple routes on the
  same date, download that day's bundle once — would need re-doing via
  `actions/cache` cache-key coordination across jobs instead of coming for
  free from one job's local filesystem. Worse, `compile.mjs` rebuilds
  `public/replays/index.json` from a full directory scan on every call, so
  parallel jobs finishing around the same time and each trying to commit
  would race on that file. A single sequential job trades wall-clock time
  for correctness and simplicity that a manually-triggered, occasional bulk
  job doesn't need to give up.
- *Cap the date range in code.* Rejected in favour of just saying so loudly
  in the workflow's own comments and the README: a day-bundle is the whole
  country's traffic, easily a few hundred MB, so a month-long range is a
  multi-GB, long-running job — a real constraint worth knowing about before
  requesting one, but not one this tool can safely guess a "sensible" limit
  for on the requester's behalf. `dateRange()` does still reject an
  implausible range (>400 days) as an almost-certainly-a-typo guard, which
  is a different thing from a deliberately-chosen cap.
- *Derive `--operator` automatically from the route file.* Rejected — a
  route file's `operator` field is a display name ("Stagecoach South East"),
  not the SIRI-VM `OperatorRef` NOC code (`"SCCO"`) the archive actually
  filters on, and there's no reliable mapping between the two available
  here. `--operator` stays an explicit, manual override for the rare case a
  line number is ambiguous between operators.

## Consequences

Any route with a route file, over any range the archive covers, can now be
backfilled in one command or one workflow dispatch — including retroactively
filling in history for a route added after today. The cost is the same one
0002 already accepted (unattended pushes to `main`, data problems merge same
as anything else) at a larger scale: a bad wide-range run touches more days
at once. Nothing about this decision makes that worse in kind, only in
possible extent, so it isn't treated as a new risk needing its own new
mitigation beyond what 0002 already put in place (loud failure, no silent
partial success).

## Diagram

No system-map impact — same as 0001/0002, this changes how existing files
get filled in, not what components exist.
