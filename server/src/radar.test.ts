import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionAxes, BoardResponse, CameraState } from '../../shared/src/index.js';
import { createApp } from './app.js';
import { AttentionEngine } from './attention.js';
import { BOARD_MAX_AGE_S, BOARD_SIZE, buildBoard } from './board.js';
import { Client } from './client.js';
import type { CatalogCamera } from './config.js';
import { CORRIDOR, promotionTrigger, selectPromotions } from './corridor.js';
import { Router, type Ctx } from './http.js';
import { Poller, type PollResult } from './poller.js';
import { RADAR, selectRadarAnchors } from './radar.js';
import { testRoot } from './testroot.js';

const camera = (id: number, region = 'test'): CatalogCamera => ({ id, region, source: 'test', image_path: '', roadway: 'I 10', direction: null, location: `camera ${id}`, lat: 30, lon: -84, video_url: null, video_auth: false, link_id: null, source_system: 'test', mile_marker: null });
const catalog = (n: number) => new Map(Array.from({ length: n }, (_, i) => [i + 1, camera(i + 1)]));
const makePoller = () => new Poller(new Map([['test', { source: { poll_period_s: 60 } } as Client]]), catalog(25));
const axes: AttentionAxes = { anomaly: 0.1, spectacle: 0.1, incident_floor: 0.8, incident_floor_base: 0.8, incident: 'test', jev: null, queue_floor: 0, queue: null, scale_prior: 0.5, scale_prior_source: 'class', scale_amplifier: 1, baseline: 0.01, baseline_sd: null, baseline_n: 10, ambiguous_zero: false, gate: null };

// Timer callbacks only touch fake snapshots in these tests, and application tests replace snapshot access as a second guard against network use.
test('radar orders by descending prior then camera id and rotates with wrap', () => {
  const cameras = catalog(25);
  const prior = (uid: number) => uid >= 20 ? 1 : 0.5;
  const order = [...cameras.keys()].sort((a, b) => prior(b) - prior(a) || a - b);
  const select = (elapsed: number) => selectRadarAnchors(cameras, new Set(), prior, elapsed);
  assert.deepEqual(select(0), order.slice(0, 10));
  assert.deepEqual(select(RADAR.RADAR_ROTATE_S - 1), order.slice(0, 10));
  assert.deepEqual(select(RADAR.RADAR_ROTATE_S), order.slice(10, 20));
  assert.deepEqual(select(RADAR.RADAR_ROTATE_S * 2), [...order.slice(20), ...order.slice(0, 5)]);
  assert.deepEqual(select(RADAR.RADAR_ROTATE_S * 5), order.slice(0, 10));
  assert.equal(selectRadarAnchors(catalog(3), new Set(), prior, RADAR.RADAR_ROTATE_S).length, 3);
});

test('watched regions contribute no radar anchors', () => {
  const cameras = catalog(25);
  cameras.set(30, camera(30, 'other'));
  assert.deepEqual(selectRadarAnchors(cameras, new Set(['test']), () => 1, 0), [30]);
});

test('radar budget for eighteen regions is 0.3 requests per second', () => {
  assert.equal(18 * RADAR.RADAR_PER_REGION / RADAR.RADAR_PERIOD_S, 0.3);
});

test('unwatched anchors ignore stretch and visibility while other cameras stay idle', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const p = makePoller();
  t.after(() => p.stop());
  p.setRadar([1]);
  const anchor = p.cameras.get(1)!;
  anchor.stretch = 100;
  p.setVisible('test', [1, 2]);
  assert.equal(p.tierOf(anchor), 'radar');
  assert.equal(p.periodFor(anchor), RADAR.RADAR_PERIOD_S);
  assert.equal(p.tierOf(p.cameras.get(2)!), 'idle');
  assert.equal(p.cameras.get(2)!.timer, null);
  p.watch('test');
  assert.equal(p.tierOf(anchor), 'fast');
  assert.equal(p.isRadar(1), false);
});

test('a radar trip schedules corridor neighbors in an unwatched region at the source period', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const p = makePoller();
  t.after(() => p.stop());
  p.setRadar([1]);
  const trigger = promotionTrigger({ axes })!;
  const held = new Map([[1, { ...trigger, at: 1000 }]]);
  const graph = new Map([[1, [{ uid: 2, side: 'upstream' as const, length_m: 100, hops: 1, wave_s: 10, tt_s: 10, roadway: 'I 10', location: 'next' }]]]);
  const ids = selectPromotions(held, graph, 1000).map((entry) => entry.uid);
  p.setPriority('graph', ids, CORRIDOR.PROMOTE_HOLD_S);
  const next = p.cameras.get(2)!;
  next.stretch = 100;
  assert.deepEqual(ids, [2]);
  assert.equal(p.isWatching('test'), false);
  assert.equal(p.tierOf(next), 'fast');
  assert.equal(p.periodFor(next), 60);
  assert.ok(next.timer);
  assert.equal(next.dueAt, 1064);
  t.mock.timers.setTime(1_300_000);
  assert.equal(p.tierOf(next), 'idle');
  assert.deepEqual(selectPromotions(held, graph, 1300), []);
});

for (const outcome of ['fresh', 'unchanged', 'not_modified', 'unavailable', 'error'] as const) {
  test(`radar scheduling never shortens its period for ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    const p = makePoller();
    t.after(() => p.stop());
    const slot = p.cameras.get(1)!;
    slot.last_modified_seen = new Date(0).toUTCString();
    const poll = t.mock.method(p, 'pollOnce', async (): Promise<PollResult> => {
      if (outcome === 'error') throw new Error('offline fixture');
      return outcome;
    });
    p.setRadar([1]);
    t.mock.timers.tick(RADAR.RADAR_PERIOD_S * 1000);
    await Promise.resolve();
    assert.equal(poll.mock.callCount(), 1);
    assert.ok(slot.dueAt >= Date.now() / 1000 + RADAR.RADAR_PERIOD_S);
    t.mock.timers.tick((RADAR.RADAR_PERIOD_S - 1) * 1000);
    assert.equal(poll.mock.callCount(), 1);
  });
}

test('radar spreads startup across the period and restating anchors does not reschedule them', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const p = makePoller();
  t.after(() => p.stop());
  p.setRadar([1, 2, 3]);
  const due = [1, 2, 3].map((id) => p.cameras.get(id)!.dueAt);
  assert.deepEqual(due, [1200, 1400, 1600]);
  p.setRadar([1, 2, 3]);
  assert.deepEqual([1, 2, 3].map((id) => p.cameras.get(id)!.dueAt), due);
});

test('/api/board filters, caps and shares wall scores without viewer or priority side effects', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const handlers = new Map<string, (ctx: Ctx) => unknown>();
  t.mock.method(Router.prototype, 'get', (path: string, handler: (ctx: Ctx) => unknown) => handlers.set(path, handler));
  t.mock.method(Client.prototype, 'snapshot', async () => { throw new Error('network forbidden'); });
  const app = createApp({ root: testRoot(), regionKeys: ['des-moines-ia', 'oakland-ca'], pollOnDemand: true, cameras: 'all', concurrency: 1, ring: 2 });
  t.after(() => app.stop());
  const all = [...app.poller.cameras].map(([id, slot], i) => ({ id, region: slot.camera.region, polls: 2, attention: (i % 100) / 100, axes } as CameraState));
  const cold = all[0]!;
  cold.polls = 0;
  cold.attention = 1;
  app.poller.setRadar([all[1]!.id]);
  t.mock.method(app.poller, 'summaries', () => all);
  const priority = t.mock.method(app.poller, 'setPriority');
  const visible = t.mock.method(app.poller, 'setVisible');
  const watch = t.mock.method(app.poller, 'watch');
  const unwatch = t.mock.method(app.poller, 'unwatch');
  const watched = t.mock.method(app.poller, 'watchedRegions');
  const board = (query = '') => handlers.get('/api/board')!({ query: new URLSearchParams(query) } as Ctx) as BoardResponse;
  const national = board();
  assert.equal(national.cameras.length, BOARD_SIZE);
  assert.ok(!national.cameras.some((camera) => camera.id === cold.id));
  all[1]!.attention = 1;
  assert.equal(board().cameras[0]!.radar, true);
  assert.deepEqual(national.states, ['CA', 'IA']);
  assert.equal(national.regions.length, 2);
  assert.ok(national.cameras.every((camera, i, list) => i === 0 || list[i - 1]!.attention >= camera.attention));
  for (const camera of national.cameras) assert.equal(camera.attention, all.find((state) => state.id === camera.id)!.attention);
  assert.ok(board('state=CA').cameras.every((camera) => camera.state === 'CA'));
  assert.equal(board('state=CA').cameras.length, BOARD_SIZE);
  assert.ok(board('region=des-moines-ia').cameras.every((camera) => camera.region === 'des-moines-ia'));
  assert.deepEqual(board('state=CA&region=des-moines-ia').cameras, []);
  assert.deepEqual(board('state=ZZ').cameras, []);
  assert.equal(priority.mock.callCount(), 0);
  assert.equal(visible.mock.callCount(), 0);
  assert.equal(watch.mock.callCount(), 0);
  assert.equal(unwatch.mock.callCount(), 0);
  assert.equal(watched.mock.callCount(), 0, 'followViewer reads watchedRegions, so it was not invoked');
});

test('server interval selects anchors and promotes without any viewer and stops with the poller', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  t.mock.method(Client.prototype, 'snapshot', async () => { throw new Error('network forbidden'); });
  t.mock.method(AttentionEngine.prototype, 'scalePrior', () => ({ prior: 1, source: 'default' as const }));
  const app = createApp({ root: testRoot(), regionKeys: ['des-moines-ia'], pollOnDemand: true, cameras: 'all', concurrency: 1, ring: 2 });
  t.after(() => app.stop());
  const all = [...app.poller.cameras].map(([id, slot]) => ({ id, region: slot.camera.region, attention: 0.8, axes } as CameraState));
  t.mock.method(app.poller, 'summaries', () => all);
  const radar = t.mock.method(app.poller, 'setRadar');
  const priority = t.mock.method(app.poller, 'setPriority');
  t.mock.timers.tick(RADAR.RADAR_TICK_S * 1000);
  assert.equal(radar.mock.callCount(), 1);
  assert.equal(radar.mock.calls[0]!.arguments[0].length, RADAR.RADAR_PER_REGION);
  assert.equal(priority.mock.callCount(), 1);
  const [source, ids] = priority.mock.calls[0]!.arguments;
  assert.equal(source, 'graph');
  assert.ok(ids.length > 0 && ids.length <= CORRIDOR.PROMOTE_MAX);
  assert.ok(ids.every((id) => app.poller.tierOf(app.poller.cameras.get(id)!) === 'fast'));
  assert.deepEqual(app.poller.watchedRegions(), []);
  app.poller.stop();
  t.mock.timers.tick(RADAR.RADAR_TICK_S * 1000);
  assert.equal(radar.mock.callCount(), 1);
});

/** Two regressions found in review. Closing a city had stopped dropping its replay frames, and the board ranked cameras whose pictures had stopped arriving. */

const staleAxes = (): AttentionAxes => ({ anomaly: 0.8, spectacle: 0.8, incident_floor: 0, incident_floor_base: 0, incident: null, jev: null, queue_floor: 0, queue: null, scale_prior: 0.5, scale_prior_source: 'class', scale_amplifier: 1, baseline: 0.01, baseline_sd: null, baseline_n: 5, ambiguous_zero: false, gate: null });
const boardState = (id: number, last_ts: number | null, attention: number): CameraState => ({ id, region: 'test', period_s: 60, frames: 1, polls: 3, unchanged: 0, unavailable: 0, errors: 0, last_ts, brightness: 0.5, diff: 0.02, activity: attention, attention, axes: staleAxes() });
const boardCamera = (id: number): CatalogCamera => ({ id, region: 'test', source: 'test', image_path: '', roadway: 'I 10', direction: null, location: `camera ${id}`, lat: 30, lon: -84, video_url: null, video_auth: false, link_id: null, source_system: 'test', mile_marker: null });

test('the board leaves off cameras whose pictures have stopped arriving', () => {
  const now = 10_000;
  const catalog = new Map([1, 2, 3].map((id) => [id, boardCamera(id)]));
  const regions: BoardResponse['regions'] = [{ key: 'test', name: 'Test', state: 'FL' } as BoardResponse['regions'][number]];
  const states = [
    boardState(1, now - 60, 0.4),
    boardState(2, now - BOARD_MAX_AGE_S - 1, 0.9),
    boardState(3, null, 0.95),
  ];
  const board = buildBoard(states, catalog, regions, () => false, null, null, now);
  assert.deepEqual(board.cameras.map((camera) => camera.id), [1], 'a stale score outranking a live one is exactly what must not happen');
});

test('closing a city keeps the newest picture and its differences and drops the replay ring', () => {
  const p = new Poller(new Map([['test', { source: { poll_period_s: 60 } } as unknown as Client]]), new Map([[1, boardCamera(1)]]));
  (p as unknown as { watching: Set<string> }).watching.add('test');
  const slot = p.cameras.get(1)!;
  for (let i = 0; i < 10; i++) slot.frames.push({ ts: i, last_modified: null, data: Buffer.alloc(1000), content_type: 'image/jpeg', brightness: 0.5, diff: 0.01 });
  slot.diffs.push(0.01, 0.02, 0.03);
  p.unwatch('test');
  assert.equal(slot.frames.length, 1);
  assert.equal(slot.frames[0]?.ts, 9, 'the newest one');
  assert.equal(slot.diffs.length, 3, 'differences are kept, so a radar anchor carries on without a gap');
});
