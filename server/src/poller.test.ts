/** Tests for when a camera is polled next.
 *
 * The failure that matters is asking an agency about a picture faster than it makes new ones: a live run measured up to four times the intended rate, because a stale Last-Modified sent every unchanged camera back to a ten-second floor. */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Client } from './client.js';
import type { CatalogCamera } from './config.js';
import { BUDGET, MARGIN_S, nextPollDelay, Poller } from './poller.js';

const PERIOD = 60;
const NOW = 1_790_000_000;
const stamp = (secondsAgo: number): string => new Date((NOW - secondsAgo) * 1000).toUTCString();

test('a fresh picture times the next poll to just after the next one is made', () => {
  assert.equal(nextPollDelay('fresh', stamp(20), PERIOD, NOW), PERIOD + MARGIN_S - 20);
  assert.equal(nextPollDelay('unchanged', stamp(0), PERIOD, NOW), PERIOD + MARGIN_S);
});

test('a picture made near the end of its period still catches the next one', () => {
  // Due again in six seconds. A full wait would land after the picture after it; the short floor lands just after this one.
  assert.equal(nextPollDelay('fresh', stamp(PERIOD - 2), PERIOD, NOW), 10);
});

test('a picture older than a period waits a full period rather than falling to the floor', () => {
  assert.equal(nextPollDelay('unchanged', stamp(PERIOD * 3), PERIOD, NOW), PERIOD + MARGIN_S);
  assert.equal(nextPollDelay('fresh', stamp(3600), PERIOD, NOW), PERIOD + MARGIN_S);
});

test('a 304 or a missing time waits a full period', () => {
  assert.equal(nextPollDelay('not_modified', stamp(5), PERIOD, NOW), PERIOD + MARGIN_S);
  assert.equal(nextPollDelay('fresh', null, PERIOD, NOW), PERIOD + MARGIN_S);
  assert.equal(nextPollDelay('fresh', 'not a date', PERIOD, NOW), PERIOD + MARGIN_S);
});

test('a camera with no feed backs off for five minutes', () => {
  assert.equal(nextPollDelay('unavailable', null, PERIOD, NOW), 300);
});

test('over any stretch, polls average no more than one per period', () => {
  // A camera whose picture never changes: each poll sees the same old time.
  let t = NOW;
  let polls = 0;
  while (t < NOW + 3600) {
    t += nextPollDelay('unchanged', stamp(7200), PERIOD, t);
    polls++;
  }
  assert.ok(polls <= 3600 / PERIOD, `expected at most ${String(3600 / PERIOD)} polls in an hour, got ${String(polls)}`);
});

test('a whole wall coming into view at once never asks faster than the budget in any minute', async () => {
  // The live trace in Columbus: 80 cameras, 52 of them on screen, all due within the first minute and then together again every period, at up to three times the budget per minute while the average held.
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW * 1000 });
  try {
    const asked: number[] = [];
    const client = { source: { poll_period_s: 60 }, snapshot: () => { asked.push(Date.now() / 1000); return Promise.resolve('not_modified'); } } as unknown as Client;
    const camera = (id: number): CatalogCamera => ({ id, region: 'city', source: 'ohgo', image_path: '', roadway: 'I 70', direction: null, location: `camera ${String(id)}`, lat: 40, lon: -83, video_url: null, video_auth: false, link_id: null, source_system: 'ohgo', mile_marker: null });
    const poller = new Poller(new Map([['ohgo', client]]), new Map(Array.from({ length: 80 }, (_, i) => [i + 1, camera(i + 1)])));
    const onScreen = Array.from({ length: 52 }, (_, i) => i + 1);
    poller.setVisible('city', onScreen);
    poller.watch('city');
    for (let s = 0; s < 30 * 60; s++) {
      if (s % 10 === 0) poller.setVisible('city', onScreen);
      mock.timers.tick(1000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    poller.stop();
    const allowed = 60 / BUDGET.ON_SCREEN_S + 60 / BUDGET.OFF_SCREEN_S;
    let worst = 0;
    for (const at of asked) worst = Math.max(worst, asked.filter((t) => t >= at && t < at + 60).length);
    assert.ok(worst <= allowed, `at most ${String(allowed)} requests in any minute, got ${String(worst)}`);
    // 52 on screen every 52 x 5 s and 28 off screen every 600 s is about 440 requests in 30 minutes. Pacing must not starve the wall.
    assert.ok(asked.length >= 300, `the budget is still used, ${String(asked.length)} requests in 30 minutes`);
  } finally {
    mock.timers.reset();
  }
});
