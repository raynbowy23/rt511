/** Tests for the attention scorer.
 *
 * Every case here is a failure that would otherwise be silent. A baseline that stopped agreeing with the rolling median on a cold start would change the wall's ranking with nothing to notice it; a scale prior looked up by the wrong id would still return a plausible number for the wrong camera; a floor that ignored an incident's age would pin a camera to the top of the wall for a week. None of them throw.
 *
 * Run with `pnpm --filter @rt511/server test`, which runs the built files: this is Node's own test runner, so there is no test framework in the dependency tree. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCORE, capHeld, combineAttention, isHeld, type CameraState, type ScoreCamera, type Graph, type Incident } from '../../shared/src/index.js';
import { AttentionEngine, TUNING, hourOfWeek, queueFloor, driver, summarizeRegions, aadtPrior, capacityPrior, buildScalePriors, classPrior, incidentFloor, scaleAmplifier } from './attention.js';
import { CORRIDOR, buildQueueIndex } from './corridor.js';
import type { Neighbor } from './jev.js';
import { catalogPath, graphPath, loadAadt, loadCatalog, loadGraph, loadSources } from './config.js';
import { ACTIVITY_FLOOR, CameraSlot, type Frame } from './poller.js';
import { testRoot } from './testroot.js';

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(prefix);
  temporaryDirectories.push(path);
  return path;
}
after(() => { for (const path of temporaryDirectories) rmSync(path, { recursive: true, force: true }); });

// The built tests sit at dist/server/src, four levels under the repository root.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const UID_BLOCK = 10_000_000;

function slot(uid = 1, diffs: number[] = [], diff: number | null = null): CameraSlot {
  const camera = { id: uid, region: 'test', source: 'test', image_path: '', roadway: 'I 10', direction: null, location: 'test', lat: 30.5, lon: -84.3, video_url: null, video_auth: false, link_id: null, source_system: 'test', mile_marker: null };
  const made = new CameraSlot(uid, camera);
  made.diffs.push(...diffs);
  if (diff !== null) {
    const frame: Frame = { ts: 0, last_modified: null, data: Buffer.alloc(0), content_type: 'image/jpeg', brightness: 0.5, diff };
    made.frames.push(frame);
  }
  return made;
}

/** The whole promise of the shrinkage blend: before an hour has any samples of its own, the score is the one the wall already had. */
test('an empty profile scores exactly as activity does', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const rolling = 0.012;
  const { mu, n } = engine.baseline(1, rolling, 0);
  assert.equal(n, 0);
  assert.equal(mu, rolling);

  const camera = slot(1, [0.01, 0.012, 0.014], 0.02);
  const scored = engine.scorer(() => [])(camera, null);
  assert.equal(scored.axes?.anomaly, camera.activity(null));
});

test('cells displace the rolling median in proportion to their samples', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const camera = slot(7);
  const at = Date.UTC(2026, 8, 20, 12) / 1000;
  // Five observations before the one being scored, which is K, so the cell and the median should weigh the same.
  for (let i = 0; i < TUNING.SHRINKAGE_K + 1; i++) {
    camera.frames.length = 0;
    camera.frames.push({ ts: at, last_modified: null, data: Buffer.alloc(0), content_type: 'image/jpeg', brightness: 0.5, diff: 0.04 });
    engine.observe(camera, 'fresh', at);
  }
  const cell = new Date(at * 1000).getDay() * 24 + new Date(at * 1000).getHours();
  const { mu, n } = engine.baseline(7, 0.01, cell);
  assert.equal(n, TUNING.SHRINKAGE_K);
  assert.ok(mu !== null && Math.abs(mu - (0.04 + 0.01) / 2) < 1e-12, `expected the midpoint, got ${String(mu)}`);
});

/** The cell and the rolling median have to measure the same thing, and the median is taken over changed frames only. */
test('a poll that returned identical bytes is not folded into the hour', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const camera = slot(9);
  const at = Date.UTC(2026, 8, 20, 3) / 1000;
  const cell = new Date(at * 1000).getDay() * 24 + new Date(at * 1000).getHours();
  engine.observe(camera, 'unchanged', at);
  engine.observe(camera, 'unchanged', at);
  assert.deepEqual(engine.baseline(9, 0.01, cell), { mu: 0.01, n: 0, cellMean: 0, sd: null });
  assert.equal(engine.ambiguousZeroStats().polls, 0);
});

/** A camera that has just moved must not have its own movement counted as what this hour normally looks like. */
test('the frame being scored is left out of the hour it is scored against', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const camera = slot(21);
  const at = Date.UTC(2026, 8, 20, 9) / 1000;
  const cell = new Date(at * 1000).getDay() * 24 + new Date(at * 1000).getHours();
  const poll = (diff: number) => {
    camera.frames.length = 0;
    camera.frames.push({ ts: at, last_modified: null, data: Buffer.alloc(0), content_type: 'image/jpeg', brightness: 0.5, diff });
    engine.observe(camera, 'fresh', at);
  };
  poll(0.01);
  poll(0.01);
  poll(0.5);
  const { mu, n } = engine.baseline(21, 0.01, cell);
  assert.equal(n, 2);
  assert.ok(mu !== null && mu < 0.02, `the jump belongs to the score, not to the baseline, got ${String(mu)}`);
});

/** The flag has to be judged against the hour as it stood before the frame, or a run of still frames would talk itself out of ever firing. */
test('AMBIGUOUS_ZERO fires on a still frame in an hour that moves, and never on the first', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const camera = slot(11);
  const at = Date.UTC(2026, 8, 20, 17) / 1000;
  const still = () => {
    camera.frames.length = 0;
    camera.frames.push({ ts: at, last_modified: null, data: Buffer.alloc(0), content_type: 'image/jpeg', brightness: 0.5, diff: 0 });
    engine.observe(camera, 'fresh', at);
  };
  still();
  assert.equal(engine.ambiguousZeroStats().flagged, 0, 'an hour with no history expects nothing');

  const busy = () => {
    camera.frames.length = 0;
    camera.frames.push({ ts: at, last_modified: null, data: Buffer.alloc(0), content_type: 'image/jpeg', brightness: 0.5, diff: 0.05 });
    engine.observe(camera, 'fresh', at);
  };
  for (let i = 0; i < TUNING.AMBIGUOUS_MIN_SAMPLES - 2; i++) busy();
  still();
  assert.equal(engine.ambiguousZeroStats().flagged, 0, 'four samples is not yet an hour with a habit');
  busy();
  still();
  assert.equal(engine.ambiguousZeroStats().flagged, 1);
  assert.equal(engine.ambiguousZeroStats().polls, TUNING.AMBIGUOUS_MIN_SAMPLES + 2);
});

test('a still frame is not acted on, only recorded', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const camera = slot(13, [0.05, 0.05, 0.05], 0);
  const scored = engine.scorer(() => [])(camera, null);
  assert.equal(scored.attention, 0);
  assert.equal(scored.axes?.anomaly, 0);
});

test('a camera with no frames yet has no score rather than a score of zero', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const scored = engine.scorer(() => [])(slot(15), null);
  assert.equal(scored.attention, null);
  assert.equal(scored.axes?.anomaly, null);
});

test('traffic counts map onto the whole range and clamp at both ends', () => {
  assert.equal(aadtPrior(0), 0);
  assert.equal(aadtPrior(1000), 0);
  assert.equal(aadtPrior(200_000), 1);
  assert.equal(aadtPrior(253_000), 1);
  assert.ok(aadtPrior(36_226) > aadtPrior(17_000));
  assert.ok(aadtPrior(17_000) > aadtPrior(2_050));
});

test('road classes fall back cleanly, ramps below the road they serve, and an unknown class not at all', () => {
  assert.equal(classPrior('motorway'), 1);
  assert.equal(classPrior('tertiary'), 0.3);
  assert.equal(classPrior('motorway_link'), 0.7);
  assert.equal(classPrior('footway'), null);
  assert.equal(classPrior('footway_link'), null);
  assert.equal(classPrior(null), null);
});

function incident(over: Partial<Incident>): Incident {
  return { id: 'x', type: 'CRASH', location: 'I 10 at US 90', city: null, county: null, lat: 30.5, lon: -84.3, reported_at: 1000, remarks: null, cameras: [], label: null, road_relevant: true, implies_closure: false, ...over };
}

test('the incident floor respects the code, the distance and the age', () => {
  const now = 1000;
  const here = { lat: 30.5, lon: -84.3 };
  const at = (lat: number, lon: number, when: number) => ({ uid: 1, lat, lon, now: when });
  const road = incidentFloor(at(here.lat, here.lon, now), [incident({})]);
  assert.equal(road.value, TUNING.FLOOR_ROAD_RELEVANT);
  assert.equal(road.incident, 'CRASH at I 10 at US 90');

  assert.equal(incidentFloor(at(here.lat, here.lon, now), [incident({ implies_closure: true })]).value, TUNING.FLOOR_CLOSURE);
  // Ordinary police business gets no floor however close it is.
  assert.equal(incidentFloor(at(here.lat, here.lon, now), [incident({ road_relevant: false })]).value, 0);
  // A record with no readable date cannot be aged, so it never lifts anything.
  assert.equal(incidentFloor(at(here.lat, here.lon, now), [incident({ reported_at: null })]).value, 0);

  // A record keeps its full floor for its first hour, then halves every half hour.
  assert.equal(incidentFloor(at(here.lat, here.lon, now + TUNING.INCIDENT_FULL_S), [incident({})]).value, TUNING.FLOOR_ROAD_RELEVANT);
  const halved = incidentFloor(at(here.lat, here.lon, now + TUNING.INCIDENT_FULL_S + TUNING.INCIDENT_HALF_LIFE_S), [incident({})]);
  assert.ok(Math.abs(halved.value - TUNING.FLOOR_ROAD_RELEVANT / 2) < 1e-12);

  // A tenth of a degree of latitude is about eleven kilometers, well outside the linking radius, but the floor is a function of distance rather than of the link, so it tapers to the far factor and stops there.
  const far = incidentFloor(at(here.lat + 0.1, here.lon, now), [incident({})]);
  assert.ok(Math.abs(far.value - TUNING.FLOOR_ROAD_RELEVANT * TUNING.INCIDENT_FAR_FACTOR) < 1e-12);

  // The highest floor wins, not the first or the nearest.
  const both = incidentFloor(at(here.lat, here.lon, now), [incident({ type: 'DEBRIS' }), incident({ type: 'CRASH', implies_closure: true })]);
  assert.equal(both.incident, 'CRASH at I 10 at US 90');
});

test('a floored camera outranks its own picture', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  // A still camera, which would otherwise score nothing at all.
  const camera = slot(17, [0.05, 0.05, 0.05], 0);
  const scored = engine.scorer(() => [incident({ implies_closure: true, reported_at: Date.now() / 1000 })])(camera, null);
  assert.ok((scored.attention as number) >= TUNING.FLOOR_CLOSURE * 0.99, `expected the floor, got ${String(scored.attention)}`);
  assert.equal(scored.axes?.anomaly, 0, 'the floor must not be mistaken for movement');
});

/** A count file for a region, written to a scratch root. No source the project reads publishes counts joined to its cameras yet, so the join is exercised against a fixture in exactly the shape `rt511 aadt` used to write. */
function countsRoot(region: string, natives: number[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rt511-aadt-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'data'));
  const cameras = Object.fromEntries(natives.map((id, i) => [String(id), { aadt: 20_000 + i * 1_000, year: 2025, county: null, truck_pct: null, distance_m: 10, aligned: true }]));
  writeFileSync(join(dir, 'data', `aadt_${region}.json`), JSON.stringify({ region, source: 'fixture', attribution: '', cameras }));
  return dir;
}

/** The count files are keyed by native camera id and the server speaks global ids. Undoing the block wrongly would hand back a real count belonging to a different camera, which nothing downstream could catch. */
test('scale priors are looked up by native id under the global one', () => {
  const region = 'des-moines-ia';
  const graph = loadGraph(graphPath(testRoot(), region));
  const countsAt = countsRoot(region, graph.cameras.slice(0, 5).map((c) => c.id));
  const counts = loadAadt(countsAt, region);
  assert.ok(counts, 'the fixture holds counts');
  const block = [...Object.keys(loadSources(testRoot()).sources)].sort().indexOf('iowadot');
  assert.ok(block >= 0);

  // What app.ts does to the graph before anything else sees it.
  for (const camera of graph.cameras) camera.id = block * UID_BLOCK + camera.id;
  for (const site of graph.sites) site.cameras = site.cameras.map((id) => block * UID_BLOCK + id);

  const priors = buildScalePriors({ regions: [region], graphs: new Map<string, Graph>([[region, graph]]), root: countsAt, uidBlock: UID_BLOCK });
  const native = [...counts.cameras.keys()][0] as number;
  const fact = priors.get(block * UID_BLOCK + native);
  assert.equal(fact?.source, 'aadt');
  assert.equal(fact?.aadt, counts.cameras.get(native)?.aadt);
  assert.equal(fact?.prior, Number(aadtPrior(counts.cameras.get(native)?.aadt as number).toFixed(3)));

  // Every camera in the catalog should have some prior, from a count or from the class it was snapped to.
  const cameras = loadCatalog(catalogPath(testRoot(), region));
  const missing = cameras.filter((c) => !priors.has(block * UID_BLOCK + c.id));
  assert.ok(missing.length / cameras.length < 0.05, `${missing.length} of ${cameras.length} cameras have no prior at all`);
});

/** A city with no count file is the ordinary case and not a fault. */
test('a region with no counts uses capacity or road class', () => {
  const region = 'oakland-ca';
  assert.equal(loadAadt(testRoot(), region), null);
  const graph = loadGraph(graphPath(testRoot(), region));
  const priors = buildScalePriors({ regions: [region], graphs: new Map<string, Graph>([[region, graph]]), root: testRoot(), uidBlock: UID_BLOCK });
  assert.ok(priors.size > 0);
  for (const fact of priors.values()) {
    assert.ok(fact.source === 'capacity' || fact.source === 'class');
    assert.ok(fact.prior > 0 && fact.prior <= 1);
  }
});

test('the noise floor still protects a camera whose baseline is nearly zero', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const camera = slot(19, [0, 0, 0], ACTIVITY_FLOOR / 2);
  const scored = engine.scorer(() => [])(camera, null);
  assert.ok((scored.axes?.anomaly as number) < 1, 'dividing by a zero baseline would saturate every still rural camera');
});


function state(id: number, attention: number): CameraState {
  return { id, region: 'test', period_s: 60, frames: 1, polls: 1, unchanged: 0, unavailable: 0, errors: 0, last_ts: 0, brightness: 0.5, diff: 0.02, activity: attention, attention, axes: { anomaly: attention, spectacle: attention, incident_floor: 0, queue_floor: 0, queue: null, incident_floor_base: 0, incident: null, jev: null, scale_prior: 1, scale_prior_source: 'class', baseline: 0.01, baseline_sd: null, baseline_n: 3, ambiguous_zero: false, gate: null, scale_amplifier: 1 } };
}

test('the decision log rotates by day and writes one line per camera', async () => {
  const dir = temporaryDirectory(join(tmpdir(), 'rt511-log-'));
  const engine = new AttentionEngine(new Map(), dir);
  const monday = Date.UTC(2026, 8, 21, 16) / 1000;
  engine.logRanking([state(1, 0.9), state(2, 0.4)], monday);
  engine.logRanking([state(1, 0.8)], monday + 24 * 3600);
  // The writes are deliberately off the request path, so wait for them rather than for a clock.
  await engine.drain();

  const first = readFileSync(engine.logPath(monday), 'utf8').trim().split('\n');
  assert.equal(first.length, 2);
  const parsed = JSON.parse(first[0] as string) as { id: number; rank: number; attention: number };
  assert.deepEqual([parsed.id, parsed.rank, parsed.attention], [1, 0, 0.9]);
  assert.equal(readdirSync(dir).length, 2, 'the next day is a different file');
});

test('a day that runs away is capped rather than filling the disk', async () => {
  const dir = temporaryDirectory(join(tmpdir(), 'rt511-cap-'));
  const engine = new AttentionEngine(new Map(), dir);
  const now = Date.UTC(2026, 8, 21, 16) / 1000;
  const path = engine.logPath(now);
  writeFileSync(path, '');
  // Sparse, so the test does not actually write thirty-two megabytes.
  truncateSync(path, TUNING.LOG_MAX_BYTES + 1);
  engine.logRanking([state(1, 0.9)], now);
  await engine.drain();
  assert.equal(readFileSync(path, 'utf8').length, TUNING.LOG_MAX_BYTES + 1, 'nothing was appended past the cap');
  // And it stays capped for the rest of the day without stat-ing the file again.
  engine.logRanking([state(1, 0.9)], now + TUNING.LOG_MIN_INTERVAL_S + 1);
  await engine.drain();
  assert.equal(readFileSync(path, 'utf8').length, TUNING.LOG_MAX_BYTES + 1);
});

/** The scale prior's route into the score. It used to sit inside the spectacle axis, where the weighted sum then halved it and no constant said what its real range was. */

test('the scale prior amplifies the visual sum and the range is the one the constants state', () => {
  assert.equal(scaleAmplifier(0), TUNING.SCALE_AMPLIFIER_MIN);
  assert.equal(scaleAmplifier(1), TUNING.SCALE_AMPLIFIER_MAX);
  assert.equal(scaleAmplifier(0.5), (TUNING.SCALE_AMPLIFIER_MIN + TUNING.SCALE_AMPLIFIER_MAX) / 2);
  // A prior outside 0..1 cannot be produced by either source, and if one ever were it would not escape the range.
  assert.equal(scaleAmplifier(9), TUNING.SCALE_AMPLIFIER_MAX);
});

test('an interstate and a side street doing the same thing no longer score the same', () => {
  const priors = new Map([
    [1, { prior: 1, source: 'aadt' as const, aadt: 200_000, distance_m: 10, aligned: true, highway: 'motorway' }],
    [2, { prior: 0.2, source: 'class' as const, aadt: null, distance_m: null, aligned: null, highway: 'residential' }],
  ]);
  const engine = new AttentionEngine(priors, temporaryDirectory(join(tmpdir(), 'rt511-attn-')));
  const score = engine.scorer(() => []);
  const busy = score(slot(1, [0.01, 0.01, 0.01, 0.01, 0.01], 0.02), null);
  const quiet = score(slot(2, [0.01, 0.01, 0.01, 0.01, 0.01], 0.02), null);
  assert.ok(busy.attention !== null && quiet.attention !== null);
  assert.ok((busy.attention as number) > (quiet.attention as number), 'the same movement is worth more on the bigger road');
  // The prior is reported as the amplifier it is, and the axis it used to hide in is now movement alone.
  assert.equal(busy.axes?.scale_amplifier, TUNING.SCALE_AMPLIFIER_MAX);
  assert.equal(busy.axes?.spectacle, busy.axes?.anomaly);
});

/** The zero-motion gate's one effect on the score. Nothing else in the engine may act on the flag. */

test('a still camera the arbiter called stopped traffic reaches the wall', () => {
  const engine = new AttentionEngine(new Map(), temporaryDirectory(join(tmpdir(), 'rt511-attn-')));
  const still = () => slot(1, [0.02, 0.02, 0.02, 0.02, 0.02], 0.0001);
  const without = engine.scorer(() => [])(still(), null);

  engine.gate = () => ({ at: 0, value: 0.6, influence: { standstill: 0.9, floor: 0.6, gated: [], model: 'test' } });
  const with_ = engine.scorer(() => [])(still(), null);

  assert.ok((without.attention ?? 0) < 0.6, 'stillness on its own scores near nothing');
  // A floor of 0.6 places the camera in the upper band, at 0.5 + 0.5 x 0.6.
  assert.equal(with_.attention, combineAttention(0, 0.6));
  assert.ok(isHeld(with_.attention));
  assert.equal(with_.axes?.gate?.standstill, 0.9);
  // The floor is kept apart from an incident's, because one came from a dispatcher and the other from a picture.
  assert.equal(with_.axes?.incident_floor, 0);
});

test('a gate answer that was not acted on changes no score', () => {
  const engine = new AttentionEngine(new Map(), temporaryDirectory(join(tmpdir(), 'rt511-attn-')));
  const before = engine.scorer(() => [])(slot(1, [0.02, 0.02, 0.02, 0.02, 0.02], 0.0001), null);
  engine.gate = () => ({ at: 0, value: 0, influence: { standstill: 0.4, floor: 0, gated: ['standstill'], model: 'test' } });
  const after = engine.scorer(() => [])(slot(1, [0.02, 0.02, 0.02, 0.02, 0.02], 0.0001), null);
  assert.equal(after.attention, before.attention);
  assert.equal(after.axes?.gate?.standstill, 0.4, 'recorded all the same');
});

test('a second look scales movement and never a floor', () => {
  const engine = new AttentionEngine(new Map(), temporaryDirectory(join(tmpdir(), 'rt511-attn-')));
  const busy = () => slot(1, [0.01, 0.01, 0.01, 0.01, 0.01], 0.012);
  const plain = engine.scorer(() => [])(busy(), null);
  engine.review = () => ({ level: 3, levels: 4, confidence: 0.9, factor: 1.25, acted: true, at: 0, model: 'test' });
  const lifted = engine.scorer(() => [])(busy(), null);
  assert.ok((lifted.attention ?? 0) > (plain.attention ?? 0));
  assert.equal(lifted.axes?.review?.factor, 1.25);
  // The baseline stays the equation's own, whatever the look did to the wall.
  assert.equal(lifted.axes?.equation, plain.attention);

  // A stopped-traffic floor stands exactly as it was, however low the look puts the picture.
  engine.gate = () => ({ at: 0, value: 0.6, influence: { standstill: 0.9, floor: 0.6, gated: [], model: 'test' } });
  engine.review = () => ({ level: 0, levels: 4, confidence: 0.9, factor: 0.75, acted: true, at: 0, model: 'test' });
  const floored = engine.scorer(() => [])(slot(2, [0.02, 0.02, 0.02, 0.02, 0.02], 0.0001), null);
  assert.equal(floored.attention, combineAttention(0, 0.6));
});

function scoreAxes(): NonNullable<CameraState['axes']> {
  const engine = new AttentionEngine(new Map(), ROOT);
  return engine.scorer(() => [])(slot(1, [0.01, 0.01, 0.01], 0.01), null).axes!;
}

test('driver names movement when it exceeds both floors', () => {
  const axes = { ...scoreAxes(), anomaly: 0.8, spectacle: 0.8, scale_amplifier: 1, incident_floor: 0.3 };
  assert.equal(driver(axes), 'movement');
});

test('driver names the incident when its floor wins', () => {
  assert.equal(driver({ ...scoreAxes(), incident_floor: 0.9 }), 'incident');
});

test('driver names stopped traffic when its floor wins', () => {
  assert.equal(driver({ ...scoreAxes(), gate: { standstill: 1, floor: 0.9, gated: [], model: 'test' } }), 'still');
});

test('driver gives floors priority over movement on a tie', () => {
  const axes = { ...scoreAxes(), anomaly: 0.6, spectacle: 0.6, scale_amplifier: 1, incident_floor: 0.6 };
  assert.equal(driver(axes), 'incident');
  const gate = { standstill: 1, floor: 0.6, gated: [], model: 'test' };
  assert.equal(driver({ ...axes, incident_floor: 0, gate }), 'still');
  assert.equal(driver({ ...axes, gate }), 'incident');
});

test('region summaries rank all scored cameras and average only the busiest five', () => {
  const axes = scoreAxes();
  const cameras: ScoreCamera[] = [0.1, 0.9, 0.6, 0.7, 0.8, 0.5].map((attention, id) => ({
    id, region: 'one', location: `camera ${id}`, roadway: 'road', attention, diff: 0.01,
    axes: { ...axes, incident_floor: id < 2 ? 0.3 : 0, ambiguous_zero: id === 0 }, driver: 'movement',
  }));
  const before = cameras.map((camera) => camera.id);
  const [one, empty] = summarizeRegions([{ key: 'one', name: 'First city' }, { key: 'empty', name: 'Empty city' }], cameras);
  assert.equal(one?.scored, 6);
  assert.ok(Math.abs(one!.top5_mean - 0.7) < 1e-12);
  assert.deepEqual(one?.top, { id: 1, location: 'camera 1', attention: 0.9 });
  assert.equal(one?.incident_floored, 2);
  assert.equal(one?.still, 1);
  assert.deepEqual(empty, { key: 'empty', name: 'Empty city', scored: 0, top: null, top5_mean: 0, incident_floored: 0, still: 0 });
  assert.deepEqual(cameras.map((camera) => camera.id), before);
});

test('region summaries use available cameras when fewer than five are scored', () => {
  const camera: ScoreCamera = { id: 1, region: 'one', location: 'Only camera', roadway: 'road', attention: 0.4, diff: null, axes: scoreAxes(), driver: 'movement' };
  const [region] = summarizeRegions([{ key: 'one', name: 'One' }], [camera, { ...camera, id: 2, region: 'other', attention: 1 }]);
  assert.equal(region?.scored, 1);
  assert.equal(region?.top5_mean, 0.4);
});

function queueFixture(over: Partial<Incident> = {}) {
  const record = incident({ cameras: [1], reported_at: 1000, ...over });
  const neighbor = (uid: number, length_m: number, side: Neighbor['side'] = 'upstream'): Neighbor => ({ uid, length_m, side, roadway: 'I 10', location: 'test', tt_s: 30, hops: 1, wave_s: side === 'upstream' ? length_m / (CORRIDOR.WAVE_SPEED_KMH / 3.6) : null });
  const corridor = new Map([[1, [neighbor(1, 100), neighbor(2, 1000), neighbor(3, 2000), neighbor(4, CORRIDOR.MAX_UPSTREAM_M), neighbor(5, 100, 'downstream'), neighbor(6, 100, 'nearby')]]]);
  const index = buildQueueIndex([record], corridor, new Map([[1, { lat: record.lat, lon: record.lon }]]));
  return { record, index, floor: (uid: number, age: number) => queueFloor(uid, index.get(uid) ?? [], 1000 + age) };
}

test('an upstream queue starts at zero, rises and reaches its full share at arrival', () => {
  const { floor, record } = queueFixture();
  const wave = 1000 / (CORRIDOR.WAVE_SPEED_KMH / 3.6);
  assert.equal(floor(2, 0).value, 0);
  assert.ok(floor(2, wave / 2).value > 0);
  assert.ok(floor(2, wave).value > floor(2, wave / 2).value);
  for (const age of [wave, wave + 100]) {
    const base = incidentFloor({ uid: 1, lat: record.lat, lon: record.lon, now: 1000 + age }, [record]).value;
    assert.equal(floor(2, age).value, base * TUNING.UPSTREAM_SHARE * 0.8);
    assert.equal(floor(2, age).queue?.reach, 1);
  }
});

test('queue floors shrink with road distance and vanish at the corridor limit', () => {
  const { floor } = queueFixture();
  assert.ok(floor(2, 1500).value > floor(3, 1500).value);
  assert.equal(floor(4, 1500).value, 0);
});

test('an arrived queue holds through the first hour of its record, then decays with the record half-life', () => {
  const { floor } = queueFixture();
  assert.equal(floor(2, TUNING.INCIDENT_FULL_S).value, floor(2, 500).value);
  const late = TUNING.INCIDENT_FULL_S + 100;
  assert.ok(Math.abs(floor(2, late + TUNING.INCIDENT_HALF_LIFE_S).value - floor(2, late).value / 2) < 1e-12);
});

test('a record never propagates a queue to its named cameras', () => {
  const { index, floor } = queueFixture();
  assert.equal(index.has(1), false);
  assert.equal(floor(1, 500).value, 0);
  assert.equal(queueFixture({ cameras: [1, 2] }).floor(2, 500).value, 0);
});

test('downstream and nearby neighbors receive no deterministic queue floor', () => {
  const { floor } = queueFixture();
  assert.equal(floor(5, 500).value, 0);
  assert.equal(floor(6, 500).value, 0);
});

test('non-road records and missing report times infer no queue', () => {
  assert.equal(queueFixture({ road_relevant: false, implies_closure: false }).floor(2, 500).value, 0);
  assert.equal(queueFixture({ reported_at: null }).floor(2, 500).value, 0);
});

test('floor ties prefer incident, then queue, then still, ahead of movement', () => {
  const axes = { ...scoreAxes(), anomaly: 0.6, spectacle: 0.6, scale_amplifier: 1, incident_floor: 0.6, queue_floor: 0.6, gate: { standstill: 1, floor: 0.6, gated: [], model: 'test' } };
  assert.equal(driver(axes), 'incident');
  assert.equal(driver({ ...axes, incident_floor: 0 }), 'queue');
  assert.equal(driver({ ...axes, incident_floor: 0, queue_floor: 0 }), 'still');
});

test('a queue scores an unpolled camera and is carried into the ranking log', async () => {
  const { index } = queueFixture();
  const engine = new AttentionEngine(new Map(), temporaryDirectory(join(tmpdir(), 'rt511-queue-')));
  const scored = engine.scorer(() => [], 1500, index)(slot(2), null);
  // A camera with no picture yet scores from its floor alone, through the same banded rule.
  assert.equal(scored.attention, Number(combineAttention(0, scored.axes?.queue_floor ?? 0).toFixed(3)));
  assert.ok((scored.attention ?? 0) > 0);
  engine.logRanking([{ ...state(2, 0), ...scored }], 1500);
  await engine.drain();
  const logged = JSON.parse(readFileSync(engine.logPath(1500), 'utf8'));
  assert.equal(logged.queue_floor, scored.axes?.queue_floor);
  assert.deepEqual(logged.queue, scored.axes?.queue);
});

test('queue scoring takes the strongest incident and anchor without incident modulation', () => {
  const weak = queueFixture();
  const strong = queueFixture({ implies_closure: true, type: 'CLOSURE' });
  const entries = [...(weak.index.get(2) ?? []), ...(strong.index.get(2) ?? [])];
  const best = queueFloor(2, entries, 1500);
  assert.equal(best.value, strong.floor(2, 500).value);
  assert.equal(best.queue?.incident, 'CLOSURE at I 10 at US 90');
  const engine = new AttentionEngine(new Map(), ROOT);
  engine.modulate = () => ({ value: 0, influence: null });
  const scored = engine.scorer(() => [], 1500, new Map([[2, entries]]))(slot(2), null);
  assert.equal(scored.axes?.queue_floor, Number(best.value.toFixed(3)));
});

test('a chosen queue cannot lower the graph floor and the final attention clamps', () => {
  const { index, floor } = queueFixture();
  const entries = index.get(2) ?? [];
  const low = queueFloor(2, entries, 1500, () => 0.01);
  assert.equal(low.value, floor(2, 500).value);
  assert.equal(low.queue?.jev_chosen, true);
  const engine = new AttentionEngine(new Map(), ROOT);
  engine.chosenQueue = () => 2;
  const scored = engine.scorer(() => [], 1500, index)(slot(2), null);
  assert.equal(scored.attention, 1);
  assert.equal(scored.axes?.queue_floor, 2);
});

const capacitySnap = (over: Partial<import('../../shared/src/index.js').Snap> = {}): import('../../shared/src/index.js').Snap => ({ lat: 0, lon: 0, highway: 'motorway', name: null, ref: null, two_way: false, bearing: 0, distance_m: 0, lanes: 3, maxspeed_kmh: 90, maxspeed_source: 'tag', ...over });

test('capacity uses tagged lanes per direction and fixed logarithmic anchors', () => {
  assert.equal(capacityPrior(capacitySnap({ lanes: 1, maxspeed_kmh: 40 })), 0);
  assert.equal(capacityPrior(capacitySnap({ lanes: 4, maxspeed_kmh: 110 })), 1);
  assert.equal(capacityPrior(capacitySnap({ lanes: 8, maxspeed_kmh: 130 })), 1);
  assert.equal(capacityPrior(capacitySnap({ lanes: 1, maxspeed_kmh: 20 })), 0);
  assert.equal(capacityPrior(capacitySnap({ lanes: 3, two_way: true })), capacityPrior(capacitySnap({ lanes: 2 })));
  assert.ok(capacityPrior(capacitySnap())! > capacityPrior(capacitySnap({ two_way: true }))!);
  assert.equal(capacityPrior(capacitySnap({ lanes: null })), null);
  assert.equal(capacityPrior(capacitySnap({ lanes: 0 })), null);
});

test('AADT precedes capacity, missing lanes use class, and capacity reaches the wire', () => {
  const graph = loadGraph(graphPath(testRoot(), 'des-moines-ia'));
  const countsAt = countsRoot('des-moines-ia', [graph.cameras[0]!.id]);
  const counts = loadAadt(countsAt, 'des-moines-ia')!;
  const counted = graph.cameras.find(c => counts.cameras.has(c.id))!;
  const cameras = [counted, ...[9000001, 9000002, 9000003].map(id => ({ ...counted, id }))].map(c => ({ ...c, site: 'fixture' }));
  const snaps = [capacitySnap(), capacitySnap(), capacitySnap({ lanes: null }), capacitySnap({ lanes: null, highway: 'unknown' })];
  const fixture: Graph = { ...graph, cameras, sites: [{ ...graph.sites[0]!, id: 'fixture', cameras: cameras.map(c => c.id), snaps }] };
  const priors = buildScalePriors({ regions: ['des-moines-ia'], graphs: new Map([['des-moines-ia', fixture]]), root: countsAt, uidBlock: UID_BLOCK });
  assert.equal(priors.get(counted.id)?.source, 'aadt');
  assert.equal(priors.get(counted.id)?.prior, Number(aadtPrior(counts.cameras.get(counted.id)!.aadt).toFixed(3)));
  assert.equal(priors.get(9000001)?.source, 'capacity');
  assert.equal(priors.get(9000002)?.source, 'class');
  const engine = new AttentionEngine(priors, ROOT);
  assert.equal(engine.scalePrior(9000003).source, 'default');
  const wire = JSON.parse(JSON.stringify(engine.scorer(() => [])(slot(9000001, [.01, .01, .01], .02), null)));
  assert.equal(wire.axes.scale_prior_source, 'capacity');
});

test('Welford sample deviation agrees with two-pass variance before each newest frame', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const values = [.01, .03, .02, .08, .004];
  const at = 1790000000;
  const previous: number[] = [];
  // Captured from the original scorer before adding variance, with the same fixed prior and frame sequence. The fourth frame saturated at 1 there; with the warm-up cap a camera holding five differences tops out at 0.75. Since the lexicographic bands, a camera with no floor scores in the lower band, at half its movement term, so the attention column is half what it was ([.134, .45, .294, .6, .05] before the bands), while anomaly is unchanged. Removing warmupCap restores an anomaly of 1 on the fourth frame.
  const fixture = [[.167, .067], [.562, .225], [.368, .147], [.75, .3], [.062, .025]];
  for (const [i, value] of values.entries()) {
    const camera = slot(1, [.01, .02, .03, .04, .05], value);
    engine.observe(camera, 'fresh', at);
    const scored = engine.scorer(() => [], at)(camera, null);
    assert.equal(scored.axes?.baseline_n, previous.length);
    if (previous.length < 2) assert.equal(scored.axes?.baseline_sd, null);
    else {
      const mean = previous.reduce((a, b) => a + b, 0) / previous.length;
      const sd = Math.sqrt(previous.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (previous.length - 1));
      assert.ok(Math.abs(scored.axes!.baseline_sd! - sd) < 1e-14);
    }
    assert.deepEqual([scored.axes?.anomaly, scored.attention], fixture[i]);
    previous.push(value);
  }
  assert.equal(engine.scorer(() => [], at + 3600)(slot(1, [], .02), .01).axes?.baseline_sd, null);
});

test('ranking logs expose the cell standard deviation', async () => {
  const engine = new AttentionEngine(new Map(), temporaryDirectory(join(tmpdir(), 'rt511-sd-')));
  const at = 1790000000;
  for (const diff of [.01, .03, .5]) engine.observe(slot(1, [], diff), 'fresh', at);
  const scored = engine.scorer(() => [], at)(slot(1, [], .5), .01);
  engine.logRanking([{ ...state(1, 1), ...scored }], at);
  await engine.drain();
  const logged = JSON.parse(readFileSync(engine.logPath(at), 'utf8').trim());
  assert.equal(logged.baseline_sd, scored.axes?.baseline_sd);
  assert.ok(Math.abs(logged.baseline_sd - Math.sqrt(.0002)) < 1e-14);
});

/** The lexicographic bands. Consequence must outrank movement however busy the moving camera is, and the cap must stop consequence from taking every prominent place. */

test('a floor outranks movement however busy the moving camera is', () => {
  // An ordinary busy freeway, its movement term clamped at 1, against a confirmed standstill and an arrived queue.
  const busy = combineAttention(1.4, 0);
  assert.ok(combineAttention(0, 0.6) > busy);
  assert.ok(combineAttention(0, TUNING.UPSTREAM_SHARE * TUNING.FLOOR_ROAD_RELEVANT) > busy);
  assert.equal(busy, SCORE.BAND);
  // Within a band, the larger of movement and floor sets the level.
  assert.ok(combineAttention(0.9, 0.6) > combineAttention(0.2, 0.6));
  // A floor below the hold threshold counts only against movement, in the lower band.
  assert.equal(combineAttention(0, SCORE.FLOOR_HOLD_MIN / 2), (SCORE.BAND * SCORE.FLOOR_HOLD_MIN) / 2);
  assert.ok(!isHeld(combineAttention(0, SCORE.FLOOR_HOLD_MIN / 2)));
});

test('the cap keeps at most the given number of held cameras ahead of the rest', () => {
  const held = [0.9, 0.85, 0.8, 0.75].map((attention, i) => ({ id: i, attention, movement: 0.1 }));
  const moving = [{ id: 10, attention: 0.45, movement: 0.9 }];
  const ranked = capHeld([...held, ...moving], 2);
  assert.deepEqual(ranked.slice(0, 3).map((entry) => entry.id), [0, 1, 10]);
  // Held cameras beyond the cap compete on movement alone.
  assert.equal(ranked[3]?.attention, SCORE.BAND * 0.1);
  assert.equal(ranked[3]?.capped, true);
});

test('an event is not folded into the usual for its hour', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const camera = slot(31);
  const at = Date.UTC(2026, 8, 20, 12) / 1000;
  const cell = hourOfWeek(at);
  const feed = (diff: number, when: number): void => {
    camera.frames.length = 0;
    camera.frames.push({ ts: when, last_modified: null, data: Buffer.alloc(0), content_type: 'image/jpeg', brightness: 0.5, diff });
    camera.diffs.push(diff);
    if (camera.diffs.length > 24) camera.diffs.shift();
    engine.observe(camera, 'fresh', when);
  };
  for (let i = 0; i < 10; i++) feed(0.01, at + i);
  // Three times the usual for this hour, twenty times over. The cell keeps its mean, so the camera still reads as unusual. Folded in, the cell would have risen to about 0.023 and the anomaly fallen to about 0.6.
  for (let i = 0; i < 20; i++) feed(0.03, at + 20 + i);
  assert.ok(Math.abs(engine.baseline(31, null, cell).cellMean - 0.01) < 1e-12);
  assert.ok((engine.scorer(() => [], at + 40)(camera, null).axes?.anomaly ?? 0) >= 0.85);
  // An ordinary picture is learned as before.
  feed(0.011, at + 60);
  feed(0.011, at + 61);
  assert.ok(engine.baseline(31, null, cell).cellMean > 0.01);
});

test('an unusual level that lasts is accepted as the new usual', () => {
  const engine = new AttentionEngine(new Map(), ROOT);
  const camera = slot(32);
  const at = Date.UTC(2026, 8, 20, 12) / 1000;
  const cell = hourOfWeek(at);
  const feed = (diff: number, when: number): void => {
    camera.frames.length = 0;
    camera.frames.push({ ts: when, last_modified: null, data: Buffer.alloc(0), content_type: 'image/jpeg', brightness: 0.5, diff });
    engine.observe(camera, 'fresh', when);
  };
  for (let i = 0; i < 10; i++) feed(0.01, at + i);
  feed(0.03, at + 100);
  feed(0.03, at + 101);
  assert.ok(Math.abs(engine.baseline(32, null, cell).cellMean - 0.01) < 1e-12);
  // The same hour a week later, with the run of unusual pictures unbroken since, is past LEARN_RESUME_S and is folded in.
  feed(0.03, at + 7 * 86400);
  feed(0.03, at + 7 * 86400 + 1);
  assert.ok(engine.baseline(32, null, cell).cellMean > 0.01);
});
