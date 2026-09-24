/** Tests for the per-source client: that a rate cap is kept and that a bulk source costs one document per poll period however many cameras ask. Nothing here touches the network. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, parseCompassSnapshots } from './client.js';
import type { Source } from './config.js';

const source = (over: Partial<Source> = {}): Source => ({
  key: 'test',
  name: 'Test',
  base_url: 'https://example.gov',
  states: ['XX'],
  snapshot_content_type: 'image/jpeg',
  video_auth: false,
  has_video: false,
  attribution: '',
  poll_period_s: 300,
  token_url: null,
  notes: '',
  kind: 'compass',
  license: '',
  terms_url: '',
  notice: '',
  max_requests_per_s: null,
  focus_period_s: null,
  feed: { url: 'https://nec-por.example/api/c2c' },
  ...over,
});

const document = (pictures: Record<string, string>): string =>
  `<status xmlns="http://its.gov/c2c_icd"><cctvSnapshotData><net id="Vermont">${Object.entries(pictures)
    .map(([id, bytes]) => `<cctvSnapshot id="${id}" netId="Vermont"><name>x</name><snippet>${bytes ? Buffer.from(bytes).toString('base64') : ''}</snippet></cctvSnapshot>`)
    .join('')}</net></cctvSnapshotData></status>`;

test('the bulk document is split by device, and a camera without a picture has none', () => {
  const images = parseCompassSnapshots(document({ 'I-89 SB BERLIN': 'jpeg-a', 'A &amp; B': 'jpeg-b', DARK: '' }));
  assert.equal(images.get('I-89 SB BERLIN')?.toString(), 'jpeg-a');
  assert.equal(images.get('A & B')?.toString(), 'jpeg-b', 'entities in an id are undone');
  assert.equal(images.has('DARK'), false);
});

test('every camera in a state shares one bulk fetch per poll period', async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    return new Response(document({ 'CAM 1': 'one', 'CAM 2': 'two' }), { status: 200 });
  });
  const client = new Client(source(), 'rt511-test');
  const [a, b] = await Promise.all([client.snapshot('compass:Vermont/CAM%201', null), client.snapshot('compass:Vermont/CAM%202', null)]);
  assert.equal(fetches, 1, 'two cameras polling at once cost one document');
  assert.equal(typeof a === 'object' && a.data.toString(), 'one');
  assert.equal(typeof b === 'object' && b.data.toString(), 'two');
  await client.snapshot('compass:Vermont/CAM%201', null);
  assert.equal(fetches, 1, 'inside the poll period the held copy is used');
  assert.equal(await client.snapshot('compass:Vermont/NOT%20THERE', null), 'unavailable');
});

test('a failed bulk fetch is not retried by every camera in the state', async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    return new Response('busy', { status: 503 });
  });
  const client = new Client(source(), 'rt511-test');
  assert.equal(await client.snapshot('compass:Vermont/CAM%201', null), 'unavailable');
  assert.equal(await client.snapshot('compass:Vermont/CAM%202', null), 'unavailable');
  assert.equal(fetches, 1);
});

test('a source is never sent more than its published rate', async (t) => {
  const starts: number[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
    starts.push(Date.now());
    return new Response(Buffer.from('jpeg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
  const client = new Client(source({ kind: 'ohgo', max_requests_per_s: 10 }), 'rt511-test', 4);
  await Promise.all([1, 2, 3].map((i) => client.snapshot(`https://itscameras.example/${i}.jpg`, null)));
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok((starts[i] as number) - (starts[i - 1] as number) >= 95, `request ${i} began ${(starts[i] as number) - (starts[i - 1] as number)} ms after the last`);
});

test('only the project User-Agent is sent to an agency', async (t) => {
  let headers: Headers | null = null;
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return new Response(Buffer.from('jpeg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
  await new Client(source({ kind: 'ohgo' }), 'rt511-test').snapshot('https://itscameras.example/1.jpg', null);
  const sent = headers as unknown as Headers;
  assert.equal(sent.get('user-agent'), 'rt511-test');
  assert.equal(sent.get('referer'), null);
  assert.equal(sent.get('origin'), null);
});
