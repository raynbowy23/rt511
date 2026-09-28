/** Tests for the arbiter.
 *
 * The failure that matters here is not a wrong answer, it is a wrong answer being acted on, or a network fault reaching the wall. Every case below is one of those: a gate that stopped holding, a floor that moved when nothing had been asked, a key that goes missing, a response that comes back malformed, a record asked about twice.
 *
 * Nothing here touches the network. The one call that would is injected, and the one test that exercises the real SDK hands it a `fetch` of its own. */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Incident } from '../../shared/src/index.js';
import { incidentFloor, queueFloor, TUNING } from './attention.js';
import { buildQueueIndex } from './corridor.js';
import { round } from './config.js';
import { JEV, JevArbiter, ago, buildGateState, buildReviewState, kendallTau, buildState, choiceOptions, createAsk, createGateAsk, picture, type AskResult, type CameraTelemetry, type GateAskResult, type GateCandidate, type Neighbour, type ReviewAsk, type ReviewCandidate } from './jev.js';

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(prefix);
  temporaryDirectories.push(path);
  return path;
}
const arbiters: JevArbiter[] = [];
function makeArbiter(...args: ConstructorParameters<typeof JevArbiter>): JevArbiter {
  const arbiter = new JevArbiter(...args);
  arbiters.push(arbiter);
  return arbiter;
}
after(async () => {
  await Promise.all(arbiters.map((arbiter) => arbiter.drain()));
  for (const path of temporaryDirectories) rmSync(path, { recursive: true, force: true }); });

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'FHP-1',
    type: 'S4R',
    location: 'SR-836 WB x[SR-826 NB]',
    city: null,
    county: 'MIAMI-DADE',
    lat: 25.78,
    lon: -80.32,
    reported_at: 1000,
    remarks: 'TWO VEHICLES, LEFT LANE BLOCKED',
    cameras: [30004214, 30004221],
    label: 'Crash with injuries',
    road_relevant: true,
    implies_closure: true,
    ...over,
  };
}

function telemetry(uid: number, over: Partial<CameraTelemetry> = {}): CameraTelemetry {
  return { uid, roadway: 'SR-836', location: 'SR-836 WB at 87th Ave', lat: 25.781, lon: -80.321, diff: 0.002, activity: 0.1, baseline: 0.02, baselineN: 9, ambiguousZero: true, lastTs: 900, ...over };
}

const answer = (over: Partial<AskResult['verdict']> = {}): AskResult => ({
  verdict: { supported: 0.9, cleared: 0.05, score: 3, scoreLevels: 4, scoreConfidence: 0.8, chosen: 30004214, chosenConfidence: 0.7, model: 'jev-1.13.0', ...over },
  usage: { input_tokens: 700, output_tokens: 60 },
  raw: {},
  latencyMs: 400,
});

const noCameras = () => [];
const dir = (): string => temporaryDirectory(join(tmpdir(), 'rt511-jev-'));

/** The whole promise: with no key the wall behaves exactly as it did before this file existed. */
test('with no key nothing is asked and no floor moves', async () => {
  const arbiter = makeArbiter(null, dir());
  assert.equal(arbiter.enabled, false);
  arbiter.consider([incident()], () => telemetry(30004214), noCameras);
  await arbiter.drain();
  assert.deepEqual(arbiter.modulate(incident(), 30004214, 0.9), { value: 0.9, influence: null });
  assert.equal(arbiter.stats().calls, 0);
});

test('a call that fails leaves the deterministic floor exactly where it was', async () => {
  let asked = 0;
  const arbiter = makeArbiter(async () => {
    asked++;
    throw Object.assign(new Error('nope'), { name: 'APIConnectionError' });
  }, dir());
  arbiter.consider([incident()], (uid) => telemetry(uid), noCameras);
  await arbiter.drain();
  // The rejection is handled inside the arbiter; nothing above it ever sees a promise.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked, 1);
  assert.equal(arbiter.errors, 1);
  assert.deepEqual(arbiter.modulate(incident(), 30004214, 0.9), { value: 0.9, influence: null });
});

test('an unchanged record is asked about once, an edited one again', async () => {
  let asked = 0;
  const arbiter = makeArbiter(async () => {
    asked++;
    return answer();
  }, dir());
  const ask = async (record: Incident, at: number) => {
    arbiter.consider([record], (uid) => telemetry(uid), noCameras, at);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  await ask(incident(), 1000);
  await ask(incident(), 1010);
  await ask(incident(), 1200);
  assert.equal(asked, 1, 'the same record must never be asked about twice');

  // The feed publishes no update timestamp, so the record's own content is the version.
  await ask(incident({ remarks: 'TWO VEHICLES, NOW ON THE SHOULDER' }), 1210);
  assert.equal(asked, 2);

  // And the old verdict does not carry over to the edited record.
  assert.equal(arbiter.verdictFor(incident({ remarks: 'SOMETHING ELSE ENTIRELY' })), null);
});

test('an incident no floor could touch is never asked about', async () => {
  let asked = 0;
  const arbiter = makeArbiter(async () => {
    asked++;
    return answer();
  }, dir());
  arbiter.consider([incident({ road_relevant: false, implies_closure: false })], (uid) => telemetry(uid), noCameras, 1000);
  arbiter.consider([incident({ id: 'FHP-2', cameras: [] })], (uid) => telemetry(uid), noCameras, 1000);
  arbiter.consider([incident({ id: 'FHP-3' })], () => null, noCameras, 1000);
  // A camera that is polled but has not returned a picture yet, which is every camera in the first minute of a run.
  arbiter.consider([incident({ id: 'FHP-4' })], (uid) => telemetry(uid, { diff: null, lastTs: null }), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked, 0, 'ordinary police business, no linked camera, no polled camera and no picture yet each cost nothing');

  // And the one waiting on a picture is asked as soon as there is one, rather than being remembered as asked.
  arbiter.consider([incident({ id: 'FHP-4' })], (uid) => telemetry(uid), noCameras, 1001);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked, 1);
});

test('a feed that suddenly lists everything cannot become a call for everything', async () => {
  let asked = 0;
  const arbiter = makeArbiter(async () => {
    asked++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return answer();
  }, dir());
  const many = Array.from({ length: 50 }, (_, i) => incident({ id: `FHP-${String(i)}` }));
  arbiter.consider(many, (uid) => telemetry(uid), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked, JEV.MAX_IN_FLIGHT, 'the rest wait for a later pass rather than going out at once');
});

test('a confident answer moves the floor and an unconfident one does not', async () => {
  const arbiter = makeArbiter(async () => answer({ scoreConfidence: 0.1, chosenConfidence: 0.1, supported: 0.4 }), dir());
  arbiter.consider([incident()], (uid) => telemetry(uid), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const gated = arbiter.modulate(incident(), 30004214, 0.6);
  assert.equal(gated.value, 0.6, 'every gate closed, so the deterministic floor stands');
  assert.deepEqual(gated.influence?.gated, ['cleared', 'screen', 'supported', 'camera']);
  assert.equal(gated.influence?.multiplier, 1);
});

test('the top of the rubric lifts a floor and the bottom lowers it', async () => {
  const top = makeArbiter(async () => answer({ score: 3, scoreLevels: 4, scoreConfidence: 0.9, supported: 0.1, chosen: null }), dir());
  top.consider([incident()], (uid) => telemetry(uid), noCameras, 1000);
  const bottom = makeArbiter(async () => answer({ score: 0, scoreLevels: 4, scoreConfidence: 0.9, supported: 0.1, chosen: null }), dir());
  bottom.consider([incident()], (uid) => telemetry(uid), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(top.modulate(incident(), 30004214, 0.4).value, round3(0.4 * (1 + JEV.SCORE_SWING)));
  assert.equal(bottom.modulate(incident(), 30004214, 0.4).value, round3(0.4 * (1 - JEV.SCORE_SWING)));
});

/** The direct answer to a roadblock the feed has been listing for a hundred and seventy days. */
test('a cleared incident collapses its floor', async () => {
  const arbiter = makeArbiter(async () => answer({ cleared: 0.95, score: 0, scoreConfidence: 0.2, supported: 0.2, chosen: null }), dir());
  arbiter.consider([incident()], (uid) => telemetry(uid), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = arbiter.modulate(incident(), 30004214, 0.9);
  assert.equal(after.value, round3(0.9 * JEV.CLEARED_RESIDUE));
  assert.ok(!after.influence?.gated.includes('cleared'));
});

test('an unsure cleared answer takes nothing away', async () => {
  const arbiter = makeArbiter(async () => answer({ cleared: JEV.NOUL_THRESHOLD - 0.01, score: 1.5, scoreLevels: 4, scoreConfidence: 0.2, supported: 0.2, chosen: null }), dir());
  arbiter.consider([incident()], (uid) => telemetry(uid), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(arbiter.modulate(incident(), 30004214, 0.9).value, 0.9);
});

test('the chosen camera gains and the others keep most of what they had', async () => {
  const arbiter = makeArbiter(async () => answer({ chosen: 30004214, chosenConfidence: 0.8, score: 1.5, scoreLevels: 4, scoreConfidence: 0.2, supported: 0.2 }), dir());
  arbiter.consider([incident()], (uid) => telemetry(uid), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(arbiter.modulate(incident(), 30004214, 0.4).value, round3(0.4 * JEV.CHOSEN_GAIN));
  assert.equal(arbiter.modulate(incident(), 30004221, 0.4).value, round3(0.4 * JEV.CHOSEN_OTHERS));
});

test('a camera with no floor of its own is never given one', async () => {
  const arbiter = makeArbiter(async () => answer(), dir());
  arbiter.consider([incident()], (uid) => telemetry(uid), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(arbiter.modulate(incident(), 30004214, 0), { value: 0, influence: null }, 'modulation scales a floor, it does not create one');
});

test('every call is logged with its answers and its token usage', async () => {
  const where = dir();
  const arbiter = makeArbiter(async () => ({ ...answer(), raw: { cleared: { type: 'noul', noul: 0.05 } } }), where);
  arbiter.consider([incident()], (uid) => telemetry(uid), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await arbiter.drain();
  const lines = readFileSync(join(where, `jev-${localDay()}.jsonl`), 'utf8').trim().split('\n');
  const header = JSON.parse(lines[0] as string) as { kind: string; version: number };
  assert.equal(header.kind, 'rubric', 'the questions belong at the top of the file, not on every line');
  assert.equal(header.version, JEV.RUBRIC_VERSION);
  const call = JSON.parse(lines[1] as string) as { kind: string; incident: string; usage: { input_tokens: number }; answers: unknown; model: string };
  assert.equal(call.kind, 'call');
  assert.equal(call.incident, 'FHP-1');
  assert.equal(call.usage.input_tokens, 700);
  assert.equal(call.model, 'jev-1.13.0');
  assert.deepEqual(call.answers, { cleared: { type: 'noul', noul: 0.05 } });
  assert.equal(arbiter.stats().input_tokens, 700);
});

/** The model is documented to read dates as text rather than as ordered quantities, so it is handed the arithmetic already done. */
test('the state carries no raw timestamps and no numbers the model would have to compare', () => {
  const state = buildState(incident(), [telemetry(30004214)], [{ uid: 30004299, roadway: 'SR-836', location: 'at 97th Ave', side: 'upstream', length_m: 1200, tt_s: 48, hops: 1, wave_s: 288 }], 1000 + 9 * 60);
  const text = JSON.stringify(state);
  assert.ok(text.includes('9 minutes ago'), 'the age is a phrase');
  assert.ok(!text.includes('1000'), 'and the epoch second is nowhere in it');
  assert.deepEqual(Object.keys(state), ['dispatch_record', 'cameras_the_record_names', 'nearby_cameras_on_the_same_corridor']);
  // The dispatcher's words are the one thing in here nobody on this project wrote, and they are carried as they came.
  assert.equal((state.dispatch_record as { dispatcher_remarks: string }).dispatcher_remarks, 'TWO VEHICLES, LEFT LANE BLOCKED');
  assert.ok(text.includes('on the approach to the reported location'));
});

test('a still camera in an hour that moves is described as such', () => {
  assert.equal(picture(telemetry(1, { diff: 0.001, baseline: 0.02 })).summary, 'almost perfectly still, where it is usually moving');
  assert.equal(picture(telemetry(1, { diff: 0.05, baseline: 0.02 })).summary, 'changing far more than it usually does at this hour');
  assert.equal(picture(telemetry(1, { diff: null })).summary, 'no picture yet');
  assert.equal(picture(telemetry(1, { baseline: null })).times_usual, null);
});

test('ages read as words', () => {
  assert.equal(ago(30), 'less than two minutes ago');
  assert.equal(ago(9 * 60), '9 minutes ago');
  assert.equal(ago(3 * 3600), '3 hours ago');
  assert.equal(ago(171 * 24 * 3600), '171 days ago');
});

test('the cameras the record names come before the speculative ones', () => {
  const named = [telemetry(30004214), telemetry(30004221)];
  const neighbours: Neighbour[] = [
    { uid: 30004299, roadway: 'SR-836', location: 'at 97th Ave', side: 'upstream', length_m: 1200, tt_s: 48, hops: 1, wave_s: 288 },
    { uid: 30004300, roadway: 'SR-836', location: 'at 57th Ave', side: 'downstream', length_m: 900, tt_s: 36, hops: 1, wave_s: null },
  ];
  const options = choiceOptions(incident(), named, neighbours);
  assert.deepEqual(Object.keys(options), ['30004214', '30004221', '30004299', '30004300']);
  assert.ok(options['30004214']?.startsWith('Named by the record.'));
  assert.ok(options['30004299']?.includes('on the approach to it'));
  assert.ok(Object.keys(choiceOptions(incident(), named, Array.from({ length: 30 }, (_, i) => ({ ...(neighbours[0] as Neighbour), uid: 40000000 + i }))) ).length <= JEV.MAX_OPTIONS);
});

/** A response that is not the shape the questions asked for is a failure, not a verdict of zero. This is the one test that drives the real SDK, with its own fetch. */
test('a malformed response is a failure rather than a verdict', async () => {
  const body = JSON.stringify({ model: 'jev-1.13.0', answers: { supported: { type: 'noul' } }, usage: { input_tokens: 1, output_tokens: 1 } });
  const ask = createAsk('not-a-real-key', {
    retry: { maxRetries: 0 },
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const arbiter = makeArbiter(ask, dir());
  arbiter.consider([incident()], (uid) => telemetry(uid), noCameras, 1000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(arbiter.errors, 1);
  assert.equal(arbiter.verdictFor(incident()), null);
  assert.deepEqual(arbiter.modulate(incident(), 30004214, 0.9), { value: 0.9, influence: null });
});

/** What the SDK actually puts on the wire, checked without going anywhere near the network. */
test('the request carries the four questions, the state and the model', async () => {
  let sent: { url: string; body: unknown; auth: string | null } | null = null;
  const ask = createAsk('test-key-value', {
    retry: { maxRetries: 0 },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      sent = {
        url: String(input),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get('authorization'),
      };
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            supported: { type: 'noul', noul: 0.9 },
            cleared: { type: 'noul', noul: 0.1 },
            screen: { type: 'score', score: 2.5, confidence: 0.7, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' }, probabilities: { 0: 0, 1: 0, 2: 0.5, 3: 0.5 } },
            camera: { type: 'choice', choice: '30004214', confidence: 0.6, probabilities: { 30004214: 0.8, 30004221: 0.2 } },
          },
          usage: { input_tokens: 700, output_tokens: 60 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const result = await ask({ dispatch_record: {} }, { 30004214: 'one', 30004221: 'two' });
  const request = sent as unknown as { url: string; body: { model: string; questions: Record<string, { type: string }> }; auth: string | null };
  assert.equal(request.body.model, JEV.MODEL);
  assert.deepEqual(Object.keys(request.body.questions).sort(), ['camera', 'cleared', 'screen', 'supported']);
  assert.equal(request.body.questions.screen?.type, 'score');
  assert.equal(request.auth, 'Bearer test-key-value');
  // The level count comes from the legend the answer carries, not from the rubric here, so an edit in one place cannot silently rescale the other.
  assert.equal(result.verdict.scoreLevels, 4);
  assert.equal(result.verdict.chosen, 30004214);
  assert.equal(result.usage.input_tokens, 700);
});

test('a choice naming something that was not offered is discarded', async () => {
  const ask = createAsk('test-key-value', {
    retry: { maxRetries: 0 },
    fetch: async () =>
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            supported: { type: 'noul', noul: 0.9 },
            cleared: { type: 'noul', noul: 0.1 },
            screen: { type: 'score', score: 2, confidence: 0.7, legend: { 0: 'a', 1: 'b', 2: 'c' }, probabilities: { 0: 0, 1: 0, 2: 1 } },
            camera: { type: 'choice', choice: '999', confidence: 0.9, probabilities: { 999: 1 } },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
  const result = await ask({}, { 30004214: 'one' });
  assert.equal(result.verdict.chosen, null, 'an id nobody offered cannot be acted on');
});

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function localDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The guard that keeps a score from being formed against a state with nothing in it. */
test('an incident is not asked about until one of its cameras has a picture', async () => {
  let asked = 0;
  const arbiter = makeArbiter(async () => {
    asked++;
    return answer();
  }, dir());
  arbiter.consider([incident({ id: 'FHP-9' })], (uid) => telemetry(uid, uid === upstream.uid ? {} : { diff: null, lastTs: null }), () => [upstream], 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked, 0);
  // One picture between them is enough: the questions are about the record, and the one camera that can see is what the rubric is scored against.
  arbiter.consider([incident({ id: 'FHP-9' })], (uid) => telemetry(uid, uid === 30004214 ? {} : { diff: null }), noCameras, 1001);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked, 1);
});

/** The zero-motion gate. What it must never do is lower anything, and what it must never be is loud: a region-wide feed fault should cost a handful of calls rather than one per camera. */

const gateAnswer = (over: Partial<GateAskResult['verdict']> = {}): GateAskResult => ({
  verdict: { standstill: 0.9, frozen: 0.05, model: 'jev-1.13.0', ...over },
  usage: { input_tokens: 400, output_tokens: 20 },
  raw: {},
  latencyMs: 300,
});

function candidate(uid: number, over: Partial<CameraTelemetry> = {}): GateCandidate {
  return { camera: telemetry(uid, over), neighbours: [], incidentNearby: false, vehicles: null };
}

test('a confident standstill puts a floor under a still camera and a frozen feed does not', async () => {
  const arbiter = makeArbiter(null, dir(), async () => gateAnswer());
  arbiter.considerGate([candidate(1)]);
  await arbiter.drain();
  const held = arbiter.gateFloor(1);
  assert.equal(held?.value, JEV.GRIDLOCK_FLOOR);
  assert.deepEqual(held?.influence.gated, ['frozen']);

  // The same stillness, read as a dead picture, is worth nothing at all, and takes the standstill answer with it.
  const dead = makeArbiter(null, dir(), async () => gateAnswer({ standstill: 0.9, frozen: 0.95 }));
  dead.considerGate([candidate(2)]);
  await dead.drain();
  const nothing = dead.gateFloor(2);
  assert.equal(nothing?.value, 0);
  assert.deepEqual(nothing?.influence.gated, ['standstill']);
});

test('an unsure standstill is recorded and never acted on', async () => {
  const arbiter = makeArbiter(null, dir(), async () => gateAnswer({ standstill: JEV.NOUL_THRESHOLD - 0.01 }));
  arbiter.considerGate([candidate(3)]);
  await arbiter.drain();
  const held = arbiter.gateFloor(3);
  assert.equal(held?.value, 0);
  assert.equal(held?.influence.standstill, round(JEV.NOUL_THRESHOLD - 0.01, 2));
});

test('a gate floor expires rather than pinning a camera for the rest of the run', async () => {
  const arbiter = makeArbiter(null, dir(), async () => gateAnswer());
  arbiter.considerGate([candidate(4)]);
  await arbiter.drain();
  const now = Date.now() / 1000;
  assert.equal(arbiter.gateFloor(4, now)?.value, JEV.GRIDLOCK_FLOOR);
  assert.equal(arbiter.gateFloor(4, now + JEV.GATE_HOLD_S + 1), null);
});

test('a camera with no picture or no baseline is never asked about', async () => {
  let asked = 0;
  const arbiter = makeArbiter(null, dir(), async () => {
    asked++;
    return gateAnswer();
  });
  arbiter.considerGate([candidate(5, { diff: null }), candidate(6, { baseline: null }), candidate(7, { ambiguousZero: false })]);
  await arbiter.drain();
  assert.equal(asked, 0, 'a gap in our own coverage is not evidence of stopped traffic');
});

test('a feed fault across a whole city costs a few calls rather than one per camera', async () => {
  let asked = 0;
  const arbiter = makeArbiter(null, dir(), async () => {
    asked++;
    return gateAnswer();
  });
  arbiter.considerGate(Array.from({ length: 200 }, (_, i) => candidate(100 + i)));
  await arbiter.drain();
  // Two caps stand between a broken city and a large bill, and within one synchronous pass the in-flight one is the tighter of them: nothing this pass started has come back yet.
  assert.equal(asked, Math.min(JEV.MAX_IN_FLIGHT, JEV.MAX_GATE_PER_PASS));
  assert.ok(asked < 200);
});

test('the same still camera is not asked about again inside the re-ask window', async () => {
  let asked = 0;
  const arbiter = makeArbiter(null, dir(), async () => {
    asked++;
    return gateAnswer();
  });
  const now = Date.now() / 1000;
  arbiter.considerGate([candidate(8)], now);
  await arbiter.drain();
  arbiter.considerGate([candidate(8)], now + JEV.GATE_REASK_AFTER_S - 1);
  await arbiter.drain();
  assert.equal(asked, 1);
  arbiter.considerGate([candidate(8)], now + JEV.GATE_REASK_AFTER_S + 1);
  await arbiter.drain();
  assert.equal(asked, 2);
});

test('the gate state describes the corridor and carries no raw timestamps', () => {
  const state = buildGateState(
    { camera: telemetry(9, { diff: 0.0005, baseline: 0.03 }), neighbours: [{ uid: 10, roadway: 'I-95', location: 'at NW 62nd St', side: 'upstream', length_m: 1500, tt_s: 60, hops: 2, wave_s: 360 }], incidentNearby: false, vehicles: null },
    1000 + 120,
  );
  const text = JSON.stringify(state);
  assert.ok(text.includes('on the approach to this camera'));
  assert.ok(text.includes('almost perfectly still, where it is usually moving'));
  assert.ok(!text.includes('1000'), 'the epoch second is nowhere in it');
});

test('the gate state carries the detector count, and says so when there is none rather than reading as an empty road', () => {
  const counted = buildGateState({ ...candidate(11), vehicles: { vehicles: 7, by_class: { car: 6, truck: 1 }, confidences: [0.9], model: 'yolo26n', latency_ms: 20 } }, 1000) as { camera: Record<string, unknown> };
  assert.equal(counted.camera.vehicles_a_detector_counted_in_this_picture, 7);
  assert.deepEqual(counted.camera.vehicle_types_counted, { car: 6, truck: 1 });
  const empty = buildGateState({ ...candidate(12), vehicles: { vehicles: 0, by_class: {}, confidences: [], model: 'yolo26n', latency_ms: 20 } }, 1000) as { camera: Record<string, unknown> };
  assert.equal(empty.camera.vehicles_a_detector_counted_in_this_picture, 0);
  const none = buildGateState(candidate(13), 1000) as { camera: Record<string, unknown> };
  assert.equal(none.camera.vehicles_a_detector_counted_in_this_picture, 'not counted');
  assert.equal(none.camera.vehicle_types_counted, null);
});

test('the gate request carries two nouls and nothing else', async () => {
  let sent: { body: unknown; auth: string | null } | null = null;
  const askGate = createGateAsk('test-key-value', {
    retry: { maxRetries: 0 },
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      sent = { body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') };
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { standstill: { type: 'noul', noul: 0.91 }, frozen: { type: 'noul', noul: 0.04 } },
          usage: { input_tokens: 400, output_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const result = await askGate({ camera: {} });
  const request = sent as unknown as { body: { model: string; questions: Record<string, { type: string }> }; auth: string | null };
  assert.equal(request.body.model, JEV.MODEL);
  assert.deepEqual(Object.keys(request.body.questions).sort(), ['frozen', 'standstill']);
  assert.equal(request.body.questions.standstill?.type, 'noul');
  assert.equal(request.auth, 'Bearer test-key-value');
  assert.equal(result.verdict.standstill, 0.91);
  assert.equal(result.verdict.model, 'jev-1.13.0');
});

test('a gate answer missing a question is a failure rather than a verdict of zero', async () => {
  const askGate = createGateAsk('test-key-value', {
    retry: { maxRetries: 0 },
    fetch: async () =>
      new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { standstill: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  await assert.rejects(() => askGate({ camera: {} }), /answer missing a question/);
});

/** The re-ask cadence. A one-minute window is only affordable because an unchanged picture holds its answer, so both halves of that are worth pinning down. */

test('an unchanged picture holds its answer past the re-ask window', async () => {
  let asked = 0;
  const arbiter = makeArbiter(async () => {
    asked++;
    return answer();
  }, dir());
  const now = Date.now() / 1000;
  const still = (uid: number): CameraTelemetry => telemetry(uid, { lastTs: now - 30 });

  arbiter.consider([incident()], still, noCameras, now);
  await arbiter.drain();
  assert.equal(asked, 1);

  arbiter.consider([incident()], still, noCameras, now + JEV.REASK_AFTER_S + 5);
  await arbiter.drain();
  assert.equal(asked, 1, 'the window passed but nothing new had arrived to answer about');
});

test('a new frame inside the window still waits, and is asked about once the window passes', async () => {
  let asked = 0;
  const arbiter = makeArbiter(async () => {
    asked++;
    return answer();
  }, dir());
  const now = Date.now() / 1000;
  const fresh = (at: number) => (uid: number) => telemetry(uid, { lastTs: at });

  arbiter.consider([incident()], fresh(now - 30), noCameras, now);
  await arbiter.drain();
  assert.equal(asked, 1);

  arbiter.consider([incident()], fresh(now), noCameras, now + JEV.REASK_AFTER_S - 5);
  await arbiter.drain();
  assert.equal(asked, 1, 'a new frame does not shorten the window');

  arbiter.consider([incident()], fresh(now), noCameras, now + JEV.REASK_AFTER_S + 5);
  await arbiter.drain();
  assert.equal(asked, 2);
});

test('the gate can renew a floor before it expires', () => {
  assert.ok(JEV.GATE_REASK_AFTER_S < JEV.GATE_HOLD_S, 'a standstill that is still standing must be re-readable while its floor is alive');
});

test('the snapshot carries the answers over time and never causes a call', async () => {
  let asked = 0;
  const arbiter = makeArbiter(async () => {
    asked++;
    return answer({ score: 3, scoreConfidence: 0.8 });
  }, dir());
  const now = Date.now() / 1000;
  arbiter.consider([incident()], (uid) => telemetry(uid, { lastTs: now - 30 }), noCameras, now);
  await arbiter.drain();
  arbiter.consider([incident()], (uid) => telemetry(uid, { lastTs: now }), noCameras, now + JEV.REASK_AFTER_S + 5);
  await arbiter.drain();

  const snapshot = arbiter.snapshot([incident()], () => true, { watching: 1, feedsRead: 1, prioritised: 0 }, () => true);
  assert.deepEqual(snapshot.gates, {
    noul_threshold: JEV.NOUL_THRESHOLD,
    act_confidence: JEV.ACT_CONFIDENCE,
    score_swing: JEV.SCORE_SWING,
    cleared_residue: JEV.CLEARED_RESIDUE,
    supported_lift: JEV.SUPPORTED_LIFT,
    chosen_gain: JEV.CHOSEN_GAIN,
    chosen_others: JEV.CHOSEN_OTHERS,
  });
  assert.equal(asked, 2);
  assert.equal(snapshot.incidents.length, 1);
  assert.equal(snapshot.incidents[0]?.history.length, 2);
  assert.equal(snapshot.incidents[0]?.latest?.score, 3);
  // The multiplier in the series is the arithmetic the scorer applies, not a restatement of the answer.
  assert.equal(snapshot.incidents[0]?.latest?.multiplier, arbiter.modulate(incident(), 30004214, 0.5).influence?.multiplier);
  arbiter.snapshot([incident()], () => true, { watching: 1, feedsRead: 1, prioritised: 0 }, () => true);
  assert.equal(asked, 2, 'reading the pane asks nothing');
});

test('a record nobody is reporting any more drops out of the snapshot', async () => {
  const arbiter = makeArbiter(async () => answer(), dir());
  const now = Date.now() / 1000;
  arbiter.consider([incident()], (uid) => telemetry(uid, { lastTs: now - 30 }), noCameras, now);
  await arbiter.drain();
  assert.equal(arbiter.snapshot([incident()], () => true, { watching: 1, feedsRead: 1, prioritised: 0 }, () => true).incidents.length, 1);
  assert.equal(arbiter.snapshot([], () => true, { watching: 1, feedsRead: 1, prioritised: 0 }, () => true).incidents.length, 0);
});

test('the snapshot says how far each record got, so an empty pane can explain itself', async () => {
  const arbiter = makeArbiter(null, dir());
  const quiet = incident({ id: 'FHP-2', cameras: [] });
  const police = incident({ id: 'FHP-3', road_relevant: false, implies_closure: false });
  const counts = arbiter.snapshot([incident(), quiet, police], (uid) => uid === 30004214, { watching: 1, feedsRead: 1, prioritised: 0 }, () => true);
  assert.equal(counts.live_incidents, 3);
  assert.equal(counts.linked_incidents, 2, 'one names no camera we serve');
  assert.equal(counts.relevant_incidents, 1, 'one is ordinary police business');
  assert.equal(counts.ready_incidents, 1);
  // The same records with nothing on screen yet, which is the ordinary reason the pane is empty.
  assert.equal(arbiter.snapshot([incident(), quiet, police], () => false, { watching: 1, feedsRead: 1, prioritised: 0 }, () => true).ready_incidents, 0);
});

test('records whose cameras this server does not hold are counted apart from the ones it is waiting on', () => {
  const arbiter = makeArbiter(null, dir());
  const here = incident({ id: 'FHP-4', cameras: [30004214] });
  const elsewhere = incident({ id: 'FHP-5', cameras: [99999999] });
  const counts = arbiter.snapshot(
    [here, elsewhere],
    () => false,
    { watching: 1, feedsRead: 1, prioritised: 0 },
    (uid) => uid === 30004214,
  );
  assert.equal(counts.relevant_incidents, 2);
  assert.equal(counts.servable_incidents, 1, 'one names a camera in a city this server is not running');
  assert.equal(counts.ready_incidents, 0);
});

const upstream: Neighbour = { uid: 30004299, roadway: 'SR-836', location: 'upstream', side: 'upstream', length_m: 1200, tt_s: 48, hops: 1, wave_s: 288 };

test('a confident neighbour choice lifts its queue without demoting named views', async () => {
  const record = incident();
  const arbiter = makeArbiter(async () => answer({ chosen: upstream.uid }), dir());
  arbiter.consider([record], telemetry, () => [upstream], 1500);
  await arbiter.drain();
  const multiplier = (1 + JEV.SCORE_SWING) * JEV.SUPPORTED_LIFT;
  for (const uid of record.cameras) assert.equal(arbiter.modulate(record, uid, 0.3).value, round3(0.3 * multiplier));
  const cameras = new Map([[30004214, telemetry(30004214, { lat: record.lat + 0.1 })], [30004221, telemetry(30004221, { lat: record.lat, lon: record.lon })]]);
  const index = buildQueueIndex([record], new Map([[30004214, [upstream]]]), cameras);
  const entries = index.get(upstream.uid) ?? [];
  const result = queueFloor(upstream.uid, entries, 1500, (inc, uid, floor) => arbiter.chosenQueue(inc, uid, floor));
  const recordFloor = incidentFloor({ uid: 30004221, lat: record.lat, lon: record.lon, now: 1500 }, [record]).value;
  assert.ok(Math.abs(result.value - recordFloor * multiplier * JEV.CHOSEN_GAIN) < 1e-12);
  assert.equal(result.queue?.jev_chosen, true);
  assert.ok(result.value > queueFloor(upstream.uid, entries, 1500).value);
});

test('a low-confidence neighbour choice leaves graph floors and named views alone', async () => {
  const record = incident();
  const arbiter = makeArbiter(async () => answer({ chosen: upstream.uid, chosenConfidence: JEV.ACT_CONFIDENCE - 0.01, scoreConfidence: 0, supported: 0 }), dir());
  arbiter.consider([record], telemetry, () => [upstream], 1500);
  await arbiter.drain();
  for (const uid of record.cameras) assert.equal(arbiter.modulate(record, uid, 0.3).value, 0.3);
  const index = buildQueueIndex([record], new Map([[30004214, [upstream]]]), new Map([[30004214, telemetry(30004214)]]));
  const entries = index.get(upstream.uid) ?? [];
  assert.deepEqual(queueFloor(upstream.uid, entries, 1500, (inc, uid, floor) => arbiter.chosenQueue(inc, uid, floor)), queueFloor(upstream.uid, entries, 1500));
});

test('a neighbour choice retains clearing, support and screen gates', async () => {
  const record = incident();
  const arbiter = makeArbiter(async () => answer({ chosen: upstream.uid, cleared: 1, scoreConfidence: 0, supported: 0 }), dir());
  arbiter.consider([record], telemetry, () => [upstream], 1500);
  await arbiter.drain();
  assert.ok(Math.abs(arbiter.chosenQueue(record, upstream.uid, TUNING.FLOOR_CLOSURE)! - TUNING.FLOOR_CLOSURE * JEV.CLEARED_RESIDUE * JEV.CHOSEN_GAIN) < 1e-12);
  assert.equal(arbiter.chosenQueue({ ...record, remarks: 'changed' }, upstream.uid, 0.9), null);
});

test('neighbours carry pictures or explicit missing pictures without epoch timestamps', () => {
  const state = buildState(incident(), [telemetry(30004214)], [upstream, { ...upstream, uid: 30004300 }], 1540, (uid) => uid === upstream.uid ? telemetry(uid) : null);
  const neighbours = state.nearby_cameras_on_the_same_corridor as Record<string, unknown>[];
  const named = (state.cameras_the_record_names as Record<string, unknown>[])[0]!;
  for (const key of ['picture', 'frame_difference', 'usual_frame_difference_this_hour', 'times_its_usual', 'newest_frame']) assert.equal(neighbours[0]?.[key], named[key]);
  assert.equal(neighbours[1]?.picture, 'no picture yet');
  assert.equal(neighbours[1]?.newest_frame, 'none yet');
  assert.ok(!JSON.stringify(state).includes('1000'));
  assert.ok(!JSON.stringify(state).includes('900'));
  assert.equal(JEV.RUBRIC_VERSION, 5);
});

for (const [name, verdict, expected] of [
  ['acted-on standstill', { standstill: 0.9, frozen: 0.05 }, true],
  ['frozen feed', { standstill: 0.9, frozen: 0.95 }, false],
  ['sub-threshold standstill', { standstill: JEV.NOUL_THRESHOLD - 0.01, frozen: 0.05 }, false],
] as const) {
  test(`upstream queue propagation from ${name}`, async () => {
    const arbiter = makeArbiter(null, dir(), async () => gateAnswer(verdict));
    arbiter.considerGate([candidate(1)]);
    await arbiter.drain();
    const held = arbiter.gateFloor(1)!;
    assert.ok(Number.isFinite(held.at));
    const gate = (uid: number, now: number) => arbiter.gateFloor(uid, now);
    const neighbours: Neighbour[] = [
      { uid: 2, roadway: 'I 10', location: 'approach', side: 'upstream', hops: 1, length_m: 1200, tt_s: 30, wave_s: 288 },
      { uid: 3, roadway: 'I 10', location: 'past', side: 'downstream', hops: 1, length_m: 1200, tt_s: 30, wave_s: null },
    ];
    const index = buildQueueIndex([], new Map([[1, neighbours]]), new Map([[1, { lat: 30, lon: -84, location: 'I 10 at Main' }]]), gate, held.at);
    const entries = index.get(2) ?? [];
    const result = queueFloor(2, entries, held.at + 144, undefined, gate);
    if (expected) {
      assert.equal(result.value, JEV.GRIDLOCK_FLOOR * TUNING.UPSTREAM_SHARE * (1 - 1200 / 5000) * 0.5);
      assert.equal(result.queue?.source, 'standstill');
      assert.equal(result.queue?.incident, 'I 10 at Main');
      assert.equal(result.queue?.reach, 0.5);
      assert.equal(queueFloor(2, entries, held.at, undefined, gate).value, 0);
      assert.equal(queueFloor(2, entries, held.at + 288, undefined, gate).queue?.reach, 1);
      assert.equal(queueFloor(2, entries, held.at + JEV.GATE_HOLD_S + 1, undefined, gate).value, 0);
    } else {
      assert.deepEqual(entries, []);
      assert.equal(result.value, 0);
    }
    assert.equal(index.has(1), false);
    assert.equal(index.has(3), false);
  });
}

/** The review: a second look at the leading cameras of a city. It may reorder, within bounds, and nothing else. */

function leader(uid: number, over: Partial<CameraTelemetry> = {}): ReviewCandidate {
  return { camera: telemetry(uid, { ambiguousZero: false, diff: 0.03, ...over }), freeway: true, roadSize: 0.8, incident: null, queue: false, stoppedTraffic: false, equation: 1 - uid / 1000 };
}

/** Answers every camera it is asked about with the level and confidence given for it, and counts the calls. */
function reviewer(levels: Record<number, [number, number]>): { ask: ReviewAsk; calls: () => number; seen: () => number[][] } {
  let calls = 0;
  const seen: number[][] = [];
  const ask: ReviewAsk = async (_state, cameras) => {
    calls++;
    seen.push(cameras.map((camera) => camera.uid));
    const verdicts = new Map(cameras.filter(({ uid }) => levels[uid]).map(({ uid }) => [uid, { level: levels[uid]![0], levels: 4, confidence: levels[uid]![1], model: 'jev-test' }]));
    return { verdicts, usage: { input_tokens: 900, output_tokens: 80 }, raw: {}, latencyMs: 400 };
  };
  return { ask, calls: () => calls, seen: () => seen };
}

test('a confident look moves a camera within the swing, and an unsure one moves nothing', async () => {
  const { ask } = reviewer({ 1: [3, 0.9], 2: [0, 0.9], 3: [3, JEV.ACT_CONFIDENCE - 0.01], 4: [1.5, 0.8] });
  const arbiter = makeArbiter(null, dir(), null, ask);
  arbiter.considerReview('city', 'City', [leader(1), leader(2), leader(3), leader(4)]);
  await arbiter.drain();
  assert.equal(arbiter.reviewFactor(1)?.factor, 1 + JEV.REVIEW_SWING);
  assert.equal(arbiter.reviewFactor(2)?.factor, 1 - JEV.REVIEW_SWING);
  // Reported for the shadow record, and acted on not at all.
  assert.equal(arbiter.reviewFactor(3)?.factor, 1);
  assert.equal(arbiter.reviewFactor(3)?.acted, false);
  assert.equal(arbiter.reviewFactor(4)?.factor, 1);
  assert.equal(arbiter.reviewFactor(99), null, 'a camera never looked at keeps the equation alone');
});

test('a look expires, so a camera that has left the leaders is judged by the equation again', async () => {
  const { ask } = reviewer({ 1: [3, 0.9], 2: [0, 0.9] });
  const arbiter = makeArbiter(null, dir(), null, ask);
  arbiter.considerReview('city', 'City', [leader(1), leader(2)]);
  await arbiter.drain();
  const now = Date.now() / 1000;
  assert.ok(arbiter.reviewFactor(1, now));
  assert.equal(arbiter.reviewFactor(1, now + JEV.REVIEW_HOLD_S + 1), null);
});

test('a city is looked at again only after the window and only once a leader has a new picture', async () => {
  const { ask, calls, seen } = reviewer({ 1: [2, 0.9], 2: [2, 0.9] });
  const arbiter = makeArbiter(null, dir(), null, ask);
  const now = 10_000;
  arbiter.considerReview('city', 'City', [leader(1), leader(2)], now);
  await arbiter.drain();
  arbiter.considerReview('city', 'City', [leader(1), leader(2, { lastTs: 950 })], now + 30);
  assert.equal(calls(), 1, 'inside the window');
  arbiter.considerReview('city', 'City', [leader(1), leader(2)], now + JEV.REVIEW_EVERY_S + 1);
  assert.equal(calls(), 1, 'nothing new to judge');
  arbiter.considerReview('city', 'City', [leader(1), leader(2, { lastTs: 950 })], now + JEV.REVIEW_EVERY_S + 1);
  await arbiter.drain();
  assert.equal(calls(), 2);
  // At most the top few, and never one camera on its own.
  arbiter.considerReview('other', 'Other', Array.from({ length: 12 }, (_, i) => leader(100 + i)), now);
  arbiter.considerReview('lonely', 'Lonely', [leader(200)], now);
  await arbiter.drain();
  assert.equal(calls(), 3);
  assert.equal(seen()[2]!.length, JEV.REVIEW_TOP_K);
});

test('the review state leaves the equation score out and says what each camera shows', () => {
  const state = buildReviewState('City', [leader(1, { diff: 0.06, baseline: 0.02 }), { ...leader(2), incident: 'Crash at exit 4', queue: true }], 1_790_000_000) as { cameras: Record<string, unknown>[] };
  assert.equal(state.cameras.length, 2);
  assert.equal(state.cameras[0]!.times_its_usual, 3);
  assert.equal(state.cameras[1]!.incident_reported_here, 'Crash at exit 4');
  assert.ok(!JSON.stringify(state).includes('attention'), 'a second opinion, not an echo');
});

test('kendall tau reads two orders of the same cameras', () => {
  assert.equal(kendallTau([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(kendallTau([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(kendallTau([1, 2, 3], [2, 1, 3]), 0.333);
  assert.equal(kendallTau([1], [1]), null);
});

test('every look writes both rankings of the same cameras to the shadow log', async () => {
  const { ask } = reviewer({ 1: [0.5, 0.3], 2: [2.5, 0.9], 3: [1, 0.9] });
  const logDir = dir();
  const arbiter = makeArbiter(null, logDir, null, ask);
  arbiter.considerReview('city', 'City', [leader(1), leader(2), leader(3)]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await arbiter.drain();
  const file = readdirSync(logDir).find((name) => name.startsWith('jev-'))!;
  const line = readFileSync(join(logDir, file), 'utf8').trim().split('\n').map((row) => JSON.parse(row) as { kind: string; shadow?: { equation_order: number[]; look_order: number[]; kendall_tau: number } }).find((row) => row.kind === 'review')!;
  assert.deepEqual(line.shadow?.equation_order, [1, 2, 3]);
  // The unsure answer on camera 1 still ranks in the shadow, which is the point of it.
  assert.deepEqual(line.shadow?.look_order, [2, 3, 1]);
  assert.equal(line.shadow?.kendall_tau, -0.333);
});
