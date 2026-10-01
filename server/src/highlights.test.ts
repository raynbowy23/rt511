import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionAxes, CameraState, HighlightsResponse, Incident } from '../../shared/src/index.js';
import { createApp } from './app.js';
import { AttentionEngine } from './attention.js';
import { Client } from './client.js';
import { cameraName, composeBrief, HIGHLIGHT_MIN_ATTENTION, HIGHLIGHTS_SIZE, labelText, placeName, QUEUE_MENTION_MIN, selectHighlights } from './highlights.js';
import { JEV, type JevVerdict } from './jev.js';
import { Router, type Ctx } from './http.js';
import { testRoot } from './testroot.js';

const now = 10_000;
const axes: AttentionAxes = { anomaly: 1, spectacle: 1, incident_floor: 0, incident_floor_base: 0, incident: null, jev: null, queue_floor: 0, queue: null, scale_prior: 0.5, scale_prior_source: 'class', scale_amplifier: 1, baseline: 0.01, baseline_sd: null, baseline_n: 100, ambiguous_zero: false, gate: null };
const camera = (id: number) => ({ region: id === 9 ? 'other' : 'test', location: id === 3 ? 'NW 12th Ave' : 'I-4 at Ivanhoe Blvd', roadway: 'I-4', lat: 25, lon: -80 });
const catalog = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, camera(i + 1)]));
const state = (id: number, attention = 0.9, patch: Partial<AttentionAxes> = {}): CameraState => ({ id, region: camera(id).region, polls: 2, frames: 2, period_s: 60, unchanged: 0, unavailable: 0, errors: 0, last_ts: now - 30, brightness: 0.5, diff: 0.023, activity: 0.9, attention, axes: { ...axes, ...patch } });
const incident: Incident = { id: 'dispatch-1', type: 'CRASH', label: 'Vehicle crash', location: 'SR-836 eastbound at 17th Ave', city: null, county: null, lat: 25, lon: -80, reported_at: now - 720, remarks: null, cameras: [1, 2], road_relevant: true, implies_closure: false };
const verdict = (probability: number): JevVerdict => ({ incidentId: incident.id, key: '', evidence: '', at: now - 60, supported: probability, cleared: probability, score: 1, scoreLevels: 3, scoreConfidence: 0, chosen: null, chosenConfidence: 0, model: 'fixture' });
const select = (states: CameraState[], incidents: Incident[] = [], verdicts = new Map<string, JevVerdict>(), gates = new Map<number, number>(), region: string | null = null) => selectHighlights(states, catalog, incidents, verdicts, gates, now, region, new Map([[1, [{ uid: 2, side: 'upstream' }, { uid: 3, side: 'upstream' }, { uid: 4, side: 'downstream' }]]]));

test('highlights dedupe incidents and choose their highest attention camera', () => {
  const result = select([state(1, 0.6, { incident_floor: 0.6 }), state(2, 0.9, { incident_floor: 0.6 })], [incident, incident]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.camera, 2);
  assert.equal(result[0]!.at, incident.reported_at);
});

test('highlights name the furthest upstream queue camera and road distance', () => {
  const queue = { source: 'incident' as const, incident: `${incident.type} at ${incident.location}`, anchor: 1, length_m: 800, reach: 1, jev_chosen: false };
  const best = state(1, 0.9, { incident_floor: 0.7 });
  best.diff = 0.004;
  const result = select([best, state(2, 0.2, { queue_floor: 0.5, queue }), state(3, 0.1, { queue_floor: 0.5, queue: { ...queue, length_m: 1700 } }), state(4, 0.1, { queue_floor: 0.5, queue: { ...queue, length_m: 2500, jev_chosen: true } })], [incident]);
  assert.equal(result[0]!.brief, 'Vehicle crash on SR-836 eastbound at 17th Ave, reported 12 minutes ago. The camera picture is quieter than usual. A queue could now reach NW 12th Ave, 1.7 km back.');
});

test('only Jev answers that passed their gates appear in incident briefs', () => {
  const states = [state(1, 0.9, { incident_floor: 0.7 })];
  const low = select(states, [incident], new Map([[incident.id, verdict(JEV.NOUL_THRESHOLD - 0.001)]]))[0]!.brief;
  assert.doesNotMatch(low, /Likely already cleared|Cameras support the report/);
  const high = select(states, [incident], new Map([[incident.id, verdict(JEV.NOUL_THRESHOLD)]]))[0]!.brief;
  assert.match(high, /Likely already cleared/);
  assert.match(high, /Cameras support the report/);
});

test('stopped traffic uses the acted-on floor and confirmation time', () => {
  const gate = { standstill: 1, floor: 0.7, gated: [], model: 'fixture' };
  const result = select([state(1, 0.9, { gate })], [], new Map(), new Map([[1, now - 240]]));
  assert.equal(result[0]!.kind, 'stopped');
  assert.equal(result[0]!.at, now - 240);
  assert.equal(result[0]!.brief, 'Traffic stopped near I-4 at Ivanhoe Blvd, where this hour usually moves. Confirmed from the picture 4 minutes ago.');
  assert.equal(select([state(1, 0.9, { anomaly: 0, gate: { ...gate, floor: 0 } })]).length, 0);
});

test('unusual movement requires promotion and excludes incident and gate floors', () => {
  assert.equal(select([state(1)])[0]!.brief, 'Unusual movement near I-4 at Ivanhoe Blvd. The picture shows about 2.3 times its usual movement for this hour.');
  assert.equal(select([state(1)])[0]!.kind, 'movement');
  assert.equal(select([state(1, 0.9, { incident_floor: 0.1 })]).length, 0);
  assert.equal(select([state(1, 0.9, { baseline_n: 0 })]).length, 0);
  assert.equal(select([state(1, 0.9, { gate: { standstill: 1, floor: 0.1, gated: [], model: 'fixture' } })]).length, 0);
});

test('highlights rank by attention, cap at five and scope to the region', () => {
  const states = Array.from({ length: 9 }, (_, i) => state(i + 1, (i + 1) / 10));
  const result = select(states);
  assert.equal(result.length, HIGHLIGHTS_SIZE);
  assert.deepEqual(result.map((item) => item.camera), [9, 8, 7, 6, 5]);
  assert.equal(select(states, [], new Map(), new Map(), 'other').length, 1);
});

test('generated briefs contain no colons, semicolons or em dashes', () => {
  for (const kind of ['incident', 'stopped', 'movement'] as const) {
    const brief = composeBrief({ kind, state: state(1), camera: { ...camera(1), location: 'I-4: road; exit—ramp' }, at: now, incident: { ...incident, label: 'Crash: blocked; lanes—closed', location: 'road: exit' }, verdict: verdict(1), queue: { location: 'upstream: exit; ramp—north', length_m: 1700 } }, now);
    assert.doesNotMatch(brief, /[:;—]/);
  }
});

test('/api/highlights is read-only and includes radar cameras without a region', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: now * 1000 });
  const handlers = new Map<string, (ctx: Ctx) => unknown>();
  t.mock.method(Router.prototype, 'get', (path: string, handler: (ctx: Ctx) => unknown) => handlers.set(path, handler));
  t.mock.method(Client.prototype, 'snapshot', async () => { throw new Error('network forbidden'); });
  const root = testRoot();
  const app = createApp({ root, regionKeys: ['des-moines-ia', 'oakland-ca'], pollOnDemand: true, cameras: 'all', concurrency: 1, ring: 2 });
  t.after(() => app.stop());
  const entries = [...app.poller.cameras];
  const first = entries[0]!;
  const other = entries.find(([, slot]) => slot.camera.region !== first[1].camera.region)!;
  app.poller.setRadar([first[0], other[0]]);
  t.mock.method(app.poller, 'summaries', () => [state(first[0]), state(other[0])]);
  const spies = [t.mock.method(app.poller, 'setPriority'), t.mock.method(app.poller, 'setVisible'), t.mock.method(app.poller, 'watch'), t.mock.method(app.poller, 'unwatch'), t.mock.method(app.jev, 'consider'), t.mock.method(app.jev, 'considerGate'), t.mock.method(AttentionEngine.prototype, 'logRanking')];
  const calls = app.jev.stats().calls;
  const read = (query = '') => handlers.get('/api/highlights')!({ query: new URLSearchParams(query) } as Ctx) as HighlightsResponse;
  assert.equal(read().highlights.length, 2);
  assert.equal(read(`region=${first[1].camera.region}`).highlights.length, 1);
  assert.equal(app.poller.isRadar(first[0]), true);
  assert.equal(app.jev.stats().calls, calls);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});


/** Found on the live Florida feed, where the fixtures above had used tidy names. */

test('dispatch shorthand and capitals read as ordinary text', () => {
  assert.equal(placeName('I-95 NB x[US-1/DOWNTOWN]'), 'I-95 northbound at US-1 / Downtown');
  assert.equal(placeName('SR-836 EB  x[17TH AVE]'), 'SR-836 eastbound at 17th Ave');
  assert.equal(placeName('DON SHULA EXPY NB (SR-874 NB) x[128TH ST]'), 'Don Shula Expy northbound (SR-874 northbound) at 128th St');
  assert.equal(placeName('I-4 at Ivanhoe Blvd'), 'I-4 at Ivanhoe Blvd', 'a name that already reads naturally is left alone');
  assert.equal(labelText('VEHICLE CRASH W/INJURIES AND ROADBLOCK'), 'Vehicle crash with injuries and roadblock');
  assert.equal(labelText('Crash with injuries'), 'Crash with injuries');
  assert.equal(cameraName('206 SR-112 at NW 17th Ave'), 'SR-112 at NW 17th Ave', 'the device number means nothing to a reader');
  assert.equal(cameraName('I-195 at I-95/ SR-112'), 'I-195 at I-95 / SR-112');
});

test('a decayed record is not a highlight', () => {
  // The live run ranked a three-hour-old record at 0.015 into the ribbon because nothing else was happening.
  assert.equal(select([state(1, 0.015, { incident_floor: 0.015 })], [incident]).length, 0);
  assert.equal(select([state(1, HIGHLIGHT_MIN_ATTENTION, { incident_floor: HIGHLIGHT_MIN_ATTENTION })], [incident]).length, 1);
});

test('a queue is claimed only where its floor supports the claim', () => {
  const queue = { source: 'incident' as const, incident: `${incident.type} at ${incident.location}`, anchor: 1, length_m: 4900, reach: 1, jev_chosen: false };
  const best = state(1, 0.9, { incident_floor: 0.7 });
  const faint = select([best, state(3, 0.1, { queue_floor: QUEUE_MENTION_MIN - 0.001, queue })], [incident])[0]!.brief;
  assert.doesNotMatch(faint, /A queue could now reach/, 'the live brief claimed a queue 4.9 km back behind a floor of almost nothing');
  const real = select([best, state(3, 0.1, { queue_floor: QUEUE_MENTION_MIN, queue })], [incident])[0]!.brief;
  assert.match(real, /A queue could now reach NW 12th Ave, 4.9 km back/);
});
