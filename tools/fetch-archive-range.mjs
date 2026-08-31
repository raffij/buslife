#!/usr/bin/env node
/**
 * Backfill a range of days, for one or more routes, in one run.
 *
 * A thin loop around fetch-archive.mjs + compile.mjs — see those for what
 * actually happens for one (date, route). This works out which dates and
 * routes to run, skips combinations already compiled, and — because a wide
 * range makes hitting something unavailable partway through likely rather
 * than exceptional — keeps going past an individual failure instead of
 * aborting the whole range over one bad day.
 *
 *   npm run fetch-archive-range -- --start 2026-08-01 --end 2026-08-07
 *   npm run fetch-archive-range -- --start 2026-08-01 --end 2026-08-07 --routes wave-99,other-route
 *
 * fetch-archive.mjs's own per-UTC-day cache (data/archive-cache/) is what
 * keeps this affordable: every date in the range and every route requested
 * for it shares that one cache, so a UTC day-bundle spanning two local dates
 * — or needed by two different routes on the same date — is only ever
 * downloaded once per run.
 *
 * That cache is also unbounded, which on a CI runner matters more than the
 * bandwidth it saves: a bundle is ~4GB and N local dates span N+1 UTC days.
 * Pass --prune-cache (both workflows do) to drop each bundle once no
 * remaining date needs it — the sharing above is preserved, since a bundle
 * two consecutive dates both want is kept until the second is done.
 *
 * The check this all rests on — "do we already have this?" — is answered
 * from public/replays/<route.id>-<date>.json's mere existence: that's the
 * one thing that's actually committed to the repo (data/snapshots/ and
 * data/archive-cache/ are both gitignored, ephemeral scratch space, empty
 * again on the next fresh checkout), so it's the only check that's still
 * correct after this exact process has never run on this machine before —
 * a GitHub Actions runner, most of the time. --check runs that same check
 * for a range without fetching anything, for when the range is wide enough
 * that knowing what it would even do is worth doing before spending the
 * bandwidth: `--check` alone, or --dry-run.
 *
 *   npm run fetch-archive-range -- --start 2026-08-01 --end 2026-08-31 --check
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, die } from './lib/args.mjs';
import { dateRange, prunableBundles } from './lib/archive.mjs';
import { allRouteIds, loadRoute } from './lib/routes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();

const start = args.start;
const end = args.end;
if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) die('pass --start YYYY-MM-DD');
if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) die('pass --end YYYY-MM-DD');

const routesDir = join(ROOT, 'data/routes');
const routeIds = args.routes
  ? String(args.routes).split(',').map((s) => s.trim()).filter(Boolean)
  : allRouteIds(routesDir);
if (!routeIds.length) die(`no routes found in ${routesDir}, and none given via --routes`);

// Applied to every route in this run. The archive filters on the SIRI-VM
// OperatorRef (a NOC code, e.g. "SCCO"), which route files don't currently
// carry — only a human-readable operator name — so this can't be derived
// automatically; pass it explicitly if a line number is ambiguous between
// operators.
const operator = args.operator ? String(args.operator) : null;
const force = args.force === true || args.force === 'true';

/**
 * Delete each cached day-bundle as soon as no later date in this run needs it.
 *
 * The shared cache is what keeps a range affordable in bandwidth — a UTC
 * day-bundle spanning two local dates is downloaded once — but nothing ever
 * removed one, and a bundle is ~4GB. N local dates span N+1 UTC days, so a
 * week-long range wants ~32GB of cache on a GitHub runner that has ~14GB
 * free: the range workflow ran out of disk long before it ran out of time.
 *
 * Pruning keeps the bandwidth saving (a bundle is only dropped once every
 * date that could reuse it is done) while bounding disk to the two or three
 * bundles actually in play. It's opt-in because locally the opposite trade is
 * usually right: disk is cheap and re-downloading 4GB to fetch a second route
 * for a date you already did is not.
 */
const pruneCache = args['prune-cache'] === true || args['prune-cache'] === 'true';

// fetch-archive.mjs resolves a local date to UTC day-bundles in this zone, and
// pruning has to agree with it about which bundles a date needs — a mismatch
// would delete a bundle still to be used and silently re-download it.
const TIME_ZONE = 'Europe/London';

const cacheDir = join(ROOT, 'data/archive-cache');

/** Drop cached bundles no remaining date needs. Returns bytes freed. */
function pruneBundles(remainingDates) {
  if (!existsSync(cacheDir)) return 0;
  let freed = 0;
  for (const name of prunableBundles(readdirSync(cacheDir), remainingDates, TIME_ZONE)) {
    const path = join(cacheDir, name);
    try {
      freed += statSync(path).size;
      rmSync(path, { force: true });
    } catch {
      // A bundle we can't stat or remove is not worth failing a backfill over;
      // the worst case is the disk pressure we were already living with.
    }
  }
  return freed;
}

const GB = 1024 ** 3;
const check = args.check === true || args.check === 'true' || args['dry-run'] === true || args['dry-run'] === 'true';
if (check && force) die("--check and --force don't make sense together — --force means refetch even what we have; --check never fetches anything");

let dates;
try {
  dates = dateRange(start, end);
} catch (err) {
  die(err.message);
}

if (check) console.log('--check: reporting only — nothing will be downloaded or written to public/replays/\n');
console.log(`${check ? 'checking' : 'backfilling'} ${dates.length} date(s) x ${routeIds.length} route(s) = ${dates.length * routeIds.length} combination(s)`);
console.log(`dates: ${start} .. ${end}`);
console.log(`routes: ${routeIds.join(', ')}`);

const results = [];
let freedBytes = 0;

for (const [dateIndex, date] of dates.entries()) {
  for (const routeId of routeIds) {
    let loaded;
    try {
      loaded = loadRoute(routeId, routesDir);
    } catch (err) {
      results.push({ date, routeId, status: 'error', detail: err.message });
      continue;
    }

    const outPath = join(ROOT, 'public/replays', `${loaded.route.id}-${date}.json`);
    const haveIt = existsSync(outPath);
    if (haveIt && !force) {
      results.push({ date, routeId, status: 'skipped', detail: 'already compiled' });
      continue;
    }

    const line = String(loaded.route.line);

    if (check) {
      results.push({
        date,
        routeId,
        status: 'would-fetch',
        detail: haveIt ? 'would re-fetch (already have it, but --force)' : 'not yet compiled',
      });
      continue;
    }

    console.log(`\n--- ${date} / ${routeId} (line ${line}) ---`);

    try {
      const fetchArgs = ['tools/fetch-archive.mjs', '--date', date, '--line', line, '--route', loaded.path];
      if (operator) fetchArgs.push('--operator', operator);
      execFileSync('node', fetchArgs, { cwd: ROOT, stdio: 'inherit' });

      execFileSync('node', ['tools/compile.mjs', '--date', date, '--route', loaded.path], {
        cwd: ROOT,
        stdio: 'inherit',
      });

      results.push({ date, routeId, status: 'ok', detail: 'fetched + compiled' });
    } catch {
      // fetch-archive.mjs exits non-zero when the archive has nothing for
      // that day yet (a real possibility this far from "yesterday") or
      // nothing matched — a reason to note it and move on, not to abort
      // every date that follows.
      results.push({ date, routeId, status: 'error', detail: 'failed — see the log above' });
    }
  }

  // Every route for this date is done, so any bundle no later date needs is
  // now dead weight. --check never downloads, so there is nothing to prune.
  if (pruneCache && !check) {
    const freed = pruneBundles(dates.slice(dateIndex + 1));
    if (freed > 0) {
      freedBytes += freed;
      console.log(`  pruned ${(freed / GB).toFixed(1)} GB of cached bundles no remaining date needs`);
    }
  }
}

const icon = { ok: '✅', skipped: '⏭️', error: '❌', 'would-fetch': '⬇️' };
const width = Math.max(...results.map((r) => `${r.date} / ${r.routeId}`.length));

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`${icon[r.status]} ${`${r.date} / ${r.routeId}`.padEnd(width)}  ${r.detail}`);
}

const ok = results.filter((r) => r.status === 'ok').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
const failed = results.filter((r) => r.status === 'error').length;
const wouldFetch = results.filter((r) => r.status === 'would-fetch').length;

const headline = check
  ? `${start}..${end} for ${routeIds.join(', ')}: **${skipped}** already have it, **${wouldFetch}** would need fetching.`
  : `Backfilled \`${start}\`..\`${end}\` for ${routeIds.join(', ')}: **${ok}** fetched, **${skipped}** already had it, **${failed}** failed.`;

console.log(
  `\n${check ? `${skipped} already have it, ${wouldFetch} would need fetching` : `${ok} fetched, ${skipped} skipped, ${failed} failed`}, ${results.length} total`,
);

if (freedBytes > 0) console.log(`pruned ${(freedBytes / GB).toFixed(1)} GB of cached bundles over the run`);

// May not exist yet: every combination could have been skipped or failed
// before fetch-archive.mjs (which is what normally creates it) ever ran.
mkdirSync(cacheDir, { recursive: true });
// A --check run writes to its own filenames — separate from a real run's
// range-summary.*, which a PR body may still need to read after this.
const summaryBase = check ? 'range-check' : 'range-summary';
writeFileSync(
  join(cacheDir, `${summaryBase}.json`),
  JSON.stringify({ start, end, routeIds, check, results, ok, skipped, failed, wouldFetch }, null, 2),
);
writeFileSync(
  join(cacheDir, `${summaryBase}.md`),
  [
    headline,
    '',
    '| Date | Route | Result |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.date} | ${r.routeId} | ${icon[r.status]} ${r.detail} |`),
  ].join('\n') + '\n',
);

// A --check run reporting "nothing to fetch" is success, not failure — it's
// the same thing an already-fully-backfilled real run reports.
if (!check && ok === 0 && failed > 0) {
  die(`nothing succeeded — ${failed} failure(s), see above`);
}
