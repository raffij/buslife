import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import {
  dayBundleUrl,
  nextDateStr,
  utcDaysForLocalDate,
  xmlDocumentsInBundle,
} from '../tools/lib/archive.mjs';

const LONDON = 'Europe/London';

test('the day-bundle URL matches the archive layout', () => {
  assert.equal(
    dayBundleUrl('sirivm', { year: 2026, month: 8, day: 3 }),
    'https://data.datalibrary.uk/transport/BODS-ARCHIVE/sirivm/2026/08/03/sirivm-20260803.zip',
  );
});

test('the next calendar date rolls over month and year boundaries', () => {
  assert.equal(nextDateStr('2026-08-30'), '2026-08-31');
  assert.equal(nextDateStr('2026-08-31'), '2026-09-01');
  assert.equal(nextDateStr('2026-12-31'), '2027-01-01');
  assert.equal(nextDateStr('2024-02-28'), '2024-02-29'); // leap year
});

test('a winter local day (GMT, no offset) needs exactly one UTC bundle', () => {
  const days = utcDaysForLocalDate('2026-01-15', LONDON);
  assert.deepEqual(days, [{ year: 2026, month: 1, day: 15 }]);
});

test('a summer local day (BST, UTC+1) straddles two UTC bundles', () => {
  // Local midnight is 23:00 UTC the day before, so the first hour of the
  // London day lives in the previous UTC day's bundle.
  const days = utcDaysForLocalDate('2026-08-30', LONDON);
  assert.deepEqual(days, [
    { year: 2026, month: 8, day: 29 },
    { year: 2026, month: 8, day: 30 },
  ]);
});

test('the day the clocks go forward (a 23-hour local day) needs only one bundle', () => {
  // GMT (offset 0) is still in effect at local midnight — the transition to
  // BST doesn't happen until 1am — so this day starts exactly at UTC
  // midnight and ends at 23:00 UTC the same day: it never crosses a UTC
  // calendar boundary at all.
  const days = utcDaysForLocalDate('2026-03-29', LONDON);
  assert.deepEqual(days, [{ year: 2026, month: 3, day: 29 }]);
});

test('the day the clocks go back (a 25-hour local day) needs two bundles', () => {
  // BST (offset +1) is still in effect at local midnight, so this day starts
  // at 23:00 UTC the day before and — being an hour longer than usual —
  // still ends within the following UTC day.
  const days = utcDaysForLocalDate('2026-10-25', LONDON);
  assert.deepEqual(days, [
    { year: 2026, month: 10, day: 24 },
    { year: 2026, month: 10, day: 25 },
  ]);
});

test('XML entries in a bundle are read out directly', () => {
  const zip = zipSync({
    'sirivm-20260830T000000.xml': strToU8('<Siri>a</Siri>'),
    'sirivm-20260830T000030.xml': strToU8('<Siri>b</Siri>'),
  });
  const docs = [...xmlDocumentsInBundle(zip)].sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(docs.length, 2);
  assert.equal(docs[0].xml, '<Siri>a</Siri>');
  assert.equal(docs[1].xml, '<Siri>b</Siri>');
});

test('a nested zip-of-zips entry is unwrapped one level to reach the XML', () => {
  const inner = zipSync({ 'siri.xml': strToU8('<Siri>nested</Siri>') });
  const outer = zipSync({ 'sirivm-20260830T000000.zip': inner });
  const docs = [...xmlDocumentsInBundle(outer)];
  assert.equal(docs.length, 1);
  assert.equal(docs[0].xml, '<Siri>nested</Siri>');
});

test('directory entries in the zip are skipped, not yielded as empty documents', () => {
  const zip = zipSync({
    'sirivm/': new Uint8Array(0),
    'sirivm/a.xml': strToU8('<Siri>a</Siri>'),
  });
  const docs = [...xmlDocumentsInBundle(zip)];
  assert.equal(docs.length, 1);
  assert.equal(docs[0].name, 'sirivm/a.xml');
});

test('a mix of flat XML and nested zips in one bundle are all reached', () => {
  const inner = zipSync({ 'siri.xml': strToU8('<Siri>nested</Siri>') });
  const zip = zipSync({
    'flat.xml': strToU8('<Siri>flat</Siri>'),
    'wrapped.zip': inner,
  });
  const xmls = [...xmlDocumentsInBundle(zip)].map((d) => d.xml).sort();
  assert.deepEqual(xmls, ['<Siri>flat</Siri>', '<Siri>nested</Siri>']);
});
