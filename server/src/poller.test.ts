/** Tests for when a camera is polled next.
 *
 * The failure that matters is asking an agency about a picture faster than it makes new ones: a live run measured up to four times the intended rate, because a stale Last-Modified sent every unchanged camera back to a ten-second floor. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARGIN_S, nextPollDelay } from './poller.js';

const PERIOD = 60;
const NOW = 1_790_000_000;
const stamp = (secondsAgo: number): string => new Date((NOW - secondsAgo) * 1000).toUTCString();

test('a fresh picture times the next poll to just after the next one is made', () => {
  assert.equal(nextPollDelay('fresh', stamp(20), PERIOD, NOW), PERIOD + MARGIN_S - 20);
  assert.equal(nextPollDelay('unchanged', stamp(0), PERIOD, NOW), PERIOD + MARGIN_S);
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
