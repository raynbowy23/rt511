/** What is worth looking at, and why.
 *
 * `activity` answers one question well: is this camera busier than it usually is. It cannot answer the two that follow from it. A residential street at twice its own median outranks an interstate at its own median, although one of them is six lanes of traffic and the other is a car. And a camera that has just gone still is scored the same whether the road emptied or the feed froze.
 *
 * So the score here is built from three axes that are kept apart and reported apart. `anomaly` is the old measure with a better baseline: what this camera does at this hour of this day, shrunk towards the rolling median until the hour has enough samples to speak for itself. `spectacle` is how much the camera matters at all, from published traffic counts where a state publishes them and from road capacity or class elsewhere. `incidentFloor` is the state patrol saying something is happening here, which puts a floor under the camera that decays as the incident ages.
 *
 * The frozen-camera question is not answered. It is only recorded: AMBIGUOUS_ZERO marks a frame that changed by nothing in an hour that usually moves. Nothing acts on it, because acting on it either way would be a guess, and the flag exists to find out how often the guess would have to be made. */
import { CAMERA_RADIUS_KM, distanceKm } from './cad.js';
import { loadAadt, round } from './config.js';
import { CORRIDOR } from './corridor.js';
import { JsonLog } from './jsonlog.js';
import { ACTIVE_DIFF, ACTIVITY_FLOOR, ACTIVITY_MIN_SAMPLES, median } from './poller.js';
/** Every number the score depends on, in one place, because a constant buried in the expression that uses it is a constant nobody ever revisits. */
export const TUNING = {
    /** Effective sample size of the rolling median in the baseline blend. An hour-of-week cell needs five polls of its own before it carries as much weight as the median it is displacing: five minutes for a camera on screen, closer to half an hour for one in a watched city that nobody is looking at. */
    SHRINKAGE_K: 5,
    /** Frame difference equal to the baseline scores this, so an ordinary camera doing an ordinary thing sits in the middle of the range and twice the baseline saturates. Inherited from `activity` and kept identical on purpose: it is what makes the two agree exactly before any hourly history exists. */
    ANOMALY_AT_BASELINE: 0.5,
    /** The two axes weigh the same. Anomaly alone is today's behaviour, spectacle alone would rank a quiet interstate above a busy side street forever, and there is no measurement yet that says either deserves more. */
    WEIGHT_ANOMALY: 0.5,
    WEIGHT_SPECTACLE: 0.5,
    /** How much of the spectacle term comes from absolute movement rather than movement relative to the camera's own baseline. Shipped at zero: there is no absolute measure of how many vehicles are in a frame in this project, only a mean absolute pixel difference, which varies with camera resolution, lens, weather and time of day and is not comparable between cameras. The term is wired so that a real volume measure can be weighed in by changing this one number, and until there is one it contributes nothing. */
    ALPHA_ABSOLUTE: 0,
    /** The frame difference the absolute term would call saturated. A stand-in, not a measurement, and it has no effect while ALPHA_ABSOLUTE is zero. */
    ABSOLUTE_FULL_SCALE: 0.05,
    /** What a scale prior of 0 and a scale prior of 1 multiply the visual sum by. The prior enters the score here, as one amplifier on the weighted sum of both visual axes, rather than as a factor buried inside the spectacle axis.
     *
     * Two reasons for the move. The prior was previously applied to spectacle and the weighted sum then applied spectacle at half weight, so its real effect on the score was an amplifier over 0.5 to 1.0 that no constant in this file stated. And with the prior inside one axis, that axis was no longer a measure of movement, which made the two axes harder to read apart in the log than the design intends.
     *
     * The range is deliberately narrow and its lower end is well above zero. The prior describes how much traffic a road carries, which is a reason to prefer one camera over another when both are doing something, and never a reason to hide a residential street where something is plainly happening. */
    SCALE_AMPLIFIER_MIN: 0.5,
    SCALE_AMPLIFIER_MAX: 1.5,
    /** Traffic counts are mapped through log10(1 + aadt) and then onto 0..1 between these two. A thousand vehicles a day is a street nobody would watch and two hundred thousand is an urban interstate; the five published files this project has joined run from 650 to 253,000, so both ends of the scale are reachable and neither is crowded. */
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
    },
    /** A ramp carries a fraction of the road it serves, so `motorway_link` scores below `motorway`. A judgement rather than a measurement: nothing in the data says what the fraction is. */
    LINK_FACTOR: 0.7,
    /** A camera the graph builder could not place on a road at all. Scored as an ordinary street rather than as nothing, because an unplaced camera is usually a rest area or a bridge view, not a driveway. */
    DEFAULT_PRIOR: 0.3,
    /** A dispatch code that says the road itself is blocked. High enough that such a camera is on the wall whatever the picture is doing. */
    FLOOR_CLOSURE: 0.9,
    /** A code about the road but not necessarily blocking it. */
    FLOOR_ROAD_RELEVANT: 0.6,
    /** Codes that are ordinary police business get no floor at all, whatever the distance. */
    FLOOR_OTHER: 0,
    /** An upstream queue is inferred rather than seen, so it receives only sixty percent of the scene floor. */
    UPSTREAM_SHARE: 0.6,
    /** The floor halves every half hour. A crash is worth interrupting the wall for; the same crash two hours later is not. */
    INCIDENT_HALF_LIFE_S: 1800,
    /** Inside this distance the camera is treated as looking straight at the incident. */
    INCIDENT_NEAR_KM: 0.25,
    /** What is left of the floor at the edge of the linking radius, tapering linearly from the near distance out to it. A camera 1.5 km away may be pointed at the right road, which is why it is not zero. */
    INCIDENT_FAR_FACTOR: 0.25,
    /** An hour-of-week cell whose mean frame difference is above this is an hour that moves, so a frame with no movement in it is worth flagging. Twice the noise floor, the same threshold the poller uses to decide a camera has woken up.
     *
     * Judged against the cell's own mean rather than against the blended baseline: the whole claim the flag makes is that *this hour* expects traffic, and a blend that is mostly the rolling median would let it fire about a camera nothing is known about. */
    AMBIGUOUS_EXPECT_DIFF: ACTIVE_DIFF,
    /** How many frames an hour-of-week cell needs before it is allowed to expect anything. A cell holding one busy frame and one still one technically expects activity, and a flag that fires on that measures how new the profile is rather than anything about the road: an earlier build with no such guard fired on 34% of polls three minutes into a run and on 12.8% over a longer one. Five, the same as the shrinkage constant, because that is the point at which the cell is already trusted as much as the rolling median. */
    AMBIGUOUS_MIN_SAMPLES: 5,
    /** How many cameras are written to the decision log per ranking. The wall shows nothing like thirty at once, so this covers everything a viewer could have seen and a margin of what nearly made it. */
    LOG_TOP_N: 30,
    /** Never log twice within this many seconds. The wall asks for state every ten seconds; two browsers would otherwise double the log for the same decisions. */
    LOG_MIN_INTERVAL_S: 10,
    /** A day's log stops at this size. At thirty lines every ten seconds a day comes to a few hundred megabytes if nothing stops it, and the useful part of a log is the beginning of the problem, not the end of the day. */
    LOG_MAX_BYTES: 32 * 1024 * 1024,
};
/** 24 hours by 7 days. Indexed day * 24 + hour, in the server's local time: a camera's rush hour is a fact about the road in front of it, and the server and the road are in the same country but not always in the same time zone, so this is right for the states nearest the server and approximate for the rest. */
const CELLS = 168;
export function hourOfWeek(ts) {
    const when = new Date(ts * 1000);
    return when.getDay() * 24 + when.getHours();
}
/** One camera's history, as a running mean and Welford variance per hour-of-week cell. Running rather than a window: the mean of everything this camera has done at this hour is exactly what the blend wants, and it costs three numbers per cell instead of a list. In memory only. A restart loses every profile and the blend falls back to the rolling median, which is where it started. */
class Profile {
    n = new Int32Array(CELLS);
    mean = new Float64Array(CELLS);
    m2 = new Float64Array(CELLS);
    add(cell, diff) {
        const k = this.n[cell] + 1;
        this.n[cell] = k;
        const delta = diff - this.mean[cell];
        this.mean[cell] = this.mean[cell] + delta / k;
        this.m2[cell] = this.m2[cell] + delta * (diff - this.mean[cell]);
    }
}
export class AttentionEngine {
    priors;
    profiles = new Map();
    /** Whether the newest poll of each camera was an ambiguous zero, which is what the wire reports. The counters below are what the rate is measured from. */
    flagged = new Map();
    /** The hour-of-week cell each camera's newest poll fell in, as it stood before that poll was folded into it. A frame has to be judged against the hour it arrived into rather than the hour it has already changed, or a camera that suddenly moves raises the very expectation it is being measured against and reads as less of a surprise than it is. */
    beforeLatest = new Map();
    polls = 0;
    flagCount = 0;
    pollsByHour = new Int32Array(24);
    flagsByHour = new Int32Array(24);
    lastLog = 0;
    log;
    /** Set by whoever owns an arbiter. Without it the incident floor is exactly the deterministic one, which is what it was before Jev existed. */
    modulate = undefined;
    chosenQueue = undefined;
    /** Set by whoever owns an arbiter. Without it an ambiguous zero is recorded and nothing acts on it, which is what it was before the gate had anywhere to ask. */
    gate = undefined;
    constructor(priors, logDir) {
        this.priors = priors;
        this.log = new JsonLog(logDir, 'attention', TUNING.LOG_MAX_BYTES);
    }
    /** Folds one poll into the camera's hourly profile and decides whether it was an ambiguous zero.
     *
     * Only a fresh frame's difference counts. A poll that returned byte-identical bytes looks like a difference of zero and is tempting to fold in as one, but the cell has to measure what the rolling median measures, and that median is taken over changed frames alone. Mixing the two drags every cell below its own rolling median as the identical polls accumulate, and the score drifts upwards for no reason in the world. */
    observe(slot, result, now = Date.now() / 1000) {
        if (result !== 'fresh')
            return;
        const diff = slot.latest?.diff ?? null;
        // The first frame a camera ever returns has nothing to be differenced against, and says nothing about the scene.
        if (diff === null)
            return;
        const cell = hourOfWeek(now);
        const hour = cell % 24;
        let profile = this.profiles.get(slot.uid);
        if (!profile)
            this.profiles.set(slot.uid, (profile = new Profile()));
        this.beforeLatest.set(slot.uid, { cell, n: profile.n[cell], mean: profile.mean[cell], m2: profile.m2[cell] });
        const expects = profile.n[cell] >= TUNING.AMBIGUOUS_MIN_SAMPLES && profile.mean[cell] > TUNING.AMBIGUOUS_EXPECT_DIFF;
        const flag = diff <= ACTIVITY_FLOOR && expects;
        this.flagged.set(slot.uid, flag);
        this.polls++;
        this.pollsByHour[hour] = this.pollsByHour[hour] + 1;
        if (flag) {
            this.flagCount++;
            this.flagsByHour[hour] = this.flagsByHour[hour] + 1;
        }
        profile.add(cell, diff);
    }
    ambiguousZeroStats() {
        const byHour = [];
        for (let h = 0; h < 24; h++) {
            const polls = this.pollsByHour[h];
            byHour.push(polls === 0 ? null : round(this.flagsByHour[h] / polls, 4));
        }
        return { polls: this.polls, flagged: this.flagCount, by_hour: byHour };
    }
    scalePrior(uid) {
        return this.priors.get(uid) ?? { prior: TUNING.DEFAULT_PRIOR, source: 'default', aadt: null, distance_m: null, aligned: null, highway: null };
    }
    /** The baseline this camera is measured against right now: its own hour-of-week cell, shrunk towards the rolling median by how many samples the cell has.
     *
     * At N = 0 this returns the rolling median exactly, which is the number `activity` already uses, so a cold process ranks cameras exactly as it did before this file existed. */
    baseline(uid, rollingMedian, cell) {
        const profile = this.profiles.get(uid);
        // The cell without this camera's newest poll in it, when that poll is what is being scored. A camera that has not been polled this hour is scored against the whole cell, because nothing in it is the frame in hand.
        const before = this.beforeLatest.get(uid);
        const usable = before && before.cell === cell ? before : null;
        const n = usable ? usable.n : profile ? profile.n[cell] : 0;
        const cellMean = usable ? usable.mean : profile ? profile.mean[cell] : 0;
        const m2 = usable ? usable.m2 : profile ? profile.m2[cell] : 0;
        const sd = n >= 2 ? Math.sqrt(Math.max(0, m2 / (n - 1))) : null;
        if (rollingMedian === null)
            return { mu: n > 0 ? cellMean : null, n, cellMean, sd };
        const k = TUNING.SHRINKAGE_K;
        return { mu: (n / (n + k)) * cellMean + (k / (n + k)) * rollingMedian, n, cellMean, sd };
    }
    /** The decorator `Poller.summaries` takes. `incidentsFor` hands back the incidents naming a camera, which the app indexes once per request rather than per camera. */
    scorer(incidentsFor, now = Date.now() / 1000, queue = new Map()) {
        const cell = hourOfWeek(now);
        return (slot, fallbackBaseline) => this.score(slot, fallbackBaseline, { incidents: incidentsFor(slot.uid), now, queue: queue.get(slot.uid) ?? [] }, cell);
    }
    score(slot, fallbackBaseline, inputs, cell) {
        const frame = slot.latest;
        const diff = frame ? frame.diff : null;
        // The same choice of rolling median `activity` makes, taken the same way, so that the two cannot diverge over a change to one of them.
        const rolling = slot.diffs.length >= ACTIVITY_MIN_SAMPLES ? median(slot.diffs) : fallbackBaseline;
        const { mu, n, sd } = this.baseline(slot.uid, rolling, cell);
        const anomaly = diff === null || mu === null ? null : round(Math.min(1, (TUNING.ANOMALY_AT_BASELINE * diff) / Math.max(mu, ACTIVITY_FLOOR)), 3);
        const prior = this.scalePrior(slot.uid);
        const absolute = diff === null ? 0 : Math.min(1, diff / TUNING.ABSOLUTE_FULL_SCALE);
        const relative = anomaly ?? 0;
        // Movement alone. The scale prior used to be applied here and is now applied once to the weighted sum of both axes, so that it cannot enter the score twice and so that this number stays a measure of what the picture is doing.
        const spectacle = anomaly === null ? null : round(TUNING.ALPHA_ABSOLUTE * absolute + (1 - TUNING.ALPHA_ABSOLUTE) * relative, 3);
        const amplifier = scaleAmplifier(prior.prior);
        const floor = incidentFloor({ uid: slot.uid, lat: slot.camera.lat, lon: slot.camera.lon, now: inputs.now, modulate: this.modulate }, inputs.incidents);
        // A camera the gate fired on, that the arbiter has since called stopped traffic, carries a floor of its own. Kept apart from the incident floor rather than folded into it: one comes from a dispatcher and the other from a picture, and a log that cannot tell them apart cannot be used to calibrate either.
        const gate = this.gate ? this.gate(slot.uid, inputs.now) : null;
        const queued = queueFloor(slot.uid, inputs.queue, inputs.now, this.chosenQueue, this.gate);
        const gateValue = gate?.value ?? 0;
        const axes = {
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
        };
        // Nothing is known about this camera yet and no incident is pointing at it, so it has no score rather than a score of zero: a camera that has not returned a frame and one that has returned a still frame are different things and the wall treats them differently.
        if (anomaly === null && floor.value === 0 && queued.value === 0 && gateValue === 0)
            return { attention: null, axes };
        const combined = amplifier * (TUNING.WEIGHT_ANOMALY * (anomaly ?? 0) + TUNING.WEIGHT_SPECTACLE * (spectacle ?? 0));
        return { attention: round(clamp(Math.max(combined, floor.value, queued.value, gateValue)), 3), axes };
    }
    /** One line per camera in the top of the ranking, so that a decision the wall made ten minutes ago can still be taken apart.
     *
     * Rotated by day and capped, and written off the request path: a log that blocked the state endpoint or filled the disk would be a worse bug than anything it could help find. */
    logRanking(states, now = Date.now() / 1000) {
        if (now - this.lastLog < TUNING.LOG_MIN_INTERVAL_S)
            return;
        this.lastLog = now;
        const ranked = states
            .filter((state) => state.attention !== null && state.axes !== null)
            .sort((a, b) => b.attention - a.attention)
            .slice(0, TUNING.LOG_TOP_N);
        if (ranked.length === 0)
            return;
        const ts = round(now, 3);
        this.log.write(ranked.map((state, rank) => {
            const axes = state.axes;
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
            };
        }), now);
    }
    /** Resolves once every queued line is on disk, for a test that needs to read the file back. */
    async drain() {
        await this.log.drain();
    }
    /** Where this ranking's records went. */
    logPath(now) {
        return this.log.path(now);
    }
}
function clamp(value) {
    return Math.min(1, Math.max(0, value));
}
/** The scale prior as the score actually uses it. A prior of 0 damps the visual sum to half, a prior of 1 lifts it by half, and a camera with no prior at all sits near the middle by way of TUNING.DEFAULT_PRIOR. */
export function scaleAmplifier(prior) {
    const span = TUNING.SCALE_AMPLIFIER_MAX - TUNING.SCALE_AMPLIFIER_MIN;
    return TUNING.SCALE_AMPLIFIER_MIN + span * clamp(prior);
}
/** The highest floor any nearby incident puts under a camera, which incident it was, and what the arbiter did to it.
 *
 * Distance and age both only ever reduce it. An incident with no readable date gets no floor at all: the feed lists incidents for days, and a floor with nothing to decay against would pin a camera to the top of the wall for as long as the dispatcher left the record open.
 *
 * The modulation is applied inside the loop rather than to the winner, because an incident the arbiter has lifted may deserve the camera more than the one that was ahead of it on distance and age alone. `base` is kept alongside so the two numbers can be compared in the log. */
export function incidentFloor(ctx, incidents) {
    let best = 0;
    let deterministic = 0;
    let which = null;
    let influence = null;
    for (const incident of incidents) {
        const level = incident.implies_closure ? TUNING.FLOOR_CLOSURE : incident.road_relevant ? TUNING.FLOOR_ROAD_RELEVANT : TUNING.FLOOR_OTHER;
        if (level === 0 || incident.reported_at === null)
            continue;
        const age = Math.max(0, ctx.now - incident.reported_at);
        const km = distanceKm(ctx.lat, ctx.lon, incident.lat, incident.lon);
        const plain = level * distanceFactor(km) * Math.pow(0.5, age / TUNING.INCIDENT_HALF_LIFE_S);
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
/** The inferred floor rises as a queue could arrive, then decays with the record's half-life. Reach is a ramp because the wave speed is an uncited design setting and a hard arrival cutoff would imply false precision. */
export function queueFloor(uid, entries, now, chosen, gate) {
    let value = 0;
    let queue = null;
    for (const entry of entries) {
        const { anchor, length_m, wave_s } = entry;
        if (entry.source === 'standstill') {
            const held = gate?.(anchor.uid, now);
            if (!held || held.value <= 0 || uid === anchor.uid)
                continue;
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
        if (incident.cameras.includes(uid) || incident.reported_at === null)
            continue;
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
function distanceFactor(km) {
    if (km <= TUNING.INCIDENT_NEAR_KM)
        return 1;
    if (km >= CAMERA_RADIUS_KM)
        return TUNING.INCIDENT_FAR_FACTOR;
    const span = CAMERA_RADIUS_KM - TUNING.INCIDENT_NEAR_KM;
    return 1 - (1 - TUNING.INCIDENT_FAR_FACTOR) * ((km - TUNING.INCIDENT_NEAR_KM) / span);
}
/** A published count mapped onto 0..1. Logarithmic because the counts span three orders of magnitude and the difference between 1,000 and 10,000 vehicles a day matters far more than the difference between 190,000 and 200,000. */
export function aadtPrior(aadt) {
    const scaled = (Math.log10(1 + Math.max(0, aadt)) - TUNING.AADT_LOG_MIN) / (TUNING.AADT_LOG_MAX - TUNING.AADT_LOG_MIN);
    return clamp(scaled);
}
/** Tagged lanes and speed approximate road capacity when published counts are unavailable; absent lanes remain unknown. */
export function capacityPrior(snap) {
    const lanes = snap?.lanes;
    const speed = snap?.maxspeed_kmh;
    if (lanes == null || !Number.isInteger(lanes) || lanes <= 0 || speed == null || !Number.isFinite(speed) || speed <= 0)
        return null;
    const directional = snap?.two_way ? Math.ceil(lanes / 2) : lanes;
    return clamp((Math.log(directional * speed) - Math.log(TUNING.CAP_MIN)) / (Math.log(TUNING.CAP_MAX) - Math.log(TUNING.CAP_MIN)));
}
/** A road class mapped onto the same 0..1 when neither a published count nor tagged lanes are available. */
export function classPrior(highway) {
    if (!highway)
        return null;
    const direct = TUNING.CLASS_PRIOR[highway];
    if (direct !== undefined)
        return direct;
    if (highway.endsWith('_link')) {
        const parent = TUNING.CLASS_PRIOR[highway.slice(0, -'_link'.length)];
        if (parent !== undefined)
            return round(parent * TUNING.LINK_FACTOR, 3);
    }
    return null;
}
/** One scale prior per camera, from the counts where a region has them and from capacity or road class elsewhere.
 *
 * Camera ids here are the global ones, because that is what the rest of the server speaks by the time this runs. The count files are written by the Python pipeline, which only ever sees one site at a time and therefore keys them by native id, so the block arithmetic is undone to look a camera up. */
export function buildScalePriors(options) {
    const priors = new Map();
    for (const region of options.regions) {
        const graph = options.graphs.get(region);
        if (!graph)
            continue;
        const counts = loadAadt(options.root, region);
        const sites = new Map(graph.sites.map((site) => [site.id, site]));
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
            if (fallback !== null)
                priors.set(camera.id, { prior: fallback, source: 'class', aadt: null, distance_m: null, aligned: null, highway });
        }
    }
    return priors;
}
/** The road segment a camera was snapped to. A site's snaps are written in the same order as its cameras, so a camera with several at one site gets its own; the first stands in when the lists have drifted apart, which is what the count pipeline does for every camera at a site. */
function cameraSnap(site, uid) {
    const snaps = site?.snaps;
    if (!site || !snaps || snaps.length === 0)
        return null;
    const index = site.cameras.indexOf(uid);
    return (index >= 0 ? snaps[index] : null) ?? snaps[0] ?? null;
}
/** A floor wins a tie because it is the reason attention cannot drop even if movement eases. Equal floors prefer incident, then queue, then still for a stable explanation. */
export function driver(axes) {
    const movement = axes.scale_amplifier * (TUNING.WEIGHT_ANOMALY * (axes.anomaly ?? 0) + TUNING.WEIGHT_SPECTACLE * (axes.spectacle ?? 0));
    const still = axes.gate?.floor ?? 0;
    if (axes.incident_floor >= movement && axes.incident_floor >= still && axes.incident_floor >= axes.queue_floor)
        return 'incident';
    if (axes.queue_floor >= movement && axes.queue_floor >= still)
        return 'queue';
    if (still >= movement)
        return 'still';
    return 'movement';
}
/** Empty regions remain visible and average only the scored cameras available when fewer than five have returned a score. */
export function summarizeRegions(regions, cameras) {
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
//# sourceMappingURL=attention.js.map