/** Tests for the city pulse: a median of recent pictures per city, nothing for a city too thin to say anything, and a day that survives a restart. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PULSE, Pulse } from './pulse.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rt511-pulse-'));
  dirs.push(dir);
  return dir;
};

const NOW = new Date(2026, 8, 24, 8, 0).getTime() / 1000;

test('a city minute is the median of its recent pictures, and a thin or stale city records nothing', () => {
  const pulse = new Pulse(scratch(), NOW);
  const recorded = pulse.record(
    [
      { region: 'a', lastTs: NOW - 30, diff: 0.01 },
      { region: 'a', lastTs: NOW - 30, diff: 0.03 },
      { region: 'a', lastTs: NOW - 30, diff: 0.9 },
      { region: 'b', lastTs: NOW - 30, diff: 0.02 },
      { region: 'c', lastTs: NOW - PULSE.RECENT_S - 1, diff: 0.02 },
      { region: 'c', lastTs: NOW - PULSE.RECENT_S - 1, diff: 0.02 },
    ],
    NOW,
  );
  assert.deepEqual(recorded.map((r) => r.region), ['a']);
  assert.equal(recorded[0]!.point.diff, 0.03, 'one flag in the wind does not become the city');
  assert.equal(recorded[0]!.point.n, 3);
});

test('a restart picks the day back up from its file', async () => {
  const dir = scratch();
  const first = new Pulse(dir, NOW);
  first.record([{ region: 'a', lastTs: NOW - 10, diff: 0.02 }, { region: 'a', lastTs: NOW - 10, diff: 0.04 }], NOW);
  await first.drain();
  const again = new Pulse(dir, NOW + 120);
  assert.equal(again.today().a?.length, 1);
  assert.equal(again.today().a?.[0]?.diff, 0.03);
});
