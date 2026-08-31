# Repository notes

## Open PRs ready for review, not as drafts

Create pull requests in this repo ready for review, not as drafts. This
overrides the default draft-PR behavior for this project specifically.

## Check PR merge status before pushing more commits to a branch

Before pushing additional commits to a branch that already has an open PR,
check whether that PR has merged. A merged PR is finished: commits pushed
to its branch afterward don't land in anything and won't get reviewed —
easy to miss mid-session when new follow-up requests keep arriving for
what feels like the same piece of work.

If the PR has merged:

1. Fetch the latest default branch.
2. If the branch carries commits that never merged (pushed after the
   merge), preserve them by rebasing onto the new base instead of
   discarding them:
   `git rebase --onto origin/main <last-merged-commit> <branch>`
3. Force-push (safe here — it only rewrites the already-merged prefix of
   the branch, the unmerged commits are replayed on top of it, not
   discarded).
4. Open a **new** PR for the follow-up work. The old, merged PR cannot be
   reused or reopened for this.

Keep the same branch name throughout unless asked otherwise.

## Architecture diagrams use Archify

Generate architecture diagrams with the [Archify](https://github.com/tt-a1i/archify)
skill (`npx skills add tt-a1i/archify -g` if it isn't already installed), not
hand-rolled Mermaid or SVG. It renders a typed JSON spec into a self-contained,
explorable HTML diagram — dark/light themes, pan/zoom, guided views.

Every diagram in this repo must match this look:

- JetBrains Mono throughout.
- A dotted-grid dark canvas.
- Typed, colored component boxes (frontend/backend/database/cloud/security/messagebus/external).
- Straight orthogonal routing with labeled edges.
- Dashed boundary regions around related components.
- A legend with per-type counts.

Convention for this repo:

- Author the typed source at `docs/architecture/<name>.architecture.json`
  (schema in Archify's `schemas/architecture.schema.json`).
- Validate, then deliver, with the Archify CLI:
  `node bin/archify.mjs validate architecture <spec.json> --quality showcase --json`
  followed by
  `node bin/archify.mjs deliver architecture <spec.json> docs/architecture/<name>.architecture.html --quality showcase --json`.
  Don't hand-edit the delivered HTML.
- Commit the delivered HTML alongside its source JSON.
- Export a static dark-theme crop of the diagram (no toolbar/chrome) to
  `docs/<name>.png` for embedding in Markdown docs and READMEs, and link the
  interactive HTML next to it as "an interactive version lives in ...".
- Omit `meta.visual_preset` (stay on the default `classic` preset) unless a
  different Archify preset is explicitly requested, so all diagrams in this
  repo share one visual identity.

## Decisions get logged

Any decision that changes architecture, behavior a user or another client
depends on, or is expensive to reverse — a new dependency, a new data source,
a change to how a day is recorded or map-matched, a route-shape or replay-format
change — gets a record in `docs/decisions/`, not just a PR description. PR
descriptions rot out of search and don't survive a squash-merge; the log is
the durable "why."

- One file per decision: `docs/decisions/NNNN-title.md`, numbered
  sequentially. Copy `docs/decisions/TEMPLATE.md` to start one, and add a
  row to `docs/decisions/README.md`.
- Write it when you make the decision, not after — capture the alternatives
  you rejected and why while you still remember them.
- A decision that changes what a diagram in `docs/architecture/` shows
  (adds/removes a component, a connection, a boundary) means updating that
  diagram's JSON source and redelivering it, per the Archify convention
  above, as part of the same change — not a follow-up. Link the diagram
  from the decision record's "Diagram" section. A decision with no
  system-map impact (a naming choice, a lint rule) can skip the diagram,
  but say so explicitly rather than leaving the section out silently.
- Small, easily-reversed choices (a variable name, which test to add) don't
  need a record. When in doubt, err toward writing one — they're cheap.
