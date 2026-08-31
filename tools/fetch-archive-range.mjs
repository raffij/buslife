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
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, die } from './lib/args.mjs';
import { dateRange } from './lib/archive.mjs';
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

let dates;
try {
  dates = dateRange(start, end);
} catch (err) {
  die(err.message);
}

console.log(`backfilling ${dates.length} date(s) x ${routeIds.length} route(s) = ${dates.length * routeIds.length} combination(s)`);
console.log(`dates: ${start} .. ${end}`);
console.log(`routes: ${routeIds.join(', ')}`);

const results = [];

for (const date of dates) {
  for (const routeId of routeIds) {
    let loaded;
    try {
      loaded = loadRoute(routeId, routesDir);
    } catch (err) {
      results.push({ date, routeId, status: 'error', detail: err.message });
      continue;
    }

    const outPath = join(ROOT, 'public/replays', `${loaded.route.id}-${date}.json`);
    if (existsSync(outPath) && !force) {
      results.push({ date, routeId, status: 'skipped', detail: 'already compiled' });
      continue;
    }

    const line = String(loaded.route.line);
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
}

const icon = { ok: '✅', skipped: '⏭️', error: '❌' };
const width = Math.max(...results.map((r) => `${r.date} / ${r.routeId}`.length));

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`${icon[r.status]} ${`${r.date} / ${r.routeId}`.padEnd(width)}  ${r.detail}`);
}

const ok = results.filter((r) => r.status === 'ok').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
const failed = results.filter((r) => r.status === 'error').length;
console.log(`\n${ok} fetched, ${skipped} skipped, ${failed} failed, ${results.length} total`);

const cacheDir = join(ROOT, 'data/archive-cache');
// May not exist yet: every combination could have been skipped or failed
// before fetch-archive.mjs (which is what normally creates it) ever ran.
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(cacheDir, 'range-summary.json'), JSON.stringify({ start, end, routeIds, results, ok, skipped, failed }, null, 2));
writeFileSync(
  join(cacheDir, 'range-summary.md'),
  [
    `Backfilled \`${start}\`..\`${end}\` for ${routeIds.join(', ')}: **${ok}** fetched, **${skipped}** already had it, **${failed}** failed.`,
    '',
    '| Date | Route | Result |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.date} | ${r.routeId} | ${icon[r.status]} ${r.detail} |`),
  ].join('\n') + '\n',
);

if (ok === 0 && failed > 0) {
  die(`nothing succeeded — ${failed} failure(s), see above`);
}
