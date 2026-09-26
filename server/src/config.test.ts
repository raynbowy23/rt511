/** Tests for the local overlay: sources a machine reads under its own arrangement with an agency, kept in data/local/ where git cannot publish them.
 *
 * The failures that matter are a local source quietly replacing a published one, and a local city's data being read from, or written beside, the published files. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { catalogPath, loadRegions, loadSources } from './config.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const source = (name: string) => ({ name, base_url: 'https://example.gov', states: ['XX'], snapshot_content_type: 'image/jpeg', video_auth: false, has_video: false, attribution: name, poll_period_s: 60, token_url: null });
const region = (key: string, src: string) => ({ key, name: key, source: src, bbox: [0, 0, 1, 1], center: null, radius_km: null, limit: null });

function root(local: { sources?: Record<string, unknown>; regions?: unknown[] } | null): string {
  const path = mkdtempSync(join(tmpdir(), 'rt511-config-'));
  roots.push(path);
  mkdirSync(join(path, 'data'), { recursive: true });
  writeFileSync(join(path, 'data', 'sources.json'), JSON.stringify({ user_agent: 'rt511-test', disclaimer: 'test', sources: { published: source('Published') } }));
  writeFileSync(join(path, 'data', 'regions.json'), JSON.stringify([region('city-a', 'published')]));
  if (local) {
    mkdirSync(join(path, 'data', 'local'), { recursive: true });
    if (local.sources) writeFileSync(join(path, 'data', 'local', 'sources.json'), JSON.stringify({ sources: local.sources }));
    if (local.regions) writeFileSync(join(path, 'data', 'local', 'regions.json'), JSON.stringify(local.regions));
  }
  return path;
}

test('without a local folder only the published sources and cities are read', () => {
  const path = root(null);
  assert.deepEqual(Object.keys(loadSources(path).sources), ['published']);
  assert.deepEqual([...loadRegions(path).keys()], ['city-a']);
});

test('local sources and their cities are read beside the published ones', () => {
  const path = root({ sources: { mine: source('Mine') }, regions: [region('city-b', 'mine')] });
  assert.deepEqual(Object.keys(loadSources(path).sources).sort(), ['mine', 'published']);
  assert.deepEqual([...loadRegions(path).keys()].sort(), ['city-a', 'city-b']);
});

test('a local source may not take a published source\'s key', () => {
  const path = root({ sources: { published: source('Imposter') } });
  assert.throws(() => loadSources(path), /redefines published sources published/);
});

test('a local city\'s catalog is read from data/local, and a published city\'s from data', () => {
  const path = root({ sources: { mine: source('Mine') }, regions: [region('city-b', 'mine')] });
  writeFileSync(join(path, 'data', 'local', 'cameras_city-b.json'), '[]');
  assert.equal(catalogPath(path, 'city-b'), join(path, 'data', 'local', 'cameras_city-b.json'));
  assert.equal(catalogPath(path, 'city-a'), join(path, 'data', 'cameras_city-a.json'));
});
