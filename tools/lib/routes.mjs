/**
 * Discovering and loading route files from `data/routes/`.
 *
 * Every route file is expected to be named `<id>.route.json` where `<id>`
 * matches the `id` field inside it (true of `wave-99.route.json` today) —
 * that's what lets a route be selected by a short id on the command line
 * while `compile.mjs` independently derives the same id from the file's own
 * contents when it names its output.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SUFFIX = '.route.json';

/** Every route id available in `dir` (filename, minus the suffix), sorted. */
export function allRouteIds(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(SUFFIX))
    .map((f) => f.slice(0, -SUFFIX.length))
    .sort();
}

/** Load one route by id from `dir`, returning its path and parsed contents. */
export function loadRoute(id, dir) {
  const path = join(dir, `${id}${SUFFIX}`);
  if (!existsSync(path)) throw new Error(`no route file at ${path}`);
  return { id, path, route: JSON.parse(readFileSync(path, 'utf8')) };
}
