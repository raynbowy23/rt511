// Synthetic benchmark: how quickly each ranking puts the camera that matters on the wall, in scripted situations.
//
// No pictures are drawn. Each camera is given a scripted series of frame differences, which is all the scorer reads from a picture, and the scenarios drive rt511's own scoring code from server/dist, so what is measured is the running implementation. Time is simulated, a week of ordinary history is laid down first so every camera has an hour-of-week profile, and nothing contacts an agency.
//
//   make bench-synthetic                 every ranking except Jev, at picture cadences of 15 s, 1, 2 and 5 minutes
//   make bench-synthetic JEV=1           adds the Jev arm to the stopped-traffic scenario (paid calls, JEV_API from .env)
//
// Results are printed and written to out/bench/synthetic-<timestamp>.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'server/dist/server/src');
if (!existsSync(join(DIST, 'attention.js'))) {
  console.error('server/dist is missing: run `pnpm --filter @rt511/server run build` first, or use `make bench-synthetic`.');
  process.exit(1);
}
const { AttentionEngine } = await import(join(DIST, 'attention.js'));
const { CameraSlot, DIFF_HISTORY } = await import(join(DIST, 'poller.js'));
const { buildQueueIndex } = await import(join(DIST, 'corridor.js'));
const { JEV, buildGateState, createGateAsk } = await import(join(DIST, 'jev.js'));

const K = 8; // tiles on the wall
const SEEDS = Number(process.env.SEEDS ?? 30);
const JEV_SEEDS = Number(process.env.JEV_SEEDS ?? 5);
const TICK_S = 15; // the simulation's clock; every cadence below is a whole number of ticks
// How often each camera gets a new picture, in seconds: video sampled every 15 s as Iowa's streams allow, a picture a minute as Ohio's wall polls, every two minutes as Oregon's and New England's pictures change, and every five as Caltrans publishes.
const CADENCES = (process.env.CADENCES ?? '15,60,120,300').split(',').map(Number);
const MAIN_CADENCE = 60; // the one the full tables and the Jev arms use
const LEAD_MIN = 10; // ordinary minutes before the event
const WINDOW_MIN = 40; // minutes watched after it
const WAVE_MS = (15 * 1000) / 3600; // stopping wave, 15 km/h in meters per second
const HISTORY_WEEKS = 4; // weeks of ordinary history laid down before each run
const STEADY_MIN = 3; // minutes in a row on the wall that count as being shown
const useJev = process.env.JEV === '1';

// ---------------------------------------------------------------- randomness

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A frame difference around `level`, with the multiplicative scatter real cameras show from one picture to the next. */
const noisy = (random, level) => Math.max(0.0002, level * Math.exp(0.25 * (random() + random() + random() - 1.5) * 1.4));

// ---------------------------------------------------------------- cameras

const METERS_PER_DEG_LAT = 111_320;
const at = (north_m, east_m) => ({ lat: 41.6 + north_m / METERS_PER_DEG_LAT, lon: -93.6 + east_m / (METERS_PER_DEG_LAT * Math.cos((41.6 * Math.PI) / 180)) });

function catalog(uid, where, freeway, name) {
  const { lat, lon } = at(where[0], where[1]);
  return { id: uid, region: 'bench', source: 'bench', image_path: '', roadway: freeway ? 'I 35' : 'Main St', direction: null, location: name, lat, lon, video_url: null, video_auth: false, link_id: null, source_system: 'bench', mile_marker: null };
}

/**
 * A scenario is a set of cameras, each with its usual frame difference at this hour and a script for what it does after the event starts.
 * `usual(uid)` is the level the week of history is laid down at, `during(uid, minute, random)` the difference at a minute after the event starts (null keeps the usual level).
 */
function scenarioCameras(spec) {
  const cams = new Map();
  for (const c of spec.cameras) cams.set(c.uid, c);
  return cams;
}

// Forty cameras: freeways spread over a city and a few surface streets, all far from any scripted event.
function background(first, count, level, streetShare = 0.25) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const street = i < Math.round(count * streetShare);
    out.push({ uid: first + i, where: [8000 + (i % 8) * 1500, 8000 + Math.floor(i / 8) * 1500], freeway: !street, prior: street ? 0.3 : 0.85, usual: street ? level * 0.5 : level, name: `${street ? 'Street' : 'Freeway'} ${i + 1}` });
  }
  return out;
}

// ---------------------------------------------------------------- scenarios

const localTime = (hour) => new Date(2026, 8, 23, hour, 0, 0).getTime() / 1000; // a Wednesday

const SCENARIOS = [
  {
    key: 'quiet-hour',
    title: 'Something unusual at a quiet hour',
    story: '3 AM. A surface street that usually barely moves starts moving at four times its usual level. The freeways around it are at their usual night level, a few lit ones busier.',
    hour: 3,
    cameras: [{ uid: 1, where: [0, 0], freeway: false, prior: 0.3, usual: 0.003, name: 'Target street', role: 'target', during: () => 0.012 }, ...background(100, 35, 0.006), ...[0, 1, 2, 3].map((i) => ({ uid: 200 + i, where: [-9000, i * 1500], freeway: true, prior: 0.85, usual: 0.02, name: `Lit freeway ${i + 1}` }))],
    targets: [1],
  },
  {
    key: 'quiet-hour-freeway',
    title: 'Something unusual at a quiet hour, on a freeway',
    story: 'The same night, but the camera that starts moving at four times its usual level is on a freeway, so road size does not hold it back.',
    hour: 3,
    cameras: [{ uid: 1, where: [0, 0], freeway: true, prior: 0.85, usual: 0.006, name: 'Target freeway', role: 'target', during: () => 0.024 }, ...background(100, 35, 0.006), ...[0, 1, 2, 3].map((i) => ({ uid: 200 + i, where: [-9000, i * 1500], freeway: true, prior: 0.85, usual: 0.02, name: `Lit freeway ${i + 1}` }))],
    targets: [1],
  },
  {
    key: 'rush-hour',
    title: 'Rush hour is not news',
    story: '5 PM. Thirty freeways are at their usual rush-hour level. One arterial that usually moves at 0.010 rises to 0.025, two and a half times its usual, still less raw movement than the freeways.',
    hour: 17,
    cameras: [{ uid: 1, where: [0, 0], freeway: false, prior: 0.45, usual: 0.01, name: 'Target arterial', role: 'target', during: () => 0.025 }, ...background(100, 39, 0.03, 0.1)],
    targets: [1],
  },
  {
    key: 'stopped-traffic',
    title: 'Traffic stops on a busy freeway',
    story: '5 PM. A freeway camera that usually moves at 0.030 goes almost still (0.001), because traffic has stopped. Its upstream neighbors keep moving. No incident has been reported.',
    hour: 17,
    cameras: [
      { uid: 1, where: [0, 0], freeway: true, prior: 0.9, usual: 0.03, name: 'Target freeway', role: 'target', during: () => 0.001 },
      { uid: 2, where: [-1200, 0], freeway: true, prior: 0.9, usual: 0.03, name: 'Upstream 1.2 km', role: 'upstream' },
      { uid: 3, where: [-3500, 0], freeway: true, prior: 0.9, usual: 0.03, name: 'Upstream 3.5 km', role: 'upstream' },
      ...background(100, 37, 0.03, 0.15),
    ],
    corridor: { 1: [{ uid: 2, m: 1200, hops: 1 }, { uid: 3, m: 3500, hops: 2 }] },
    targets: [1],
    jev: true,
  },
  {
    key: 'crash-report',
    title: 'A crash report, with a queue growing upstream',
    story: '2 PM. A closure is reported beside one freeway camera whose picture stays ordinary. Two cameras upstream on the same carriageway should follow as the queue reaches them. A camera 1.5 km downstream and a cross-street camera 300 m away should not.',
    hour: 14,
    cameras: [
      { uid: 1, where: [0, 0], freeway: true, prior: 0.9, usual: 0.02, name: 'Crash camera', role: 'target' },
      { uid: 2, where: [-1200, 0], freeway: true, prior: 0.9, usual: 0.02, name: 'Upstream 1.2 km', role: 'queue' },
      { uid: 3, where: [-3500, 0], freeway: true, prior: 0.9, usual: 0.02, name: 'Upstream 3.5 km', role: 'queue' },
      { uid: 4, where: [1500, 0], freeway: true, prior: 0.9, usual: 0.02, name: 'Downstream 1.5 km', role: 'distractor' },
      { uid: 5, where: [0, 300], freeway: false, prior: 0.35, usual: 0.01, name: 'Cross street 300 m', role: 'distractor' },
      ...background(100, 35, 0.02, 0.2),
    ],
    corridor: { 1: [{ uid: 2, m: 1200, hops: 1 }, { uid: 3, m: 3500, hops: 2 }] },
    incident: { at: 1, closure: true },
    targets: [1],
    queue: [2, 3],
    distractors: [4, 5],
  },
];

// ---------------------------------------------------------------- rankers

/** Every ranker sees the same simulated world at each minute and returns a score per camera. Only the equation's variants read anything beyond the pictures. */
const RANKERS = [
  { key: 'random', label: 'Random' },
  { key: 'round-robin', label: 'Round-robin' },
  { key: 'motion', label: 'Most motion' },
  { key: 'activity', label: 'Motion vs recent median' },
  { key: 'equation-visual', label: 'Equation, pictures only' },
  { key: 'equation', label: 'Equation, with floors' },
  { key: 'equation-radius', label: 'Equation, radius queue', only: ['crash-report'] },
  { key: 'equation-confirmed', label: 'Equation, standstill confirmed', only: ['stopped-traffic'] },
  { key: 'equation-jev', label: 'Equation, with Jev', only: ['stopped-traffic'], needsJev: true },
  { key: 'equation-jev-count', label: 'Equation, with Jev and a vehicle count', only: ['stopped-traffic'], needsJev: true },
];

// ---------------------------------------------------------------- one run

function distanceM(a, b) {
  const dy = (a.lat - b.lat) * METERS_PER_DEG_LAT;
  const dx = (a.lon - b.lon) * METERS_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

async function run(scenario, seed, jevAsk, cadence) {
  const random = rng(seed * 7919 + scenario.key.length);
  const every = cadence / TICK_S;
  const cams = scenarioCameras(scenario);
  const priors = new Map([...cams.values()].map((c) => [c.uid, { prior: c.prior, source: 'class', aadt: null, distance_m: null, aligned: null, highway: c.freeway ? 'motorway' : 'primary' }]));
  const tmp = join(REPO, 'out/bench/tmp');
  mkdirSync(tmp, { recursive: true });
  const engine = new AttentionEngine(priors, tmp);
  const slots = new Map();
  const catalogs = new Map();
  for (const c of cams.values()) {
    const cat = catalog(c.uid, c.where, c.freeway, c.name);
    catalogs.set(c.uid, cat);
    slots.set(c.uid, new CameraSlot(c.uid, cat));
  }
  const feed = (uid, diff, t) => {
    const slot = slots.get(uid);
    slot.frames.length = 0;
    slot.frames.push({ ts: t, last_modified: null, data: Buffer.alloc(0), content_type: 'image/jpeg', brightness: 0.5, diff });
    slot.diffs.push(diff);
    if (slot.diffs.length > DIFF_HISTORY) slot.diffs.shift();
    engine.observe(slot, 'fresh', t);
  };

  // Four weeks of ordinary history at this hour on this weekday, one picture every five minutes. The baseline is kept per hour of the week, so only the same weekday fills the cell the event will be measured against.
  const start = localTime(scenario.hour);
  for (let week = HISTORY_WEEKS; week >= 1; week--) {
    for (let minute = 0; minute < 60; minute += 5) {
      const t = start - week * 7 * 86400 + minute * 60;
      for (const c of cams.values()) feed(c.uid, noisy(random, c.usual), t);
    }
  }

  // The corridor as the scorer's queue index reads it: upstream neighbors with road distance and stopping-wave arrival.
  const graphCorridor = new Map();
  for (const [anchor, list] of Object.entries(scenario.corridor ?? {})) {
    graphCorridor.set(Number(anchor), list.map((n) => ({ uid: n.uid, roadway: 'I 35', location: cams.get(n.uid).name, side: 'upstream', length_m: n.m, tt_s: n.m / 29, hops: n.hops, wave_s: n.m / WAVE_MS })));
  }
  // The radius alternative: every camera within 5 km in a straight line gets the queue treatment, whatever road it is on.
  const radiusCorridor = new Map();
  if (scenario.incident) {
    const anchor = catalogs.get(scenario.incident.at);
    radiusCorridor.set(
      scenario.incident.at,
      [...catalogs.values()]
        .filter((c) => c.id !== anchor.id && distanceM(c, anchor) <= 5000)
        .map((c) => {
          const m = distanceM(c, anchor);
          return { uid: c.id, roadway: c.roadway, location: c.location, side: 'upstream', length_m: m, tt_s: m / 29, hops: 1, wave_s: m / WAVE_MS };
        }),
    );
  }

  const onset = start + LEAD_MIN * 60;
  const incident = scenario.incident
    ? { id: 'bench-1', type: 'CRASH', location: 'I 35 at the crash camera', city: null, county: null, lat: catalogs.get(scenario.incident.at).lat, lon: catalogs.get(scenario.incident.at).lon, reported_at: onset, remarks: null, cameras: [scenario.incident.at], label: 'Crash', road_relevant: true, implies_closure: scenario.incident.closure }
    : null;

  // Jev's stopped-traffic verdicts, held the way the arbiter holds them, but on simulated time. One store per arm, since the arms are asked separately.
  const verdictsByArm = { 'equation-jev': new Map(), 'equation-jev-count': new Map() };
  const askedAtByArm = { 'equation-jev': new Map(), 'equation-jev-count': new Map() };
  // The confirmed arm answers "stopped" with certainty for the target from the minute after onset, and keeps answering it, as the arbiter re-asks every five minutes: the best any arbiter could do.
  const confirmedGate = (uid, now) => (scenario.jev && scenario.targets.includes(uid) && now >= onset + TICK_S ? { value: JEV.GRIDLOCK_FLOOR, at: now, influence: { standstill: 1, floor: JEV.GRIDLOCK_FLOOR, gated: [], model: 'confirmed' } } : null);
  const gateFrom = (verdicts) => (uid, now) => {
    const v = verdicts.get(uid);
    if (!v || now < v.at) return null;
    if (!v || now - v.at > JEV.GATE_HOLD_S) return null;
    const standstill = v.standstill >= JEV.NOUL_THRESHOLD;
    const value = standstill ? JEV.GRIDLOCK_FLOOR : 0;
    return { value, at: v.at, influence: { standstill: v.standstill, floor: value, gated: [], model: v.model } };
  };

  const rankers = RANKERS.filter((r) => (!r.only || r.only.includes(scenario.key)) && (!r.needsJev || jevAsk));
  const seen = Object.fromEntries(rankers.map((r) => [r.key, new Map()])); // uid -> first minute of a steady stretch on the wall after onset
  const streak = Object.fromEntries(rankers.map((r) => [r.key, new Map()])); // uid -> consecutive minutes on the wall so far
  const onWall = Object.fromEntries(rankers.map((r) => [r.key, new Map()])); // uid -> minutes on the wall after onset
  const floored = Object.fromEntries(rankers.map((r) => [r.key, new Set()])); // cameras that ever received a queue floor
  const rankAtEnd = Object.fromEntries(rankers.map((r) => [r.key, new Map()]));
  const ids = [...cams.keys()].sort((a, b) => a - b);
  let calls = 0;
  // Each camera's pictures arrive on its own offset, as real cameras' do, rather than all at once.
  const phase = new Map(ids.map((uid) => [uid, Math.floor(random() * every)]));
  // Shown means on the wall for STEADY_MIN minutes and across two of the camera's own pictures, whichever is longer. With slow pictures the ranking hardly changes, so three minutes alone would let a camera that landed on the wall by chance count as shown.
  const steadyTicks = Math.max((STEADY_MIN * 60) / TICK_S, 2 * every);
  const lastTick = (WINDOW_MIN * 60) / TICK_S - 1;
  const randomScores = new Map();

  for (let tick = (-LEAD_MIN * 60) / TICK_S; tick <= lastTick; tick++) {
    const t = onset + tick * TICK_S;
    const minute = (tick * TICK_S) / 60;
    for (const c of cams.values()) {
      if ((((tick + phase.get(c.uid)) % every) + every) % every !== 0) continue;
      const scripted = minute >= 0 && c.during ? c.during(minute, random) : null;
      feed(c.uid, noisy(random, scripted ?? c.usual), t);
    }
    const live = incident && t >= onset ? [incident] : [];

    // Jev is asked about a camera the gate has flagged, at most once in the re-ask window, and its answer applies from the next minute.
    if (jevAsk && scenario.jev) {
      const plain = engine.scorer(() => [], t, new Map());
      for (const uid of ids) {
        const scored = plain(slots.get(uid), null);
        if (!scored.axes?.ambiguous_zero) continue;
        for (const arm of ['equation-jev', 'equation-jev-count']) {
        const last = askedAtByArm[arm].get(uid);
        if (last !== undefined && t - last < JEV.GATE_REASK_AFTER_S) continue;
        askedAtByArm[arm].set(uid, t);
        const c = catalogs.get(uid);
        const neighbors = (graphCorridor.get(uid) ?? []).slice(0, JEV.MAX_NEIGHBORS);
        // The count arm hands Jev what the detector would see in a stopped queue on a freeway, thirty vehicles.
        const vehicles = arm === 'equation-jev-count' ? { vehicles: 30, by_class: { car: 26, truck: 4 }, confidences: [], model: 'scripted', latency_ms: 0 } : null;
        const state = buildGateState({ camera: { uid, roadway: c.roadway, location: c.location, lat: c.lat, lon: c.lon, diff: slots.get(uid).latest.diff, activity: slots.get(uid).activity(null), baseline: scored.axes.baseline, baselineN: scored.axes.baseline_n, ambiguousZero: true, lastTs: t }, neighbors, incidentNearby: false, vehicles }, t);
        const answer = await jevAsk(state);
        calls++;
        const verdicts = verdictsByArm[arm];
        verdicts.set(uid, { ...answer.verdict, at: t + TICK_S });
        if (process.env.DEBUG) console.log('JEV', arm, 'seed', seed, 'minute', minute, 'uid', uid, JSON.stringify(answer.verdict));
        }
      }
    }

    for (const r of rankers) {
      let scores;
      if (r.key === 'random') {
        // Reshuffled once per picture period, so that at every cadence it shows what chance alone would.
        const key = Math.floor(tick / every);
        if (!randomScores.has(key)) randomScores.set(key, new Map(ids.map((uid) => [uid, random()])));
        scores = randomScores.get(key);
      } else if (r.key === 'round-robin') {
        const offset = (((Math.floor(minute) + LEAD_MIN) * K) % ids.length + ids.length) % ids.length;
        scores = new Map(ids.map((uid, i) => [uid, (i - offset + ids.length) % ids.length < K ? 1 : 0]));
      } else if (r.key === 'motion') scores = new Map(ids.map((uid) => [uid, slots.get(uid).latest.diff]));
      else if (r.key === 'activity') scores = new Map(ids.map((uid) => [uid, slots.get(uid).activity(null) ?? 0]));
      else {
        const withFloors = r.key !== 'equation-visual';
        const corridor = r.key === 'equation-radius' ? radiusCorridor : graphCorridor;
        engine.gate = r.key === 'equation-confirmed' ? confirmedGate : verdictsByArm[r.key] ? gateFrom(verdictsByArm[r.key]) : undefined;
        const queue = withFloors ? buildQueueIndex(live, corridor, catalogs, engine.gate, t) : new Map();
        const score = engine.scorer((uid) => (withFloors ? live.filter((i) => i.cameras.includes(uid)) : []), t, queue);
        scores = new Map(ids.map((uid) => {
          const s = score(slots.get(uid), null);
          if ((s.axes?.queue_floor ?? 0) > 0) floored[r.key].add(uid);
          return [uid, s.attention ?? 0];
        }));
        engine.gate = undefined;
      }
      // Ties broken by camera id, the same way every time, so no ranker is flattered by luck in a tie.
      const order = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([uid]) => uid);
      if (tick >= 0) {
        const wall = new Set(order.slice(0, K));
        for (const uid of ids) {
          const run = wall.has(uid) ? (streak[r.key].get(uid) ?? 0) + 1 : 0;
          streak[r.key].set(uid, run);
          if (wall.has(uid)) onWall[r.key].set(uid, (onWall[r.key].get(uid) ?? 0) + 1);
          // Counted in minutes from the start of the stretch, so a camera shown from the first moment scores 0.
          if (run === steadyTicks && !seen[r.key].has(uid)) seen[r.key].set(uid, ((tick - steadyTicks + 1) * TICK_S) / 60);
        }
      }
      if (tick === lastTick) order.forEach((uid, i) => rankAtEnd[r.key].set(uid, i + 1));
    }
  }
  return { seen, onWall, windowTicks: lastTick + 1, floored, rankAtEnd, calls, rankers: rankers.map((r) => r.key) };
}

// ---------------------------------------------------------------- aggregation

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};

async function main() {
  let jevAsk = null;
  if (useJev) {
    const env = existsSync(join(REPO, '.env')) ? readFileSync(join(REPO, '.env'), 'utf8') : '';
    const key = process.env.JEV_API ?? env.split('\n').find((line) => line.startsWith('JEV_API='))?.slice(8).trim();
    if (!key) {
      console.error('JEV=1 needs JEV_API in .env or the environment.');
      process.exit(1);
    }
    jevAsk = createGateAsk(key);
  }

  const byCadence = new Map();
  let totalCalls = 0;
  for (const cadence of CADENCES) {
  const results = [];
  for (const scenario of SCENARIOS) {
    const perRanker = new Map();
    for (let seed = 1; seed <= SEEDS; seed++) {
      // Jev is paid for per call, so its arms run on fewer seeds, the same first ones, and only at the main cadence.
      const withJev = jevAsk && scenario.jev && seed <= JEV_SEEDS && cadence === MAIN_CADENCE ? jevAsk : null;
      const out = await run(scenario, seed, withJev, cadence);
      totalCalls += out.calls;
      for (const key of out.rankers) {
        const bucket = perRanker.get(key) ?? { runs: 0, tts: [], surfaced: 0, coverage: [], queue: {}, distractorFloored: 0, rankAtEnd: [] };
        bucket.runs++;
        const minutes = scenario.targets.map((uid) => out.seen[key].get(uid)).filter((m) => m !== undefined);
        if (minutes.length === scenario.targets.length) {
          bucket.surfaced++;
          bucket.tts.push(Math.max(...minutes));
        }
        for (const uid of scenario.queue ?? []) {
          const q = (bucket.queue[uid] ??= { surfaced: 0, tts: [], floored: 0, coverage: [] });
          q.coverage.push((out.onWall[key].get(uid) ?? 0) / out.windowTicks);
          if (out.seen[key].has(uid)) {
            q.surfaced++;
            q.tts.push(out.seen[key].get(uid));
          }
          if (out.floored[key].has(uid)) q.floored++;
        }
        if ((scenario.distractors ?? []).some((uid) => out.floored[key].has(uid))) bucket.distractorFloored++;
        bucket.rankAtEnd.push(out.rankAtEnd[key].get(scenario.targets[0]));
        bucket.coverage.push((out.onWall[key].get(scenario.targets[0]) ?? 0) / out.windowTicks);
        perRanker.set(key, bucket);
      }
    }
    results.push({ scenario, perRanker });
  }
  byCadence.set(cadence, results);
  }
  const results = byCadence.get(MAIN_CADENCE) ?? byCadence.get(CADENCES[0]);

  // ---- print
  const cams = (s) => s.cameras.length;
  const lines = [];
  lines.push(`Synthetic benchmark: ${SEEDS} runs per scenario${jevAsk ? `, Jev arm on the first ${JEV_SEEDS}` : ''}, ${K} tiles on the wall, one picture every ${byCadence.has(MAIN_CADENCE) ? MAIN_CADENCE : CADENCES[0]} s per camera, ${WINDOW_MIN} minutes after each event, ${HISTORY_WEEKS} weeks of history. A camera counts as shown once it stays on the wall for ${STEADY_MIN} minutes in a row, or across two of its own pictures if that is longer.`);
  for (const { scenario, perRanker } of results) {
    lines.push('');
    lines.push(`## ${scenario.title} (${cams(scenario)} cameras)`);
    lines.push(scenario.story);
    lines.push('');
    lines.push('| Ranking | Target shown | Minutes until shown (median) | Share of the window on the wall (median) | Target rank at the end (median) |' + (scenario.queue ? ' Upstream 1.2 km shown | Upstream 3.5 km shown | A distractor got a queue floor |' : ''));
    lines.push('| --- | --- | --- | --- | --- |' + (scenario.queue ? ' --- | --- | --- |' : ''));
    for (const r of RANKERS) {
      const b = perRanker.get(r.key);
      if (!b) continue;
      const tts = median(b.tts);
      let row = `| ${r.label} | ${b.surfaced} of ${b.runs} | ${tts === null ? 'never' : tts} | ${Math.round(100 * median(b.coverage))}% | ${median(b.rankAtEnd)} |`;
      if (scenario.queue) {
        const q = scenario.queue.map((uid) => b.queue[uid]);
        row += q.map((x) => ` ${x.surfaced} of ${b.runs}${x.tts.length ? `, after ${median(x.tts)} min` : ''} |`).join('');
        row += ` ${b.distractorFloored} of ${b.runs} |`;
      }
      lines.push(row);
    }
  }
  // How the same scenarios fare when pictures arrive more or less often.
  if (byCadence.size > 1) {
    const label = (c) => (c < 60 ? `every ${c} s` : `every ${c / 60} min`);
    const shown = ['random', 'motion', 'activity', 'equation'];
    lines.push('');
    lines.push('## How often pictures arrive');
    lines.push(`Each cell gives how many of the ${SEEDS} runs showed the target, and the median minutes until it was shown. Random reshuffles once per picture period, so its row is what chance alone gives at that cadence.`);
    for (const scenario of SCENARIOS) {
      lines.push('');
      lines.push(`### ${scenario.title}`);
      lines.push('');
      lines.push(`| Ranking | ${[...byCadence.keys()].map(label).join(' | ')} |`);
      lines.push(`| --- |${[...byCadence.keys()].map(() => ' --- |').join('')}`);
      for (const key of shown) {
        const cells = [...byCadence.values()].map((res) => {
          const b = res.find((x) => x.scenario.key === scenario.key).perRanker.get(key);
          const tts = median(b.tts);
          return `${b.surfaced} of ${b.runs}${tts === null ? '' : `, ${tts} min`}`;
        });
        lines.push(`| ${RANKERS.find((r) => r.key === key).label} | ${cells.join(' | ')} |`);
      }
    }
  }
  lines.push('');
  lines.push(`Jev calls made: ${totalCalls}.`);
  console.log(lines.join('\n'));

  const outDir = join(REPO, 'out/bench');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(outDir, `synthetic-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        settings: { K, SEEDS, JEV_SEEDS: jevAsk ? JEV_SEEDS : 0, TICK_S, CADENCES, MAIN_CADENCE, LEAD_MIN, WINDOW_MIN, HISTORY_WEEKS, STEADY_MIN, rubric_version: JEV.RUBRIC_VERSION },
        results: Object.fromEntries([...byCadence].map(([cadence, res]) => [cadence, res.map(({ scenario, perRanker }) => ({ scenario: scenario.key, title: scenario.title, cameras: scenario.cameras.length, rankers: Object.fromEntries(perRanker) }))])),
        jev_calls: totalCalls,
        report: lines.join('\n'),
      },
      null,
      1,
    ),
  );
  console.log(`\nwrote ${file}`);
}

await main();
