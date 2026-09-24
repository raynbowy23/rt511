/** Tests for the focus fetch: the camera open in the panel, at its agency's own refresh rate.
 *
 * The failures that matter are a source with no focus period being fetched anyway, several tabs multiplying what one agency receives, and a claim nobody restates fetching forever. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client, SnapshotResult } from './client.js';
import type { CatalogCamera, Source } from './config.js';
import { FOCUS, Focus } from './focus.js';

function fake(period: number | null, pictures: string[] = ['a']): { client: Client; calls: () => number } {
  let calls = 0;
  const client = {
    source: { focus_period_s: period } as Source,
    snapshot: async (): Promise<SnapshotResult> => {
      const picture = pictures[Math.min(calls, pictures.length - 1)]!;
      calls++;
      // The call number stands in for the time, so a test can tell which fetch a held picture came from.
      return { fetched_at: calls, last_modified: null, data: Buffer.from(picture), content_type: 'image/jpeg' };
    },
  } as unknown as Client;
  return { client, calls: () => calls };
}

const camera = (id: number): CatalogCamera => ({ id, source: 'test', image_path: `https://example.test/${String(id)}.jpg` }) as CatalogCamera;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

test('a source with no focus period is never fetched here', async () => {
  const { client, calls } = fake(null);
  const focus = new Focus(() => client);
  assert.equal(focus.claim(1, camera(1)), null);
  await settle();
  assert.equal(calls(), 0);
  assert.equal(focus.frame(1), null);
});

test('a claim fetches at once and again on the focus period, and a new picture replaces the old', async () => {
  const { client, calls } = fake(0.005, ['a', 'a', 'b']);
  const focus = new Focus(() => client);
  assert.equal(focus.claim(1, camera(1)), 0.005);
  await settle();
  assert.ok(calls() >= 3, 'fetched again on the focus period');
  assert.equal(focus.frame(1)?.data.toString(), 'b');
  assert.equal(focus.frame(1)?.ts, 3, 'the picture is dated by the fetch that first brought it');
  focus.stop();
  assert.equal(focus.frame(1), null, 'a stopped focus holds nothing');
});

test('an unchanged picture keeps its timestamp so the panel does not reload it', async () => {
  const { client, calls } = fake(0.005, ['a']);
  const focus = new Focus(() => client);
  focus.claim(1, camera(1));
  await settle();
  assert.ok(calls() >= 2);
  assert.equal(focus.frame(1)?.ts, 1);
  focus.stop();
});

test('more open panels than the cap push out the oldest claim', async () => {
  const { client } = fake(60);
  const focus = new Focus(() => client);
  const now = Date.now() / 1000;
  for (let i = 1; i <= FOCUS.MAX + 1; i++) focus.claim(i, camera(i), now + i);
  assert.equal(focus.size, FOCUS.MAX);
  await settle();
  assert.equal(focus.frame(1), null, 'the oldest claim was released');
  assert.ok(focus.frame(FOCUS.MAX + 1));
  focus.stop();
});

test('a claim nobody restates stops fetching', async () => {
  const { client, calls } = fake(0.005);
  const focus = new Focus(() => client);
  focus.claim(1, camera(1), Date.now() / 1000 - FOCUS.TTL_S - 1);
  await settle();
  assert.equal(calls(), 0, 'already lapsed, so never fetched');
  assert.equal(focus.size, 0);
});
