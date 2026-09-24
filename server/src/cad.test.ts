/** Tests for incident feeds. The failures that matter are an undated record gaining a floor it was never configured to have, a closure read as ordinary, and a key-gated feed being asked without its key. Nothing here touches the network. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CadFeed, parseOhgoIncidents, type CadSource } from './cad.js';

const body = (results: Record<string, unknown>[]): string => JSON.stringify({ totalPageCount: 1, results });
const crash = { id: 'A1', latitude: 39.96, longitude: -83.0, location: 'I-70 at Rt 315', description: 'Crash, right lane blocked', category: 'Crash', direction: 'Westbound', routeName: 'I-70', roadStatus: 'Partially closed' };
const closure = { ...crash, id: 'B2', category: 'Closure', roadStatus: 'Closed' };

const source = (over: Partial<CadSource> = {}): CadSource => ({
  key: 'ohgo',
  name: 'OHGO incidents',
  url: 'https://publicapi.example/api/v1/incidents',
  format: 'ohgo-json',
  attribution: '',
  poll_period_s: 120,
  notes: '',
  codes: null,
  undated: 'first_seen',
  auth: { env: 'TEST_OHGO_KEY', header: 'Authorization', format: 'APIKEY {key}' },
  ...over,
});

test('OHGO records are road-relevant, a closed road implies closure, and the category is the label', () => {
  const [a, b] = parseOhgoIncidents(body([crash, closure]));
  assert.equal(a?.road_relevant, true);
  assert.equal(a?.implies_closure, false, 'partially closed is not closed');
  assert.equal(b?.implies_closure, true);
  assert.equal(a?.label, 'Crash');
  assert.equal(a?.location, 'I-70 Westbound I-70 at Rt 315');
  assert.equal(a?.reported_at, null, 'OHGO publishes no report time');
});

test('an undated record is dated by first sighting only when the feed is configured to, and keeps that date', async (t) => {
  process.env.TEST_OHGO_KEY = 'k';
  t.after(() => delete process.env.TEST_OHGO_KEY);
  let sent: string | null = null;
  let payload = body([crash]);
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    sent = new Headers(init?.headers).get('authorization');
    return new Response(payload, { status: 200 });
  });
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
  const feed = new CadFeed(source(), 'rt511-test', { ids: [], lat: [], lon: [] });
  await feed.refresh();
  assert.equal(sent, 'APIKEY k');
  assert.equal(feed.current()[0]?.reported_at, 1_000_000);
  t.mock.timers.tick(300_000);
  payload = body([crash, closure]);
  await feed.refresh();
  const byId = new Map(feed.current().map((incident) => [incident.id, incident.reported_at]));
  assert.equal(byId.get('A1'), 1_000_000, 'a record keeps the time it was first seen');
  assert.equal(byId.get('B2'), 1_000_300);

  const plain = new CadFeed(source({ undated: null }), 'rt511-test', { ids: [], lat: [], lon: [] });
  await plain.refresh();
  assert.equal(plain.current()[0]?.reported_at, null, 'without the setting an undated record stays undated and gets no floor');
});

test('a key-gated feed is not asked without its key', async (t) => {
  delete process.env.TEST_OHGO_KEY;
  let asked = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    asked++;
    return new Response(body([crash]), { status: 200 });
  });
  const feed = new CadFeed(source(), 'rt511-test', { ids: [], lat: [], lon: [] });
  await feed.refresh();
  assert.equal(asked, 0);
  assert.equal(feed.healthy, false);
  assert.deepEqual(feed.current(), []);
});
