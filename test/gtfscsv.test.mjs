// The GTFS CSV reader.
//
// This exists because of a crash, not a parsing bug. The static tables are
// reloaded when they pass twelve hours old, and the reader this replaced built
// every row twice — once as a string[], then again as a Record with a property
// per column — for all three files at once, on top of the tables still being
// served from. Measured: 209 MB allocated in a burst to keep 7 MB. Against a
// 281 MB ceiling that was fatal, and the process died 15.5 seconds into the
// first poll after its data went stale, on five separate days.
//
// The replacement streams: one reused row array, only the named columns, one
// file at a time. It was verified against the old one by fingerprinting every
// parsed field — 8 791 stops, 3 476 stations, 13 698 trains, identical
// sha256 — so what is left to guard here is the reader's own semantics, which
// a column-index slip would quietly corrupt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// GtfsStatic uses a parameter-property constructor, which Node cannot strip,
// so this reads the built output rather than the source.
const { forEachRow } = await import(path.join(ROOT, 'dist-server/server/GtfsStatic.js'));

/** Collect what the reader yields, copying because the row array is reused. */
function rows(text, wanted) {
  const out = [];
  forEachRow(text, wanted, (v) => out.push([...v]));
  return out;
}

test('columns come back in the order asked for, not the file order', () => {
  const csv = 'stop_lat,stop_id,stop_name\n48.8,X,Gare\n';
  assert.deepEqual(rows(csv, ['stop_id', 'stop_name', 'stop_lat']), [['X', 'Gare', '48.8']]);
});

test('a quoted field may contain the delimiter', () => {
  // Why the reader is hand-written at all: SNCF names contain commas.
  const csv = 'a,b\n"Paris, Gare de Lyon",2\n';
  assert.deepEqual(rows(csv, ['a', 'b']), [['Paris, Gare de Lyon', '2']]);
});

test('a doubled quote inside a quoted field is one quote', () => {
  const csv = 'a,b\n"say ""hi""",2\n';
  assert.deepEqual(rows(csv, ['a']), [['say "hi"']]);
});

test('a quoted field may contain a newline', () => {
  const csv = 'a,b\n"two\nlines",2\n';
  assert.deepEqual(rows(csv, ['a', 'b']), [['two\nlines', '2']]);
});

test('CRLF line endings do not leak a carriage return into the last column', () => {
  // The last field of every row, on a Windows-authored export.
  const csv = 'a,b\r\n1,2\r\n';
  assert.deepEqual(rows(csv, ['b']), [['2']]);
});

test('a row with the wrong number of fields is skipped, not misaligned', () => {
  // Taking a ragged row would shift every column after it.
  const csv = 'a,b,c\n1,2,3\nbroken,row\n4,5,6\n';
  assert.deepEqual(rows(csv, ['a', 'c']), [['1', '3'], ['4', '6']]);
});

test('a column the file does not have reads empty rather than throwing', () => {
  // A schema change should cost a field, not the process.
  const csv = 'a,b\n1,2\n';
  assert.deepEqual(rows(csv, ['a', 'nope']), [['1', '']]);
});

test('the header is not returned as data', () => {
  assert.deepEqual(rows('a,b\n1,2\n', ['a']), [['1']]);
});

test('a file with only a header yields nothing', () => {
  assert.deepEqual(rows('a,b\n', ['a']), []);
});

test('a final row without a trailing newline is still read', () => {
  assert.deepEqual(rows('a,b\n1,2', ['a', 'b']), [['1', '2']]);
});

test('header names are trimmed, as the old reader did', () => {
  // The real files have a BOM-adjacent space on occasion.
  assert.deepEqual(rows('a , b\n1,2\n', ['a', 'b']), [['1', '2']]);
});

test('nothing is accumulated: the row array handed out is reused', () => {
  // The whole point of the rewrite. If a future change starts allocating a
  // fresh array — or worse, an object — per row, this catches it.
  const seen = [];
  forEachRow('a,b\n1,2\n3,4\n', ['a'], (v) => seen.push(v));
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'the same array should be handed back each time');
});

test('empty input is not an error', () => {
  assert.deepEqual(rows('', ['a']), []);
});
