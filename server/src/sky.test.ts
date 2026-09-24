/** Tests for the sky page and the diary.
 *
 * The failures that matter are dusk read as a storm, one smeared lens read as a city's weather, and a restart writing a sunset into the diary that nobody saw. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { solarElevation, type Highlight, type SkyRegion } from '../../shared/src/index.js';
import { Diary, DIARY } from './diary.js';
import { SKY, readSky, type SkyCamera } from './sky.js';

const temporaryDirectories: string[] = [];
after(() => {
  for (const path of temporaryDirectories) rmSync(path, { recursive: true, force: true });
});

/** Solar noon in Tallahassee at the March equinox, and local midnight the same night. */
const TLH = { lat: 30.44, lon: -84.28 };
const NOON = Date.UTC(2026, 2, 20, 17, 37) / 1000;
const MIDNIGHT = Date.UTC(2026, 2, 21, 5, 37) / 1000;
const region = { key: 'tallahassee', name: 'Tallahassee', ...TLH };

function camera(contrast: number, usual = 0.2, over: Partial<SkyCamera> = {}): SkyCamera {
  return { region: 'tallahassee', lastTs: NOON - 60, brightness: 0.45, contrast, contrasts: [usual, usual, usual, usual, contrast], ...over };
}

test('the sun is where the almanac puts it', () => {
  // At the equinox the noon sun stands at ninety degrees less the latitude.
  assert.ok(Math.abs(solarElevation(TLH.lat, TLH.lon, NOON) - (90 - TLH.lat)) < 1.5);
  assert.ok(solarElevation(TLH.lat, TLH.lon, MIDNIGHT) < -40);
});

test('most of a city going flat together in daylight reads as murk, and one smeared lens does not', () => {
  const murky = readSky([region], [camera(0.08), camera(0.09), camera(0.1), camera(0.2)], NOON)[0]!;
  assert.equal(murky.weather, 'murky');
  assert.equal(murky.contrast_known, 4);
  assert.equal(murky.contrast_low, 3);
  const one = readSky([region], [camera(0.08), camera(0.2), camera(0.21), camera(0.19)], NOON)[0]!;
  assert.equal(one.weather, null);
});

test('the same flattening at night is not weather', () => {
  const night = [camera(0.08), camera(0.09), camera(0.1), camera(0.1)].map((c) => ({ ...c, lastTs: MIDNIGHT - 60 }));
  assert.equal(readSky([region], night, MIDNIGHT)[0]!.weather, null);
});

test('too few cameras with a history are not judged, and old pictures do not speak for the sky', () => {
  const young = [camera(0.05, 0.2, { contrasts: [0.2, 0.05] }), camera(0.05), camera(0.05)];
  assert.equal(readSky([region], young, NOON)[0]!.weather, null, 'three cameras with history is below the minimum');
  const stale = readSky([region], [camera(0.05, 0.2, { lastTs: NOON - SKY.RECENT_S - 1 })], NOON)[0]!;
  assert.equal(stale.cameras, 0);
  assert.equal(stale.brightness, null);
});

function diary(): Diary {
  const path = mkdtempSync(join(tmpdir(), 'rt511-diary-'));
  temporaryDirectories.push(path);
  return new Diary(path);
}

const sky = (over: Partial<SkyRegion>): SkyRegion => ({ key: 'tallahassee', name: 'Tallahassee', ...TLH, sun_elevation: 20, brightness: 0.4, cameras: 5, contrast_known: 5, contrast_low: 0, weather: null, ...over });
const highlight: Highlight = { kind: 'movement', brief: 'Unusual movement near Betton Rd.', camera: 7, region: 'tallahassee', attention: 0.9, at: NOON };

test('a restart does not write a sunset it never saw, and a real one is written once', async () => {
  const book = diary();
  assert.deepEqual(book.note([], [sky({ sun_elevation: -3 })], NOON), [], 'the first look only learns where the sun is');
  assert.deepEqual(book.note([], [sky({ sun_elevation: -4 })], NOON + 60), []);
  const rise = book.note([], [sky({ sun_elevation: 1 })], NOON + 120);
  assert.equal(rise.length, 1);
  assert.equal(rise[0]!.kind, 'sunrise');
  assert.match(rise[0]!.brief, /40% brightness/);
});

test('murk is written when it starts and when it clears', () => {
  const book = diary();
  book.note([], [sky({})], NOON);
  assert.equal(book.note([], [sky({ weather: 'murky', contrast_low: 4 })], NOON + 60)[0]!.kind, 'murky');
  assert.deepEqual(book.note([], [sky({ weather: 'murky', contrast_low: 4 })], NOON + 120), []);
  assert.equal(book.note([], [sky({})], NOON + 180)[0]!.kind, 'clear');
});

test('a long event is one entry, not one a minute, and entries read back from disk', async () => {
  const book = diary();
  assert.equal(book.note([highlight], [], NOON).length, 1);
  assert.equal(book.note([highlight], [], NOON + 60).length, 0);
  assert.equal(book.note([highlight], [], NOON + DIARY.REPEAT_S + 1).length, 1);
  await book.drain();
  const day = book.days()[0]!;
  const entries = book.read(day);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.camera, 7);
  assert.deepEqual(book.read('../../etc/passwd'), [], 'a day that is not a date reads nothing');
});
