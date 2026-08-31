import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allRouteIds, loadRoute } from '../tools/lib/routes.mjs';

function tempRouteDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'buslife-routes-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  return dir;
}

test('every *.route.json in the directory is listed by id, sorted', () => {
  const dir = tempRouteDir({
    'wave-99.route.json': { id: 'wave-99' },
    'another.route.json': { id: 'another' },
    'not-a-route.json': { id: 'ignored' }, // wrong suffix — must not be picked up
    'README.md': 'not json at all',
  });
  try {
    assert.deepEqual(allRouteIds(dir), ['another', 'wave-99']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('an empty directory has no routes, not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buslife-routes-'));
  try {
    assert.deepEqual(allRouteIds(dir), []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('loading a route returns its path and parsed contents', () => {
  const dir = tempRouteDir({ 'wave-99.route.json': { id: 'wave-99', line: '99' } });
  try {
    const loaded = loadRoute('wave-99', dir);
    assert.equal(loaded.id, 'wave-99');
    assert.equal(loaded.path, join(dir, 'wave-99.route.json'));
    assert.equal(loaded.route.line, '99');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('loading a route that does not exist fails clearly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buslife-routes-'));
  try {
    assert.throws(() => loadRoute('nope', dir), /no route file/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the real repo route directory has at least wave-99', () => {
  const dir = new URL('../data/routes', import.meta.url).pathname;
  const ids = allRouteIds(dir);
  assert.ok(ids.includes('wave-99'));
  const { route } = loadRoute('wave-99', dir);
  assert.equal(route.id, 'wave-99');
  assert.equal(route.line, '99');
});
