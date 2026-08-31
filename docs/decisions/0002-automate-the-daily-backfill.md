# 0002. Automate the daily backfill with a self-merging GitHub Action

- **Date:** 2026-08-31
- **Status:** Accepted

## Context

`fetch-archive.mjs` (0001) makes backfilling a past day possible, but someone
still had to remember to run it. The natural next ask, once it existed, was
"do this for yesterday automatically" — needing no API key (the archive is
public) makes that genuinely unattended, unlike `record.mjs`, which needs a
`BODS_API_KEY` a scheduled job would have to be trusted with as a secret.

The obvious approach — a scheduled workflow opens a PR, `ci.yml`'s existing
`checks` + `automerge` jobs take it from there — doesn't actually work.
GitHub's recursion guard means a PR opened with the default `GITHUB_TOKEN`
does not fire other workflows' `pull_request` triggers, so `ci.yml`'s
`checks` job would simply never run against a bot-opened PR, and
`automerge` (gated on `needs: checks`) would never fire either. This isn't
specific to how the new workflow is written — it's true of any workflow that
opens a PR with the default token.

## Decision

`.github/workflows/fetch-archive.yml` runs daily (`06:00 UTC`, chosen as a
guessed-safe buffer — see the workflow's own comment for why the exact
timing isn't and can't be documented), computes "yesterday" in
`Europe/London`, and validates and merges its own PR within the same job
(`npm test` + `npm run build` before pushing, then `gh pr create` +
`gh pr merge --squash --delete-branch` immediately after) rather than
depending on `ci.yml` to pick it up. It re-dispatches `ci.yml` and
`deploy-pages.yml` afterward exactly as `ci.yml`'s own `automerge` job
already does, for the same reason: a `GITHUB_TOKEN`-authored merge push
doesn't trigger `push`-triggered workflows on its own either.

It skips a date `public/replays/` already has (a `force` input overrides
this), and treats "nothing changed" after fetch+compile as success, not an
error — the archive not having published yet is an expected, recoverable
state, not a bug.

**Alternatives considered:**

- *Give the scheduled workflow a personal access token instead of
  `GITHUB_TOKEN`, so its PR triggers `ci.yml` normally.* Rejected — this
  works, but needs a PAT minted and stored as a secret, with its own
  rotation/expiry to think about, for a problem this workflow can solve
  itself with no secret at all by validating in-job.
- *Commit straight to `main`, no PR.* Rejected even though it's simpler:
  every other change in this repo goes through a PR (see `AGENTS.md`), and a
  bot-authored push has exactly the same "doesn't trigger `deploy-pages.yml`
  on its own" problem a bot-authored merge does, so it isn't actually less
  code — just a less consistent, less visible trail of what got added and
  when.
- *Widen `ci.yml`'s `automerge` condition to also accept `workflow_dispatch`
  runs on a branch with an open PR.* Rejected as more invasive than it's
  worth: it complicates a job every interactive-session PR also depends on,
  for the benefit of one scheduled workflow that can just as well validate
  itself.

## Consequences

The site now updates itself daily with no one having to remember to run
anything — but that also means `main` now receives unattended pushes a
person didn't review, and a bad day's data (a genuine BODS/archive data
problem, not a code bug) would merge automatically same as anything else.
`npm test` + `npm run build` catch a broken pipeline; they can't catch bad
*data*. If that turns out to matter, the fix is loosening `automerge`'s
posture for this workflow specifically (e.g. open the PR without merging,
notify instead) — not something to pre-build before it's shown to be a real
problem.

## Diagram

This repo has no `docs/architecture/` diagram yet (unlike `waves`, which
this convention was ported from) — nothing to update.
