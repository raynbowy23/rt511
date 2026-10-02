/** What is worth looking at, and why.
 *
 * The score is built from parts that are kept apart and reported apart. `anomaly` is movement against this camera's own profile for this hour of the week, shrunk toward the rolling median until the hour has enough samples of its own. The road-size amplifier scales that movement by how much traffic the road carries. Three floors carry consequence, an incident record nearby, a queue that could have reached the camera from further down the road, and stopped traffic confirmed by the arbiter on a still picture.
 *
 * The combination is lexicographic, in `combineAttention`. A camera held by a floor of at least `SCORE.FLOOR_HOLD_MIN` scores in an upper band, above every camera that is not, and within each band the larger of its movement and its floor sets the level. */

import { SCORE, combineAttention, type AttentionAxes, type ScoreCamera, type ScoreDriver, type ScoreRegion, type CameraState, type GateInfluence, type Graph, type Incident, type JevInfluence, type ReviewInfluence, type ScalePriorSource, type Site, type Snap } from '../../shared/src/index.js';
import { CAMERA_RADIUS_KM, distanceKm } from './cad.js';
import { loadAadt, round } from './config.js';
import { CORRIDOR } from './corridor.js';
import { JsonLog } from './jsonlog.js';
import { ACTIVE_DIFF, ACTIVITY_FLOOR, ACTIVITY_MIN_SAMPLES, median, warmupCap, type CameraSlot, type Scored } from './poller.js';

/** Every number the score depends on, in one place. */
export const TUNING = {
  /** Effective sample size of the rolling median in the baseline blend. An hour-of-week cell needs five polls of its own before it carries as much weight as the median it is displacing. */
  SHRINKAGE_K: 5,
  /** Kept identical to `activity`'s constant on purpose, so the two agree exactly before any hourly history exists. */
  ANOMALY_AT_BASELINE: SCORE.ANOMALY_AT_BASELINE,
  /** The two axes weigh the same, since there is no measurement yet that says either deserves more. */
  WEIGHT_ANOMALY: 0.5,
  WEIGHT_SPECTACLE: 0.5,
  /** How much of the spectacle term comes from absolute movement rather than movement relative to the camera's own baseline. Zero, because a mean absolute pixel difference varies with resolution, lens, weather and time of day and is not comparable between cameras; the term is wired for a real volume measure later. */
  ALPHA_ABSOLUTE: 0,
  /** The frame difference the absolute term would call saturated. A stand-in, not a measurement, and it has no effect while ALPHA_ABSOLUTE is zero. */
  ABSOLUTE_FULL_SCALE: 0.05,
  /** What a scale prior of 0 and a scale prior of 1 multiply the weighted sum of both visual axes by, applied once so each axis stays a pure measure of movement.
   *
   * The range is deliberately narrow and its lower end is well above zero. The prior describes how much traffic a road carries, which is a reason to prefer one camera over another when both are doing something, and never a reason to hide a residential street where something is plainly happening. */
  SCALE_AMPLIFIER_MIN: SCORE.SCALE_AMPLIFIER_MIN,
  SCALE_AMPLIFIER_MAX: SCORE.SCALE_AMPLIFIER_MAX,
  /** Traffic counts are mapped through log10(1 + aadt) and then onto 0..1 between these two. A thousand vehicles a day is a street nobody would watch and two hundred thousand is an urban interstate. */
  AADT_LOG_MIN: Math.log10(1 + 1000),
  AADT_LOG_MAX: Math.log10(1 + 200_000),
  /** A one-lane street at 40 km/h anchors the bottom of the capacity proxy; logarithms keep large roads from overwhelming smaller roads, as with AADT. */
  CAP_MIN: 1 * 40,
  /** A four-lane direction at 110 km/h anchors the top of the capacity proxy at a large freeway. */
  CAP_MAX: 4 * 110,
  /** Road class is the fallback when neither counts nor tagged lanes are available. */
  CLASS_PRIOR: {
    motorway: 1.0,
    trunk: 0.8,
    primary: 0.6,
    secondary: 0.45,
    tertiary: 0.3,
    unclassified: 0.2,
    residential: 0.2,
    service: 0.15,
  } as Record<string, number>,
  /** A ramp carries a fraction of the road it serves, so `motorway_link` scores below `motorway`. A judgment rather than a measurement: nothing in the data says what the fraction is. */
  LINK_FACTOR: 0.7,
  /** A camera the graph builder could not place on a road at all, scored as an ordinary street because it is usually a rest area or a bridge view. */
  DEFAULT_PRIOR: 0.3,
  /** A dispatch code that says the road itself is blocked. High enough that such a camera is on the wall whatever the picture is doing. */
  FLOOR_CLOSURE: 0.9,
  /** A code about the road but not necessarily blocking it. */
  FLOOR_ROAD_RELEVANT: 0.6,
  /** Codes that are ordinary police business get no floor at all, whatever the distance. */
  FLOOR_OTHER: 0,
  /** An upstream queue is inferred rather than seen, so it receives only sixty percent of the scene floor. */
  UPSTREAM_SHARE: 0.6,
  /** A record keeps its full floor for this long after it is reported, because a feed lists a record only while it is open, so for the first hour its presence is the evidence that it still matters. */
  INCIDENT_FULL_S: 3600,
  /** After the full hour, the floor halves every half hour, so a record a dispatcher has left open for days does not hold a camera on the wall for days. */
  INCIDENT_HALF_LIFE_S: 1800,
  /** A picture changing at least this many times as much as its hour-of-week cell expects is an event, not a sample of the usual, and is not folded into the cell. Twice the cell is where anomaly saturates. */
  LEARN_SKIP_RATIO: 2,
  /** An unusual level that lasts this long is accepted as the new usual and folded in again, so a lasting change such as a work zone does not read as an event forever. */
  LEARN_RESUME_S: 10800,
  /** Inside this distance the camera is treated as looking straight at the incident. */
  INCIDENT_NEAR_KM: 0.25,
  /** What is left of the floor at the edge of the linking radius, tapering linearly from the near distance out to it. A camera 1.5 km away may be pointed at the right road, which is why it is not zero. */
  INCIDENT_FAR_FACTOR: 0.25,
  /** An hour-of-week cell whose mean frame difference is above this is an hour that moves, so a frame with no movement in it is worth flagging. Twice the noise floor, the same threshold the poller uses to decide a camera has woken up. Judged against the cell's own mean rather than the blended baseline, because the flag claims that this hour expects traffic. */
  AMBIGUOUS_EXPECT_DIFF: ACTIVE_DIFF,
  /** How many frames an hour-of-week cell needs before it is allowed to expect anything, so the flag does not measure how new the profile is. Five, the same as the shrinkage constant, where the cell is trusted as much as the rolling median. */
  AMBIGUOUS_MIN_SAMPLES: 5,
  /** How many cameras are written to the decision log per ranking, which covers everything a viewer could have seen and a margin. */
  LOG_TOP_N: 30,
  /** Never log twice within this many seconds, so two browsers do not double the log for the same decisions. */
  LOG_MIN_INTERVAL_S: 10,
  /** A day's log stops at this size, since the useful part of a log is the beginning of the problem, not the end of the day. */
  LOG_MAX_BYTES: 32 * 1024 * 1024,
} as const;

/** Where one camera's scale prior came from, so the log can say why a camera was ranked where it was. */
export interface ScalePriorFact {
  prior: number;
  source: ScalePriorSource;
  aadt: number | null;
  /** Meters to the count segment, when the prior came from a count. */
  distance_m: number | null;
  aligned: boolean | null;
  highway: string | null;
}

/** 24 hours by 7 days. Indexed day * 24 + hour, in the server's local time, which is exact for cameras in the server's time zone and approximate for the rest. */
const CELLS = 168;

export function hourOfWeek(ts: number): number {
  const when = new Date(ts * 1000);
  return when.getDay() * 24 + when.getHours();
}

/** One camera's history, as a running mean and Welford variance per hour-of-week cell. In memory only; a restart loses every profile and the blend falls back to the rolling median. */
class Profile {
  readonly n = new Int32Array(CELLS);
  readonly mean = new Float64Array(CELLS);
  readonly m2 = new Float64Array(CELLS);

  add(cell: number, diff: number): void {
    const k = (this.n[cell] as number) + 1;
    this.n[cell] = k;
    const delta = diff - (this.mean[cell] as number);
    this.mean[cell] = (this.mean[cell] as number) + delta / k;
    this.m2[cell] = (this.m2[cell] as number) + delta * (diff - (this.mean[cell] as number));
  }
}

export interface ScoreInputs {
  /** Incidents that name this camera, whichever feed they came from. */
  incidents: Incident[];
  now: number;
  queue: QueueEntry[];
}

export class AttentionEngine {
  private readonly profiles = new Map<number, Profile>();
  /** Whether the newest poll of each camera was an ambiguous zero, which is what the wire reports. */
  private readonly flagged = new Map<number, boolean>();
  /** The hour-of-week cell each camera's newest poll fell in, as it stood before that poll was folded into it, so a sudden movement is not measured against an expectation it has already raised. */
  private readonly beforeLatest = new Map<number, { cell: number; n: number; mean: number; m2: number }>();
  /** When each camera's current run of unusual pictures began, for the learning rule in `observe`. */
  private readonly unusualSince = new Map<number, number>();
  private polls = 0;
  private flagCount = 0;
  private readonly pollsByHour = new Int32Array(24);
  private readonly flagsByHour = new Int32Array(24);
  private lastLog = 0;
  private readonly log: JsonLog;
  /** Set by whoever owns an arbiter. Without it the incident floor is exactly the deterministic one. */
  modulate: Modulate | undefined = undefined;
  chosenQueue: ChosenQueue | undefined = undefined;
  /** Set by whoever owns an arbiter. Without it an ambiguous zero is recorded and nothing acts on it. */
  gate: GateFloor | undefined = undefined;
  /** Set by whoever owns an arbiter. Without it the movement term is exactly the equation's. */
  review: ReviewFactor | undefined = undefined;

  constructor(
    private readonly priors: Map<number, ScalePriorFact>,
    logDir: string,
  ) {
    this.log = new JsonLog(logDir, 'attention', TUNING.LOG_MAX_BYTES);
  }

  /** Folds one poll into the camera's hourly profile and decides whether it was an ambiguous zero.
   *
   * Only a fresh frame's difference counts, because the cell has to measure what the rolling median measures, which is taken over changed frames alone. Folding byte-identical polls in as zeros would drag every cell below its rolling median and drift the score upwards. */
  observe(slot: CameraSlot, result: 'fresh' | 'unchanged', now = Date.now() / 1000): void {
    if (result !== 'fresh') return;
    const diff = slot.latest?.diff ?? null;
    // The first frame a camera ever returns has nothing to be differenced against, and says nothing about the scene.
    if (diff === null) return;
    const cell = hourOfWeek(now);
    const hour = cell % 24;
    let profile = this.profiles.get(slot.uid);
    if (!profile) this.profiles.set(slot.uid, (profile = new Profile()));
    this.beforeLatest.set(slot.uid, { cell, n: profile.n[cell] as number, mean: profile.mean[cell] as number, m2: profile.m2[cell] as number });
    const known = (profile.n[cell] as number) >= TUNING.AMBIGUOUS_MIN_SAMPLES;
    const expects = known && (profile.mean[cell] as number) > TUNING.AMBIGUOUS_EXPECT_DIFF;
    const flag = diff <= ACTIVITY_FLOOR && expects;
    this.flagged.set(slot.uid, flag);
    this.polls++;
    this.pollsByHour[hour] = (this.pollsByHour[hour] as number) + 1;
    if (flag) {
      this.flagCount++;
      this.flagsByHour[hour] = (this.flagsByHour[hour] as number) + 1;
    }
    // An event is not folded into the usual, so a camera polled faster does not absorb an ongoing event faster. An unusual level lasting LEARN_RESUME_S is accepted as the new usual.
    const unusual = flag || (known && diff >= TUNING.LEARN_SKIP_RATIO * (profile.mean[cell] as number));
    if (unusual) {
      const since = this.unusualSince.get(slot.uid) ?? now;
      this.unusualSince.set(slot.uid, since);
      if (now - since < TUNING.LEARN_RESUME_S) return;
    } else {
      this.unusualSince.delete(slot.uid);
    }
    profile.add(cell, diff);
  }

  ambiguousZeroStats(): { polls: number; flagged: number; by_hour: (number | null)[] } {
    const byHour: (number | null)[] = [];
    for (let h = 0; h < 24; h++) {
      const polls = this.pollsByHour[h] as number;
      byHour.push(polls === 0 ? null : round((this.flagsByHour[h] as number) / polls, 4));
    }
    return { polls: this.polls, flagged: this.flagCount, by_hour: byHour };
  }

  scalePrior(uid: number): ScalePriorFact {
    return this.priors.get(uid) ?? { prior: TUNING.DEFAULT_PRIOR, source: 'default', aadt: null, distance_m: null, aligned: null, highway: null };
  }

  /** The baseline this camera is measured against right now: its own hour-of-week cell, shrunk towards the rolling median by how many samples the cell has.
   *
   * At N = 0 this returns the rolling median exactly, which is the number `activity` uses. */
  baseline(uid: number, rollingMedian: number | null, cell: number): { mu: number | null; n: number; cellMean: number; sd: number | null } {
    const profile = this.profiles.get(uid);
    // The cell without this camera's newest poll in it, when that poll is what is being scored.
    const before = this.beforeLatest.get(uid);
    const usable = before && before.cell === cell ? before : null;
    const n = usable ? usable.n : profile ? (profile.n[cell] as number) : 0;
    const cellMean = usable ? usable.mean : profile ? (profile.mean[cell] as number) : 0;
    const m2 = usable ? usable.m2 : profile ? (profile.m2[cell] as number) : 0;
    const sd = n >= 2 ? Math.sqrt(Math.max(0, m2 / (n - 1))) : null;
    if (rollingMedian === null) return { mu: n > 0 ? cellMean : null, n, cellMean, sd };
    const k = TUNING.SHRINKAGE_K;
    return { mu: (n / (n + k)) * cellMean + (k / (n + k)) * rollingMedian, n, cellMean, sd };
  }

  /** The decorator `Poller.summaries` takes. `incidentsFor` hands back the incidents naming a camera, which the app indexes once per request rather than per camera. */
  scorer(incidentsFor: (uid: number) => Incident[], now = Date.now() / 1000, queue: Map<number, QueueEntry[]> = new Map()): (slot: CameraSlot, fallbackBaseline: number | null) => Scored {
    const cell = hourOfWeek(now);
    return (slot, fallbackBaseline) => this.score(slot, fallbackBaseline, { incidents: incidentsFor(slot.uid), now, queue: queue.get(slot.uid) ?? [] }, cell);
  }

  private score(slot: CameraSlot, fallbackBaseline: number | null, inputs: ScoreInputs, cell: number): Scored {
    const frame = slot.latest;
    const diff = frame ? frame.diff : null;
    // The same choice of rolling median `activity` makes, so the two cannot diverge.
    const rolling = slot.diffs.length >= ACTIVITY_MIN_SAMPLES ? median(slot.diffs) : fallbackBaseline;
    const { mu, n, sd } = this.baseline(slot.uid, rolling, cell);

    // Capped while the camera's own history is short, by the same rule `activity` applies, so the two still agree exactly before any hourly history exists.
    const anomaly = diff === null || mu === null ? null : round(Math.min(warmupCap(slot.diffs.length), (TUNING.ANOMALY_AT_BASELINE * diff) / Math.max(mu, ACTIVITY_FLOOR)), 3);
    const prior = this.scalePrior(slot.uid);
    const absolute = diff === null ? 0 : Math.min(1, diff / TUNING.ABSOLUTE_FULL_SCALE);
    const relative = anomaly ?? 0;
    // Movement alone. The scale prior is applied once to the weighted sum of both axes below.
    const spectacle = anomaly === null ? null : round(TUNING.ALPHA_ABSOLUTE * absolute + (1 - TUNING.ALPHA_ABSOLUTE) * relative, 3);
    const amplifier = scaleAmplifier(prior.prior);

    const floor = incidentFloor({ uid: slot.uid, lat: slot.camera.lat, lon: slot.camera.lon, now: inputs.now, modulate: this.modulate }, inputs.incidents);
    // Stopped traffic confirmed by the arbiter carries a floor of its own, kept apart from the incident floor so the log can tell a dispatcher's evidence from a picture's.
    const gate = this.gate ? this.gate(slot.uid, inputs.now) : null;
    const queued = queueFloor(slot.uid, inputs.queue, inputs.now, this.chosenQueue, this.gate);
    const gateValue = gate?.value ?? 0;
    // The second look scales movement and nothing else, so an incident or stopped traffic keeps exactly the floor it earned.
    const review = this.review ? this.review(slot.uid, inputs.now) : null;

    const axes: AttentionAxes = {
      anomaly,
      spectacle,
      incident_floor: round(floor.value, 3),
      queue_floor: round(queued.value, 3),
      queue: queued.queue,
      incident_floor_base: round(floor.base, 3),
      incident: floor.incident,
      scale_prior: round(prior.prior, 3),
      scale_prior_source: prior.source,
      scale_amplifier: round(amplifier, 3),
      baseline: mu === null ? null : round(mu, 5),
      baseline_n: n,
      baseline_sd: sd,
      ambiguous_zero: this.flagged.get(slot.uid) ?? false,
      gate: gate?.influence ?? null,
      jev: floor.jev,
      review,
    };
    // Nothing is known about this camera yet and nothing is pointing at it, so it has no score rather than a score of zero, which would mean a still frame.
    if (anomaly === null && floor.value === 0 && queued.value === 0 && gateValue === 0) return { attention: null, axes };
    const movement = amplifier * (TUNING.WEIGHT_ANOMALY * (anomaly ?? 0) + TUNING.WEIGHT_SPECTACLE * (spectacle ?? 0));
    const strongest = Math.max(floor.value, queued.value, gateValue);
    // The fixed equation on its own, without the second look.
    axes.equation = round(combineAttention(movement, strongest), 3);
    const looked = movement * (review?.acted ? review.factor : 1);
    // What a capped ranking falls back to for a camera held by a floor.
    axes.movement = round(clamp(looked), 3);
    return { attention: round(combineAttention(looked, strongest), 3), axes };
  }

  /** One line per camera in the top of the ranking, so that a decision the wall made ten minutes ago can still be taken apart. */
  logRanking(states: CameraState[], now = Date.now() / 1000): void {
    if (now - this.lastLog < TUNING.LOG_MIN_INTERVAL_S) return;
    this.lastLog = now;
    const ranked = states
      .filter((state) => state.attention !== null && state.axes !== null)
      .sort((a, b) => (b.attention as number) - (a.attention as number))
      .slice(0, TUNING.LOG_TOP_N);
    if (ranked.length === 0) return;
    const ts = round(now, 3);
    this.log.write(
      ranked.map((state, rank) => {
        const axes = state.axes as AttentionAxes;
        const prior = this.scalePrior(state.id);
        return {
          ts,
          id: state.id,
          region: state.region ?? null,
          rank,
          attention: state.attention,
          activity: state.activity,
          diff: state.diff,
          anomaly: axes.anomaly,
          spectacle: axes.spectacle,
          baseline: axes.baseline,
          baseline_n: axes.baseline_n,
          baseline_sd: axes.baseline_sd,
          scale_prior: axes.scale_prior,
          scale_prior_source: axes.scale_prior_source,
          aadt: prior.aadt,
          highway: prior.highway,
          incident_floor: axes.incident_floor,
          queue_floor: axes.queue_floor,
          queue: axes.queue,
          incident_floor_base: axes.incident_floor_base,
          incident: axes.incident,
          jev: axes.jev,
          ambiguous_zero: axes.ambiguous_zero,
          gate: axes.gate,
          scale_amplifier: axes.scale_amplifier,
          review: axes.review ?? null,
          equation: axes.equation ?? null,
        };
      }),
      now,
    );
  }

  /** Resolves once every queued line is on disk, for a test that needs to read the file back. */
  async drain(): Promise<void> {
    await this.log.drain();
  }

  /** Where this ranking's records went. */
  logPath(now: number): string {
    return this.log.path(now);
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The scale prior as the score actually uses it. A prior of 0 damps the visual sum to half, a prior of 1 lifts it by half, and a camera with no prior at all sits near the middle by way of TUNING.DEFAULT_PRIOR. */
export function scaleAmplifier(prior: number): number {
  const span = TUNING.SCALE_AMPLIFIER_MAX - TUNING.SCALE_AMPLIFIER_MIN;
  return TUNING.SCALE_AMPLIFIER_MIN + span * clamp(prior);
}

/** What a camera is worth to the arbiter, if anything was asked about it. Injected so the scorer stays arithmetic. */
export type Modulate = (incident: Incident, uid: number, deterministic: number) => { value: number; influence: JevInfluence | null };

/** What a still camera is worth, if anything was asked about it. Injected like `Modulate`. */
export type GateFloor = (uid: number, now: number) => { value: number; at: number; influence: GateInfluence } | null;

/** The factor a second look put on one camera's movement term, if any. */
export type ReviewFactor = (uid: number, now: number) => ReviewInfluence | null;

export interface FloorContext {
  uid: number;
  lat: number;
  lon: number;
  now: number;
  modulate?: Modulate | undefined;
}

/** The highest floor any nearby incident puts under a camera, which incident it was, and what the arbiter did to it.
 *
 * Distance and age both only ever reduce it. An incident with no readable date gets no floor at all, because a floor with nothing to decay against would pin a camera for as long as the record stayed open.
 *
 * The modulation is applied inside the loop rather than to the winner, because an incident the arbiter has lifted may deserve the camera more than the one ahead of it on distance and age alone. */
export function incidentFloor(ctx: FloorContext, incidents: Incident[]): { value: number; base: number; incident: string | null; jev: JevInfluence | null } {
  let best = 0;
  let deterministic = 0;
  let which: string | null = null;
  let influence: JevInfluence | null = null;
  for (const incident of incidents) {
    const level = incident.implies_closure ? TUNING.FLOOR_CLOSURE : incident.road_relevant ? TUNING.FLOOR_ROAD_RELEVANT : TUNING.FLOOR_OTHER;
    if (level === 0 || incident.reported_at === null) continue;
    const age = Math.max(0, ctx.now - incident.reported_at);
    const km = distanceKm(ctx.lat, ctx.lon, incident.lat, incident.lon);
    const plain = level * distanceFactor(km) * Math.pow(0.5, Math.max(0, age - TUNING.INCIDENT_FULL_S) / TUNING.INCIDENT_HALF_LIFE_S);
    const adjusted = ctx.modulate ? ctx.modulate(incident, ctx.uid, plain) : { value: plain, influence: null };
    if (adjusted.value > best) {
      best = adjusted.value;
      deterministic = plain;
      which = `${incident.type} at ${incident.location}`;
      influence = adjusted.influence;
    }
  }
  return { value: best, base: deterministic, incident: which, jev: influence };
}

export type QueueEntry = IncidentQueueEntry | StandstillQueueEntry;

interface StandstillQueueEntry {
  source: 'standstill';
  description: string;
  anchor: { uid: number; lat: number; lon: number };
  length_m: number;
  wave_s: number | null;
  upstream: boolean;
}

interface IncidentQueueEntry {
  source?: 'incident';
  incident: Incident;
  anchor: { uid: number; lat: number; lon: number };
  anchors: { uid: number; lat: number; lon: number }[];
  length_m: number;
  wave_s: number | null;
  upstream: boolean;
}

/** Injected like Modulate so the scorer need not know how a neighbor was chosen. Null means no confident choice. */
export type ChosenQueue = (incident: Incident, uid: number, recordFloor: number) => number | null;

/** The inferred floor rises as a queue could arrive, then decays with the record's half-life. Reach is a ramp because the wave speed is not measured on these corridors and a hard arrival cutoff would imply false precision. */
export function queueFloor(uid: number, entries: QueueEntry[], now: number, chosen?: ChosenQueue, gate?: GateFloor): { value: number; queue: AttentionAxes['queue'] } {
  let value = 0;
  let queue: AttentionAxes['queue'] = null;
  for (const entry of entries) {
    const { anchor, length_m, wave_s } = entry;
    if (entry.source === 'standstill') {
      const held = gate?.(anchor.uid, now);
      if (!held || held.value <= 0 || uid === anchor.uid) continue;
      const age = Math.max(0, now - held.at);
      const reach = wave_s === null ? 0 : wave_s <= 0 ? (age > 0 ? 1 : 0) : clamp(age / wave_s);
      const floor = entry.upstream ? held.value * TUNING.UPSTREAM_SHARE * clamp(1 - length_m / CORRIDOR.MAX_UPSTREAM_M) * reach : 0;
      if (floor > value) {
        value = floor;
        queue = { source: 'standstill', incident: entry.description, anchor: anchor.uid, length_m, reach, jev_chosen: false };
      }
      continue;
    }
    const { incident } = entry;
    if (incident.cameras.includes(uid) || incident.reported_at === null) continue;
    const anchor_floor = incidentFloor({ ...anchor, now }, [incident]).value;
    const age_s = Math.max(0, now - incident.reported_at);
    const reach = wave_s === null ? 0 : wave_s <= 0 ? (age_s > 0 ? 1 : 0) : clamp(age_s / wave_s);
    const road_falloff = clamp(1 - length_m / CORRIDOR.MAX_UPSTREAM_M);
    const candidate = entry.upstream ? anchor_floor * TUNING.UPSTREAM_SHARE * road_falloff * reach : 0;
    const record_floor = chosen ? Math.max(0, ...entry.anchors.map((camera) => incidentFloor({ ...camera, now }, [incident]).value)) : 0;
    const picked = chosen?.(incident, uid, record_floor) ?? null;
    const floor = Math.max(candidate, picked ?? 0);
    if (floor > value) {
      value = floor;
      queue = { source: 'incident', incident: `${incident.type} at ${incident.location}`, anchor: anchor.uid, length_m, reach, jev_chosen: picked !== null };
    }
  }
  return { value, queue };
}

function distanceFactor(km: number): number {
  if (km <= TUNING.INCIDENT_NEAR_KM) return 1;
  if (km >= CAMERA_RADIUS_KM) return TUNING.INCIDENT_FAR_FACTOR;
  const span = CAMERA_RADIUS_KM - TUNING.INCIDENT_NEAR_KM;
  return 1 - (1 - TUNING.INCIDENT_FAR_FACTOR) * ((km - TUNING.INCIDENT_NEAR_KM) / span);
}

/** A published count mapped onto 0..1, logarithmically because the counts span three orders of magnitude. */
export function aadtPrior(aadt: number): number {
  const scaled = (Math.log10(1 + Math.max(0, aadt)) - TUNING.AADT_LOG_MIN) / (TUNING.AADT_LOG_MAX - TUNING.AADT_LOG_MIN);
  return clamp(scaled);
}

/** Tagged lanes and speed approximate road capacity when published counts are unavailable; absent lanes remain unknown. */
export function capacityPrior(snap: Snap | null | undefined): number | null {
  const lanes = snap?.lanes;
  const speed = snap?.maxspeed_kmh;
  if (lanes == null || !Number.isInteger(lanes) || lanes <= 0 || speed == null || !Number.isFinite(speed) || speed <= 0) return null;
  const directional = snap?.two_way ? Math.ceil(lanes / 2) : lanes;
  return clamp((Math.log(directional * speed) - Math.log(TUNING.CAP_MIN)) / (Math.log(TUNING.CAP_MAX) - Math.log(TUNING.CAP_MIN)));
}

/** A road class mapped onto the same 0..1 when neither a published count nor tagged lanes are available. */
export function classPrior(highway: string | null): number | null {
  if (!highway) return null;
  const direct = TUNING.CLASS_PRIOR[highway];
  if (direct !== undefined) return direct;
  if (highway.endsWith('_link')) {
    const parent = TUNING.CLASS_PRIOR[highway.slice(0, -'_link'.length)];
    if (parent !== undefined) return round(parent * TUNING.LINK_FACTOR, 3);
  }
  return null;
}

/** One scale prior per camera, from the counts where a region has them and from capacity or road class elsewhere. Camera ids here are global, while count files are keyed by native id, so the block arithmetic is undone to look a camera up. */
export function buildScalePriors(options: { regions: string[]; graphs: Map<string, Graph>; root: string; uidBlock: number }): Map<number, ScalePriorFact> {
  const priors = new Map<number, ScalePriorFact>();
  for (const region of options.regions) {
    const graph = options.graphs.get(region);
    if (!graph) continue;
    const counts = loadAadt(options.root, region);
    const sites = new Map<string, Site>(graph.sites.map((site) => [site.id, site]));
    for (const camera of graph.cameras) {
      const record = counts?.cameras.get(camera.id % options.uidBlock);
      const snap = cameraSnap(sites.get(camera.site ?? ''), camera.id);
      const highway = snap?.highway ?? null;
      if (record) {
        priors.set(camera.id, { prior: round(aadtPrior(record.aadt), 3), source: 'aadt', aadt: record.aadt, distance_m: record.distance_m, aligned: record.aligned, highway });
        continue;
      }
      const capacity = capacityPrior(snap);
      if (capacity !== null) {
        priors.set(camera.id, { prior: round(capacity, 3), source: 'capacity', aadt: null, distance_m: null, aligned: null, highway });
        continue;
      }
      const fallback = classPrior(highway);
      if (fallback !== null) priors.set(camera.id, { prior: fallback, source: 'class', aadt: null, distance_m: null, aligned: null, highway });
    }
  }
  return priors;
}

/** The road segment a camera was snapped to. A site's snaps are written in the same order as its cameras; the first stands in when the lists have drifted apart. */
function cameraSnap(site: Site | undefined, uid: number): Snap | null {
  const snaps = site?.snaps;
  if (!site || !snaps || snaps.length === 0) return null;
  const index = site.cameras.indexOf(uid);
  return (index >= 0 ? snaps[index] : null) ?? snaps[0] ?? null;
}

/** A floor wins a tie because it is the reason attention cannot drop even if movement eases. Equal floors prefer incident, then queue, then still for a stable explanation. */
export function driver(axes: AttentionAxes): ScoreDriver {
  const movement = axes.scale_amplifier * (axes.review?.acted ? axes.review.factor : 1) * (TUNING.WEIGHT_ANOMALY * (axes.anomaly ?? 0) + TUNING.WEIGHT_SPECTACLE * (axes.spectacle ?? 0));
  const still = axes.gate?.floor ?? 0;
  if (axes.incident_floor >= movement && axes.incident_floor >= still && axes.incident_floor >= axes.queue_floor) return 'incident';
  if (axes.queue_floor >= movement && axes.queue_floor >= still) return 'queue';
  if (still >= movement) return 'still';
  return 'movement';
}

/** Empty regions remain visible and average only the scored cameras available when fewer than five have returned a score. */
export function summarizeRegions(regions: { key: string; name: string }[], cameras: ScoreCamera[]): ScoreRegion[] {
  return regions.map(({ key, name }) => {
    const ranked = cameras.filter((camera) => camera.region === key).sort((a, b) => b.attention - a.attention);
    const first = ranked[0];
    const five = ranked.slice(0, 5);
    return {
      key, name, scored: ranked.length,
      top: first ? { id: first.id, location: first.location, attention: first.attention } : null,
      top5_mean: five.length ? five.reduce((sum, camera) => sum + camera.attention, 0) / five.length : 0,
      incident_floored: ranked.filter((camera) => camera.axes.incident_floor > 0).length,
      still: ranked.filter((camera) => camera.axes.ambiguous_zero).length,
    };
  });
}
