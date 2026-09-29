import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionAxes, CameraState, Graph, ScoresResponse } from '../../shared/src/index.js';
import { AttentionEngine, TUNING } from './attention.js';
import { buildCorridor, createApp } from './app.js';
import type { Client } from './client.js';
import type { CatalogCamera } from './config.js';
import { CORRIDOR, promotionTrigger, selectPromotions, type HeldTrigger } from './corridor.js';
import { Router, type Ctx } from './http.js';
import type { Neighbor } from './jev.js';
import { Poller, SLOW_PERIOD_S, VISIBLE_TTL_S, BUDGET } from './poller.js';
import { testRoot } from './testroot.js';

const camera = (id: number): CatalogCamera => ({ id, region: 'test', source: 'test', image_path: '', roadway: 'I 10', direction: null, location: `camera ${id}`, lat: 30, lon: -84, video_url: null, video_auth: false, link_id: null, source_system: 'test', mile_marker: null });
const axes = (over: Partial<AttentionAxes> = {}): AttentionAxes => ({ anomaly: 0.1, spectacle: 0.1, incident_floor: 0, incident_floor_base: 0, incident: null, jev: null, queue_floor: 0, queue: null, scale_prior: 0.5, scale_prior_source: 'class', scale_amplifier: 1, baseline: 0.01, baseline_sd: null, baseline_n: TUNING.AMBIGUOUS_MIN_SAMPLES, ambiguous_zero: false, gate: null, ...over });
const neighbor = (uid: number, side: Neighbor['side'] = 'upstream', length_m = 100, hops = 1): Neighbor => ({ uid, side, length_m, hops, wave_s: 100, tt_s: 10, roadway: 'I 10', location: `camera ${uid}` });

function poller(): Poller {
  return new Poller(new Map([['test', { source: { poll_period_s: 60 } } as Client]]), new Map([1, 2, 3].map((id) => [id, camera(id)])));
}

test('priority sources form a union and clearing pane leaves graph alone', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const p = poller();
  t.after(() => p.stop());
  p.setPriority('pane', [1, 2]);
  p.setPriority('graph', [2, 3], CORRIDOR.PROMOTE_HOLD_S);
  for (const slot of p.cameras.values()) assert.equal(p.periodFor(slot), 60);
  p.setPriority('pane', []);
  assert.equal(p.periodFor(p.cameras.get(1)!), SLOW_PERIOD_S);
  assert.equal(p.periodFor(p.cameras.get(2)!), 60);
  assert.equal(p.periodFor(p.cameras.get(3)!), 60);
});

test('priority sources expire independently and promotion ignores stretch', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const p = poller();
  t.after(() => p.stop());
  p.setPriority('pane', [1]);
  p.setPriority('graph', [2], CORRIDOR.PROMOTE_HOLD_S);
  p.cameras.get(2)!.stretch = 12;
  t.mock.timers.setTime(1_000_000 + VISIBLE_TTL_S * 1000);
  assert.equal(p.periodFor(p.cameras.get(1)!), SLOW_PERIOD_S);
  assert.equal(p.periodFor(p.cameras.get(2)!), 60);
  t.mock.timers.setTime(1_000_000 + CORRIDOR.PROMOTE_HOLD_S * 1000);
  assert.equal(p.periodFor(p.cameras.get(2)!), 720);
});

test('a new claim pulls an existing slow timer forward including after expiry', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const p = poller();
  t.after(() => p.stop());
  p.watch('test');
  const slot = p.cameras.get(3)!;
  slot.dueAt = 2000;
  p.setPriority('graph', [3], 1);
  assert.equal(slot.dueAt, 1064);
  t.mock.timers.setTime(1_002_000);
  slot.dueAt = 2000;
  p.setPriority('graph', [3], 1);
  assert.equal(slot.dueAt, 1066);
});

test('direct incident, still and established movement trigger promotion', () => {
  assert.deepEqual(promotionTrigger({ axes: axes({ incident_floor: 0.8 }) }), { reason: 'incident', strength: 0.8 });
  assert.deepEqual(promotionTrigger({ axes: axes({ gate: { floor: 0.6, standstill: 0.9, frozen: 0, gated: [], model: 'test' } }) }), { reason: 'still', strength: 0.6 });
  assert.deepEqual(promotionTrigger({ axes: axes({ anomaly: CORRIDOR.PROMOTE_ANOMALY }) }), { reason: 'movement', strength: 0.9 });
});

test('cold profiles, ordinary movement and inferred queues cannot trigger', () => {
  assert.equal(promotionTrigger({ axes: axes({ anomaly: 1, baseline_n: TUNING.AMBIGUOUS_MIN_SAMPLES - 1 }) }), null);
  assert.equal(promotionTrigger({ axes: axes({ anomaly: 0.899 }) }), null);
  assert.equal(promotionTrigger({ axes: axes({ anomaly: 1, queue_floor: 1 }) }), null);
  assert.equal(promotionTrigger({ axes: null }), null);
  assert.equal(promotionTrigger({ axes: axes({ anomaly: null, spectacle: null }) }), null);
});

test('selection orders by strength then side then distance and deduplicates before capping', () => {
  const held = new Map<number, HeldTrigger>([[1, { at: 100, reason: 'incident', strength: 0.8 }], [2, { at: 100, reason: 'movement', strength: 1 }]]);
  const corridor = new Map([[1, [neighbor(10)]], [2, [neighbor(11, 'nearby', 1), neighbor(12, 'downstream', 1), neighbor(13, 'upstream', 200), neighbor(14, 'upstream', 100), neighbor(14), neighbor(99, 'upstream', 1, 3)]]]);
  assert.deepEqual(selectPromotions(held, corridor, 100).map((p) => p.uid), [14, 13, 12, 11, 10]);
  corridor.set(2, Array.from({ length: 50 }, (_, i) => neighbor(i + 100)));
  const promoted = selectPromotions(held, corridor, 100);
  assert.equal(promoted.length, CORRIDOR.PROMOTE_MAX);
  assert.ok(promoted.every((p) => p.because === 2 && p.reason === 'movement'));
});

test('a single trigger holds neighbors for five minutes then releases them without mutation', () => {
  const held = new Map<number, HeldTrigger>([[1, { at: 100, reason: 'still', strength: 0.6 }]]);
  const corridor = new Map([[1, [neighbor(2)]]]);
  assert.equal(selectPromotions(held, corridor, 100 + CORRIDOR.PROMOTE_HOLD_S - 0.001).length, 1);
  assert.deepEqual(selectPromotions(held, corridor, 100 + CORRIDOR.PROMOTE_HOLD_S), []);
  assert.equal(held.size, 1);
});

test('promotion alone extends downstream and nearby walks to two hops', () => {
  const sites = [1, 2, 3, 4, 5].map((id) => ({ id: String(id), lat: 30, lon: -84, is_freeway: true, roadway: 'I 10', mile_marker: null, bearing: null, cameras: [id] }));
  const edges = ([[1, 2, 'freeway'], [2, 3, 'freeway'], [1, 4, 'nearby'], [4, 5, 'nearby']] as const).map(([src, dst, kind]) => ({ src: String(src), dst: String(dst), kind, length_m: 100, tt_s: 10, geometry: [] }));
  const graph: Graph = { meta: { region: 'test' }, cameras: [], sites, edges };
  const maps = new Map([['test', graph]]);
  const cameras = new Map(sites.map((site) => [Number(site.id), camera(Number(site.id))]));
  assert.deepEqual(buildCorridor(['test'], maps, cameras).get(1)!.map((n) => n.uid), [2, 4]);
  assert.deepEqual(buildCorridor(['test'], maps, cameras, true).get(1)!.map((n) => n.uid), [2, 3, 4, 5]);
});

test('scores report applied graph promotions read-only and watch zero clears only pane', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const handlers = new Map<string, (ctx: Ctx) => unknown>();
  t.mock.method(Router.prototype, 'get', (path: string, handler: (ctx: Ctx) => unknown) => handlers.set(path, handler));
  t.mock.method(AttentionEngine.prototype, 'logRanking', () => {});
  const app = createApp({ root: testRoot(), regionKeys: ['des-moines-ia'], pollOnDemand: true, cameras: 'all', concurrency: 1, ring: 2 });
  t.after(() => app.stop());
  t.mock.method(app.poller, 'watch', () => {});
  t.mock.method(app.poller, 'isWatching', () => true);
  t.mock.method(app.poller, 'watchedRegions', () => ['des-moines-ia']);
  t.mock.method(app.jev, 'consider', () => {});
  t.mock.method(app.jev, 'considerGate', () => {});
  const summaries = [...app.poller.cameras].map(([id, slot]) => ({ id, region: slot.camera.region, attention: 0.8, axes: axes({ incident_floor: 0.8 }) } as CameraState));
  t.mock.method(app.poller, 'summaries', () => summaries);
  const priority = t.mock.method(app.poller, 'setPriority');
  const ctx = { query: new URLSearchParams(), params: {} } as Ctx;
  const scores = (): ScoresResponse => handlers.get('/api/scores')!(ctx) as ScoresResponse;
  assert.deepEqual(scores().graph_promoted, []);
  assert.equal(priority.mock.callCount(), 0);
  handlers.get('/api/cameras')!(ctx);
  const promoted = scores().graph_promoted;
  assert.ok(promoted.length > 0);
  assert.ok(promoted.length <= CORRIDOR.PROMOTE_MAX);
  assert.equal(priority.mock.callCount(), 1);
  assert.equal(priority.mock.calls[0]!.arguments[0], 'graph');
  await handlers.get('/api/jev')!({ ...ctx, query: new URLSearchParams('watch=0') });
  assert.deepEqual(priority.mock.calls[1]!.arguments, ['pane', []]);
  assert.deepEqual(scores().graph_promoted, promoted);
  // A promoted camera is polled on the on-screen tier, which since the per-agency budget means no faster than its source's period and no faster than the budget allows across every on-screen camera of that source. It used to be the source's 60 seconds flat; with thirty promoted cameras the budget stretches that, which is the point of the budget.
  const onScreen = app.poller.tierCounts().fast;
  assert.equal(app.poller.periodFor(app.poller.cameras.get(promoted[0]!.uid)!), Math.max(60, onScreen * BUDGET.ON_SCREEN_S));
  for (const state of summaries) state.axes = axes();
  t.mock.timers.setTime(1_299_000);
  handlers.get('/api/cameras')!(ctx);
  assert.deepEqual(scores().graph_promoted, promoted);
  t.mock.timers.setTime(1_300_000);
  handlers.get('/api/cameras')!(ctx);
  assert.deepEqual(scores().graph_promoted, []);
  const count = priority.mock.callCount();
  scores();
  assert.equal(priority.mock.callCount(), count);
});

/** Found on live Florida data. Ordered by trigger strength alone, the two strongest triggers' two-hop neighborhoods used the whole cap and every other event had nothing looked at. */
test('every trigger gets its adjacent cameras before any trigger gets a second hop', () => {
  const now = 1_000;
  const strong = 1000;
  const weak = 2000;
  const held = new Map<number, HeldTrigger>([
    [strong, { reason: 'incident', strength: 1, at: now }],
    [weak, { reason: 'movement', strength: 0.5, at: now }],
  ]);
  const corridor = new Map<number, Neighbor[]>([
    // The strong trigger sits in an interchange: one adjacent camera and a crowd two hops out, more than the cap on its own.
    [strong, [neighbor(1001, 'upstream', 300, 1), ...Array.from({ length: CORRIDOR.PROMOTE_MAX + 5 }, (_, i) => neighbor(1100 + i, 'upstream', 900 + i, 2))]],
    [weak, [neighbor(2001, 'upstream', 400, 1)]],
  ]);
  const chosen = selectPromotions(held, corridor, now).map((promotion) => promotion.uid);
  assert.equal(chosen.length, CORRIDOR.PROMOTE_MAX);
  assert.ok(chosen.includes(1001), 'the strong trigger keeps its adjacent camera');
  assert.ok(chosen.includes(2001), 'the weak trigger still gets its adjacent camera, however crowded the strong one is');
  assert.ok(chosen.indexOf(2001) < chosen.indexOf(1100), "and it comes before anyone's second hop");
});
