/** Jev, the arbiter over incidents.
 *
 * The scorer in `attention.ts` decides what to look at from numbers alone, and one of its inputs is a dispatch record it cannot read. `incidentFloor` knows that a code implying a closure is worth more than one that does not, and that the record is nine minutes old; it has no way of knowing that the remarks say the vehicles have been moved to the shoulder, or that the camera the record names is pointed away from the junction while the one a quarter of a mile back is showing the queue.
 *
 * It is asked about two things. Incidents, which is the original case below, and cameras whose picture has stopped changing in an hour that usually moves, which the arithmetic cannot tell apart from an empty road or a frozen feed. Both are sparse. A few dozen incidents are live across a state, and the zero-motion gate fired on none of 2,831 Miami daytime polls in the run this was written against. Each subject is asked about once and then cached, which puts this at a handful of calls an hour rather than hundreds a minute. Nothing here sits on the per-camera per-frame path.
 *
 * It modulates and never replaces. The deterministic floor is computed first and stands on its own; an answer moves it within bounds this file sets, and every bound leans the safe way: an unconfident answer does nothing at all, a confident screen score can scale the floor between half and one and a half times, a chosen named camera gains while the others on the record keep three quarters, and a chosen neighbour adds a view without demoting the named cameras, and the only thing that can collapse a floor is the model saying the incident has cleared, which still leaves a tenth. Low confidence means behave normally, never hide it.
 *
 * Answers are model output about public data. They are data, never instructions, and so is everything in the state: the dispatcher's free-text remarks are the one field here that nobody on this project writes. */
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';
import { distanceKm } from './cad.js';
import { round } from './config.js';
import { JsonLog } from './jsonlog.js';
/** Everything the arbiter's behaviour depends on, in one block. The rubrics themselves are at the bottom, because they are prose rather than numbers. */
export const JEV = {
    /** `jev-latest` is what the SDK and the documentation recommend. The model that actually answered is recorded on every log line, so the day a new one lands is visible in the log rather than a mystery. */
    MODEL: 'jev-latest',
    /** Bumped by hand whenever a rubric below changes, or whenever the state the rubrics are answered from changes. Answers logged under different versions are not comparable, and calibration is the whole reason the log exists.
     *
     * Version 3 gives neighbours pictures and makes a neighbour choice add a floor without demoting named cameras. Version 4 gives the gate a vehicle count from the detector and has the standstill rubric read it. */
    RUBRIC_VERSION: 4,
    /** Per attempt. The API answers a handful of questions in well under a second, so anything near this is a network fault, and the call is abandoned rather than kept waiting while the floor it would have adjusted is already being served deterministically. */
    TIMEOUT_MS: 8000,
    /** Answers below this confidence change nothing. The documentation puts genuine uncertainty at 0.5 and reserves 0.9 for high-stakes action; nothing here is high-stakes, because the deterministic floor is already serving. */
    ACT_CONFIDENCE: 0.5,
    /** How far a confident screen-worthiness score may move the floor. The top of the rubric multiplies the floor by 1.5, the bottom by 0.5, and the middle leaves it where it was. */
    SCORE_SWING: 0.5,
    /** A Noul carries no confidence, so its own probability is the gate, and it is set high. The documentation also warns that a threshold does not transfer between primitives, which is why this is not the same number as the confidence gate. */
    NOUL_THRESHOLD: 0.8,
    /** What is left of the floor when the model is sure the incident has cleared. Not zero: the record is still open, and a camera the dispatcher has not released yet is still worth more than an ordinary one. */
    CLEARED_RESIDUE: 0.1,
    /** How much a confident yes to "the cameras support this" may lift a floor. Small, and one-sided: a no never lowers anything, because a frozen camera and an empty road look the same to the telemetry this question is answered from, and that is exactly the case the floor exists for. */
    SUPPORTED_LIFT: 1.2,
    /** What the camera the model picks gains, and what the others keep. A named choice redistributes because being the second-best view of a crash is still worth something. A neighbour choice adds a view and leaves the named cameras alone. */
    CHOSEN_GAIN: 1.25,
    CHOSEN_OTHERS: 0.75,
    /** At most this many options on the Choice. The limit is 255 and we will never approach it, but a state full of cameras the incident has nothing to do with is a distractor, and the documentation is explicit that accuracy falls as irrelevant state grows. */
    MAX_OPTIONS: 10,
    /** How many corridor neighbours to offer beyond the cameras the incident itself names. */
    MAX_NEIGHBOURS: 4,
    /** What the arbiter puts under a camera when it says the stillness in front of it is stopped traffic. The same level a road-relevant dispatch code gets, because that is what it is, an incident nobody has reported yet. A floor rather than a score, for the same reason an incident is one: the thing that makes it worth watching is exactly the thing that makes the picture stop changing. */
    GRIDLOCK_FLOOR: 0.6,
    /** How long a gate answer keeps its floor before the camera has to earn one again. Short, because a standstill that has drained is an ordinary camera again and nothing in the telemetry would say so. */
    GATE_HOLD_S: 600,
    /** A camera whose gate has fired is not asked about again inside this window, whatever the answer was. Deliberately shorter than GATE_HOLD_S, so that a standstill which is still standing is re-read twice before the floor it earned expires. The reverse ordering, which this constant had at first, let a genuine jam lose its floor for five minutes before anything was allowed to ask about it again. */
    GATE_REASK_AFTER_S: 300,
    /** At most this many cameras are asked about per ranking. The gate fires on a camera at a time, not on a city at once, and this is what stops a region-wide feed fault from becoming a region-wide spend.
     *
     * MAX_IN_FLIGHT usually binds before this does, because a pass is synchronous and no call it starts has come back by the time it ends. This is the cap that still holds once they do. */
    MAX_GATE_PER_PASS: 3,
    /** Calls per rolling minute across every region, and how many may be in the air at once. A city produces a handful an hour in ordinary weather; these exist so that a feed suddenly listing two hundred incidents cannot become two hundred calls. */
    MAX_CALLS_PER_MINUTE: 20,
    MAX_IN_FLIGHT: 2,
    /** The soonest a record may be asked about again. Set to one camera period, because that is the rate at which the evidence can actually change, and asking faster than the pictures arrive would spend calls to be told the same thing.
     *
     * This bound is not the whole of the cadence. A re-ask also requires that at least one of the record's cameras has returned a new frame since the last answer, which makes the arbitration track the polling tier by itself: a record on cameras somebody is watching is re-read about once a minute, and the same record on idle cameras about once every five. */
    REASK_AFTER_S: 60,
    /** How many past answers are kept per subject for the arbitration pane. Forty points at one a minute is a little over half an hour of history, which is longer than an incident floor survives. In memory only, and dropped on restart like every other verdict here. */
    HISTORY_POINTS: 40,
    /** After a failed call, leave that incident alone for this long. The SDK already retries the retryable statuses twice inside one call. */
    RETRY_AFTER_S: 120,
    LOG_MAX_BYTES: 16 * 1024 * 1024,
};
/** Describes an incident to the model and turns what comes back into a multiplier on the deterministic floor.
 *
 * Every path through this class has a no-op: no key, no network, a malformed answer, a rate limit, a timeout, an incident nobody has asked about yet. In all of them `modulate` hands back the number it was given. */
export class JevArbiter {
    ask;
    askGate;
    verdicts = new Map();
    /** Record fingerprints currently in the air, so the same one is never asked twice at once. */
    pending = new Set();
    failedUntil = new Map();
    recentCalls = [];
    log;
    failing = false;
    calls = 0;
    errors = 0;
    inputTokens = 0;
    outputTokens = 0;
    /** Answers over time, per subject, oldest first. Bounded, in memory, and never read by the scorer. */
    history = new Map();
    gateHistory = new Map();
    /** Counted so that a quiet pane can say which kind of quiet it is. */
    throttled = 0;
    heldOnEvidence = 0;
    gateVerdicts = new Map();
    gatePending = new Set();
    gateAskedAt = new Map();
    constructor(ask, logDir, askGate = null) {
        this.ask = ask;
        this.askGate = askGate;
        this.log = new JsonLog(logDir, 'jev', JEV.LOG_MAX_BYTES);
    }
    /** Whether there is anything to ask. False with no key, and then nothing else in this file ever runs. */
    get enabled() {
        return this.ask !== null;
    }
    /** The record's own content, because the feed publishes no update timestamp. A dispatcher editing the remarks or the code changes this and the incident is asked about again; a feed republishing the same record every two minutes does not. */
    static key(incident) {
        return JSON.stringify([incident.id, incident.type, incident.reported_at, incident.location, incident.remarks]);
    }
    verdictFor(incident) {
        const held = this.verdicts.get(incident.id);
        if (!held || held.key !== JevArbiter.key(incident))
            return null;
        return held;
    }
    /** Asks about anything worth asking about, and returns at once. A verdict lands for the next ranking rather than this one, which is the point: nothing waits on a network call to draw a wall. */
    consider(incidents, telemetry, neighbours, now = Date.now() / 1000) {
        if (!this.ask)
            return;
        for (const incident of incidents) {
            const evidence = JevArbiter.evidence(incident, telemetry);
            if (!this.shouldAsk(incident, evidence, now))
                continue;
            void this.askAbout(incident, evidence, telemetry, neighbours, now);
        }
    }
    /** What the record's cameras are showing, reduced to a string that changes when and only when one of them returns a new frame.
     *
     * This is what makes a one-minute re-ask window affordable. The window says how soon an answer may be replaced; this says whether replacing it could produce anything different. A record whose cameras have all gone quiet holds its answer until one of them speaks again. */
    static evidence(incident, telemetry) {
        const parts = [];
        for (const uid of incident.cameras) {
            const camera = telemetry(uid);
            if (!camera)
                continue;
            parts.push(`${String(uid)}:${camera.lastTs === null ? '-' : String(Math.round(camera.lastTs))}`);
        }
        return parts.join(',');
    }
    shouldAsk(incident, evidence, now) {
        // Nothing to modulate: no camera of ours can see it.
        if (incident.cameras.length === 0)
            return false;
        // Ordinary police business never gets a floor at all, so no answer about it could change anything.
        if (!incident.road_relevant && !incident.implies_closure)
            return false;
        const key = JevArbiter.key(incident);
        if (this.pending.has(key))
            return false;
        const failed = this.failedUntil.get(key);
        if (failed !== undefined && now < failed)
            return false;
        const held = this.verdicts.get(incident.id);
        if (held && held.key === key) {
            if (now - held.at < JEV.REASK_AFTER_S)
                return false;
            // The window has passed and nothing has changed to answer differently about. An edited record is exempt, because its key would not have matched.
            if (held.evidence === evidence && evidence !== '') {
                this.heldOnEvidence++;
                return false;
            }
        }
        if (this.pending.size >= JEV.MAX_IN_FLIGHT)
            return false;
        // A rolling minute rather than a bucket, so a burst cannot ride over the boundary.
        while (this.recentCalls.length > 0 && now - this.recentCalls[0] > 60)
            this.recentCalls.shift();
        if (this.recentCalls.length >= JEV.MAX_CALLS_PER_MINUTE) {
            this.throttled++;
            return false;
        }
        return true;
    }
    async askAbout(incident, evidence, telemetry, neighbours, now) {
        const ask = this.ask;
        if (!ask)
            return;
        const key = JevArbiter.key(incident);
        const cameras = incident.cameras.map(telemetry).filter((camera) => camera !== null);
        // Every camera this record names is unpolled, so there is nothing to describe and nothing a verdict could move.
        if (cameras.length === 0)
            return;
        // Not one of them has returned a picture yet, which happens in the first minutes of a run. This guard is load-bearing rather than thrifty: asked about a record whose every camera reads "no picture yet", the model scores the screen rubric on its lower levels, because those levels ask for a camera showing something. Measured against the live feed with the guard bypassed, eight real records all came back between 0.3 and 1.1 of 3 whatever their code said, including two open roadblocks. A floor must not be lowered for a gap in our own coverage. Neither asked nor marked, so it goes out on a later pass once there is something to look at.
        if (!cameras.some((camera) => camera.diff !== null))
            return;
        const extra = corridorOptions(cameras, neighbours);
        const options = choiceOptions(incident, cameras, extra);
        const state = buildState(incident, cameras, extra, now, telemetry);
        this.pending.add(key);
        this.recentCalls.push(now);
        try {
            const { verdict, usage, raw, latencyMs } = await ask(state, options);
            this.calls++;
            this.inputTokens += usage.input_tokens;
            this.outputTokens += usage.output_tokens;
            const landed = { ...verdict, incidentId: incident.id, key, evidence, at: Date.now() / 1000 };
            this.verdicts.set(incident.id, landed);
            this.remember(incident, landed);
            if (this.failing)
                console.log('jev recovered');
            this.failing = false;
            const at = Date.now() / 1000;
            this.log.write([
                {
                    kind: 'call',
                    ts: round(at, 3),
                    rubric_version: JEV.RUBRIC_VERSION,
                    incident: incident.id,
                    code: incident.type,
                    label: incident.label,
                    location: incident.location,
                    reported_at: incident.reported_at,
                    cameras: cameras.map((camera) => camera.uid),
                    options: Object.keys(options),
                    state,
                    latency_ms: latencyMs,
                    model: verdict.model,
                    answers: raw,
                    usage,
                },
            ], at, () => ({ kind: 'rubric', version: JEV.RUBRIC_VERSION, model: JEV.MODEL, questions: RUBRICS }));
        }
        catch (error) {
            this.errors++;
            this.failedUntil.set(key, Date.now() / 1000 + JEV.RETRY_AFTER_S);
            // Never the body and never the headers: the key is in one of them. A name and a status are enough to tell a rate limit from a DNS failure.
            const status = typeof error.status === 'number' ? ` ${String(error.status)}` : '';
            const name = error instanceof Error ? error.name : 'Error';
            if (!this.failing)
                console.warn(`jev unavailable (${name}${status}), incidents keep their deterministic floor`);
            this.failing = true;
        }
        finally {
            this.pending.delete(key);
        }
    }
    /** Asks about cameras the zero-motion gate has fired on, and returns at once.
     *
     * The gate is a question the arithmetic cannot answer. A frame that changed by nothing in an hour that usually moves is stopped traffic, an empty road, or a feed that has frozen, and the three are identical in a mean absolute pixel difference. Only the last two deserve nothing. So the ones the gate flags are described and asked about, at a few per pass, and an answer that clears its threshold puts a floor under the camera the way a dispatch record would. */
    considerGate(candidates, now = Date.now() / 1000) {
        if (!this.askGate)
            return;
        let asked = 0;
        for (const candidate of candidates) {
            if (asked >= JEV.MAX_GATE_PER_PASS)
                return;
            if (!this.shouldAskGate(candidate, now))
                continue;
            asked++;
            void this.askGateAbout(candidate, now);
        }
    }
    shouldAskGate(candidate, now) {
        const uid = candidate.camera.uid;
        // The flag is what is being asked about, so without it there is no question.
        if (!candidate.camera.ambiguousZero)
            return false;
        // A camera with no picture cannot have been still, and a camera with no baseline has no hour to be still against. Both are states the flag should never reach, and both would read to the model as evidence of stopped traffic rather than as the gap in our own coverage they are.
        if (candidate.camera.diff === null || candidate.camera.baseline === null)
            return false;
        if (this.gatePending.has(uid))
            return false;
        const asked = this.gateAskedAt.get(uid);
        if (asked !== undefined && now - asked < JEV.GATE_REASK_AFTER_S)
            return false;
        if (this.gatePending.size + this.pending.size >= JEV.MAX_IN_FLIGHT)
            return false;
        while (this.recentCalls.length > 0 && now - this.recentCalls[0] > 60)
            this.recentCalls.shift();
        return this.recentCalls.length < JEV.MAX_CALLS_PER_MINUTE;
    }
    async askGateAbout(candidate, now) {
        const askGate = this.askGate;
        if (!askGate)
            return;
        const uid = candidate.camera.uid;
        const state = buildGateState(candidate, now);
        this.gatePending.add(uid);
        this.gateAskedAt.set(uid, now);
        this.recentCalls.push(now);
        try {
            const { verdict, usage, raw, latencyMs } = await askGate(state);
            this.calls++;
            this.inputTokens += usage.input_tokens;
            this.outputTokens += usage.output_tokens;
            const at = Date.now() / 1000;
            this.gateVerdicts.set(uid, { ...verdict, uid, at });
            const series = this.gateHistory.get(uid) ?? [];
            series.push({
                at: round(at, 1),
                standstill: round(verdict.standstill, 2),
                frozen: round(verdict.frozen, 2),
                floor: verdict.frozen >= JEV.NOUL_THRESHOLD || verdict.standstill < JEV.NOUL_THRESHOLD ? 0 : JEV.GRIDLOCK_FLOOR,
            });
            while (series.length > JEV.HISTORY_POINTS)
                series.shift();
            this.gateHistory.set(uid, series);
            if (this.failing)
                console.log('jev recovered');
            this.failing = false;
            this.log.write([
                {
                    kind: 'gate',
                    ts: round(at, 3),
                    rubric_version: JEV.RUBRIC_VERSION,
                    camera: uid,
                    roadway: candidate.camera.roadway,
                    location: candidate.camera.location,
                    state,
                    latency_ms: latencyMs,
                    model: verdict.model,
                    answers: raw,
                    usage,
                },
            ], at, () => ({ kind: 'rubric', version: JEV.RUBRIC_VERSION, model: JEV.MODEL, questions: { ...RUBRICS, ...GATE_RUBRICS } }));
        }
        catch (error) {
            this.errors++;
            const status = typeof error.status === 'number' ? ` ${String(error.status)}` : '';
            const name = error instanceof Error ? error.name : 'Error';
            if (!this.failing)
                console.warn(`jev unavailable (${name}${status}), still cameras keep no floor`);
            this.failing = true;
        }
        finally {
            this.gatePending.delete(uid);
        }
    }
    /** The floor a gate answer puts under one camera, or null when there is none to apply.
     *
     * Three ways to get nothing. No answer, an answer older than the hold window, or an answer that did not clear its threshold. A confident frozen feed is one of those: it is recorded, and it takes the standstill answer with it, because a picture that is not arriving is not evidence of anything on the road. */
    gateFloor(uid, now = Date.now() / 1000) {
        const verdict = this.gateVerdicts.get(uid);
        if (!verdict)
            return null;
        if (now - verdict.at > JEV.GATE_HOLD_S)
            return null;
        const gated = [];
        const frozen = verdict.frozen >= JEV.NOUL_THRESHOLD;
        if (!frozen)
            gated.push('frozen');
        const standstill = !frozen && verdict.standstill >= JEV.NOUL_THRESHOLD;
        if (!standstill)
            gated.push('standstill');
        const value = standstill ? JEV.GRIDLOCK_FLOOR : 0;
        return {
            value,
            at: verdict.at,
            influence: {
                standstill: round(verdict.standstill, 2),
                frozen: round(verdict.frozen, 2),
                floor: round(value, 3),
                gated,
                model: verdict.model,
            },
        };
    }
    /** What one verdict does to a floor, as a multiplier and the list of answers that were not acted on. Pure arithmetic over the answer, so the arbitration pane can report exactly what the scorer applied rather than an approximation of it. */
    static effect(verdict, uid, namedChoice = true) {
        const gated = [];
        let multiplier = 1;
        if (verdict.cleared >= JEV.NOUL_THRESHOLD) {
            // The one answer allowed to take a floor away, and the answer to a record that has been open for a hundred and seventy days.
            multiplier *= JEV.CLEARED_RESIDUE;
        }
        else
            gated.push('cleared');
        if (verdict.scoreConfidence >= JEV.ACT_CONFIDENCE && verdict.scoreLevels > 1) {
            const normalised = verdict.score / (verdict.scoreLevels - 1);
            multiplier *= 1 + JEV.SCORE_SWING * (2 * normalised - 1);
        }
        else
            gated.push('screen');
        if (verdict.supported >= JEV.NOUL_THRESHOLD)
            multiplier *= JEV.SUPPORTED_LIFT;
        else
            gated.push('supported');
        if (verdict.chosen !== null && verdict.chosenConfidence >= JEV.ACT_CONFIDENCE) {
            multiplier *= verdict.chosen === uid ? JEV.CHOSEN_GAIN : namedChoice ? JEV.CHOSEN_OTHERS : 1;
        }
        else
            gated.push('camera');
        return { multiplier, gated };
    }
    /** Keeps one answer for the pane, and only for the pane. Nothing in the scorer reads this. */
    remember(incident, verdict) {
        const series = this.history.get(incident.id) ?? [];
        // Reported for the camera the model picked, which is the largest the multiplier gets. The others take CHOSEN_OTHERS in its place.
        const { multiplier, gated } = JevArbiter.effect(verdict, verdict.chosen ?? -1);
        series.push({
            at: round(verdict.at, 1),
            score: round(verdict.score, 2),
            score_confidence: round(verdict.scoreConfidence, 2),
            score_levels: verdict.scoreLevels,
            cleared: round(verdict.cleared, 2),
            supported: round(verdict.supported, 2),
            chosen: verdict.chosen,
            chosen_confidence: round(verdict.chosenConfidence, 2),
            multiplier: round(multiplier, 3),
            gated,
        });
        while (series.length > JEV.HISTORY_POINTS)
            series.shift();
        this.history.set(incident.id, series);
    }
    /** The arbitration as it stands, for the pane. Assembled on request and holding no reference to anything the scorer uses. */
    snapshot(incidents, hasPicture, context, isServable) {
        const live = new Map(incidents.map((incident) => [incident.id, incident]));
        const linked = incidents.filter((incident) => incident.cameras.length > 0);
        const relevant = linked.filter((incident) => incident.road_relevant || incident.implies_closure);
        const servable = relevant.filter((incident) => incident.cameras.some(isServable));
        const ready = servable.filter((incident) => incident.cameras.some(hasPicture));
        const rows = [];
        for (const [id, history] of this.history) {
            const incident = live.get(id);
            if (!incident)
                continue;
            rows.push({
                id,
                code: incident.type,
                label: incident.label,
                location: incident.location,
                cameras: incident.cameras,
                latest: history[history.length - 1] ?? null,
                history,
            });
        }
        rows.sort((a, b) => (b.latest?.at ?? 0) - (a.latest?.at ?? 0));
        const cameras = [];
        for (const [uid, history] of this.gateHistory)
            cameras.push({ uid, latest: history[history.length - 1] ?? null, history });
        return {
            enabled: this.enabled,
            calls: this.calls,
            errors: this.errors,
            throttled: this.throttled,
            held_on_evidence: this.heldOnEvidence,
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            reask_after_s: JEV.REASK_AFTER_S,
            gates: {
                noul_threshold: JEV.NOUL_THRESHOLD,
                act_confidence: JEV.ACT_CONFIDENCE,
                score_swing: JEV.SCORE_SWING,
                cleared_residue: JEV.CLEARED_RESIDUE,
                supported_lift: JEV.SUPPORTED_LIFT,
                chosen_gain: JEV.CHOSEN_GAIN,
                chosen_others: JEV.CHOSEN_OTHERS,
            },
            watching_regions: context.watching,
            feeds_read: context.feedsRead,
            prioritised_cameras: context.prioritised,
            live_incidents: incidents.length,
            linked_incidents: linked.length,
            relevant_incidents: relevant.length,
            servable_incidents: servable.length,
            ready_incidents: ready.length,
            incidents: rows,
            cameras,
        };
    }
    /** A confident neighbour choice adds a view without taking one away from the named scene. All other verdict gates still apply to its multiplier. */
    chosenQueue(incident, uid, recordFloor) {
        const verdict = this.verdictFor(incident);
        if (!verdict || incident.cameras.includes(uid) || verdict.chosen !== uid || verdict.chosenConfidence < JEV.ACT_CONFIDENCE)
            return null;
        return recordFloor * JevArbiter.effect(verdict, uid).multiplier;
    }
    /** The deterministic floor, adjusted by whatever is known about this incident. Hands back exactly what it was given whenever there is no verdict, the verdict belongs to an older version of the record, or every answer in it is below its gate. */
    modulate(incident, uid, deterministic) {
        const verdict = this.verdictFor(incident);
        if (!verdict || deterministic <= 0)
            return { value: deterministic, influence: null };
        const { multiplier, gated } = JevArbiter.effect(verdict, uid, incident.cameras.includes(verdict.chosen ?? -1));
        const value = Math.min(1, Math.max(0, deterministic * multiplier));
        return {
            value: round(value, 3),
            influence: {
                score: round(verdict.score, 2),
                score_confidence: round(verdict.scoreConfidence, 2),
                cleared: round(verdict.cleared, 2),
                supported: round(verdict.supported, 2),
                chosen: verdict.chosen,
                chosen_confidence: round(verdict.chosenConfidence, 2),
                multiplier: round(multiplier, 3),
                gated,
                model: verdict.model,
            },
        };
    }
    /** Resolves once every queued log line is on disk, for a test that needs to read the file back. */
    async drain() {
        await this.log.drain();
    }
    stats() {
        return { enabled: this.enabled, calls: this.calls, errors: this.errors, verdicts: this.verdicts.size, gate_verdicts: this.gateVerdicts.size, input_tokens: this.inputTokens, output_tokens: this.outputTokens };
    }
}
/** The cameras the model may pick between, each with the one line that tells it apart. The state carries the detail; this map only has to make the labels distinguishable. */
export function choiceOptions(incident, cameras, neighbours) {
    const options = {};
    for (const camera of cameras) {
        options[String(camera.uid)] = `Named by the record. ${camera.roadway}, ${camera.location}, ${String(Math.round(distanceKm(camera.lat, camera.lon, incident.lat, incident.lon) * 1000))} m from the reported location.`;
    }
    for (const neighbour of neighbours) {
        const where = neighbour.side === 'upstream' ? 'on the approach to it' : neighbour.side === 'downstream' ? 'past it' : 'nearby but off the corridor';
        options[String(neighbour.uid)] = `Not named by the record, ${where}. ${neighbour.roadway}, ${neighbour.location}, ${String(Math.round(neighbour.length_m))} m along the road.`;
    }
    // Insertion order is the cameras the record names first, so a truncation drops the furthest speculative neighbour rather than the scene itself.
    return Object.fromEntries(Object.entries(options).slice(0, JEV.MAX_OPTIONS));
}
/** The corridor neighbours worth offering, without repeating a camera the incident already names. */
function corridorOptions(cameras, neighbours) {
    const already = new Set(cameras.map((camera) => camera.uid));
    const found = new Map();
    for (const camera of cameras) {
        for (const neighbour of neighbours(camera.uid)) {
            if (already.has(neighbour.uid))
                continue;
            const held = found.get(neighbour.uid);
            if (!held || neighbour.length_m < held.length_m)
                found.set(neighbour.uid, neighbour);
        }
    }
    // Upstream first: a queue forms on the approach, so those are the cameras most likely to be showing something the named camera is not.
    const rank = { upstream: 0, downstream: 1, nearby: 2 };
    return [...found.values()].sort((a, b) => (a.side === b.side ? a.length_m - b.length_m : rank[a.side] - rank[b.side])).slice(0, JEV.MAX_NEIGHBOURS);
}
/** How long ago, in words.
 *
 * Words rather than a timestamp on purpose: the model's own documentation says it reads dates as text rather than as ordered quantities, so the arithmetic is done here and it is handed the answer. */
export function ago(seconds) {
    if (seconds < 90)
        return 'less than two minutes ago';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 36)
        return `${hours} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
}
/** What the picture is doing, against what this camera usually does at this hour. A ratio and a phrase, both worked out here, because the model is documented not to be a calculator. */
export function picture(camera) {
    const { diff, baseline } = camera;
    if (diff === null)
        return { summary: 'no picture yet', frame_difference: null, usual: baseline, times_usual: null };
    if (baseline === null || baseline <= 0)
        return { summary: 'changing, with nothing to compare it against yet', frame_difference: round(diff, 4), usual: null, times_usual: null };
    const ratio = diff / baseline;
    const summary = ratio >= 2
        ? 'changing far more than it usually does at this hour'
        : ratio >= 1.3
            ? 'changing more than usual'
            : ratio >= 0.7
                ? 'changing about as much as usual'
                : ratio >= 0.25
                    ? 'quieter than usual'
                    : 'almost perfectly still, where it is usually moving';
    return { summary, frame_difference: round(diff, 4), usual: round(baseline, 4), times_usual: round(ratio, 2) };
}
/** The whole of what Jev is told: named fields, nothing the questions do not use, and the dispatcher's own words carried verbatim and labelled as theirs. */
export function buildState(incident, cameras, neighbours, now, telemetry = () => null) {
    return {
        dispatch_record: {
            agency_code: incident.type,
            agency_code_meaning: incident.label,
            code_is_about_the_road: incident.road_relevant,
            code_implies_the_road_is_blocked: incident.implies_closure,
            reported_location: incident.location,
            city: incident.city,
            county: incident.county,
            reported: incident.reported_at === null ? 'at a time the feed did not give' : ago(Math.max(0, now - incident.reported_at)),
            dispatcher_remarks: incident.remarks,
        },
        cameras_the_record_names: cameras.map((camera) => {
            const state = picture(camera);
            return {
                camera_id: String(camera.uid),
                road: camera.roadway,
                view: camera.location,
                distance_from_the_reported_location: `${String(Math.round(distanceKm(camera.lat, camera.lon, incident.lat, incident.lon) * 1000))} m`,
                picture: state.summary,
                frame_difference: state.frame_difference,
                usual_frame_difference_this_hour: state.usual,
                times_its_usual: state.times_usual,
                frames_behind_this_hour: camera.baselineN,
                still_although_this_hour_usually_moves: camera.ambiguousZero,
                newest_frame: camera.lastTs === null ? 'none yet' : ago(Math.max(0, now - camera.lastTs)),
            };
        }),
        nearby_cameras_on_the_same_corridor: neighbours.map((neighbour) => {
            const camera = telemetry(neighbour.uid);
            const state = picture(camera ?? { diff: null, baseline: null });
            return {
                picture: state.summary,
                frame_difference: state.frame_difference,
                usual_frame_difference_this_hour: state.usual,
                times_its_usual: state.times_usual,
                newest_frame: camera?.lastTs == null ? 'none yet' : ago(Math.max(0, now - camera.lastTs)),
                camera_id: String(neighbour.uid),
                road: neighbour.roadway,
                view: neighbour.location,
                side: neighbour.side === 'upstream' ? 'on the approach to the reported location' : neighbour.side === 'downstream' ? 'past the reported location' : 'nearby, off the corridor',
                road_distance: `${String(Math.round(neighbour.length_m))} m`,
                driving_time: `${String(Math.round(neighbour.tt_s))} seconds`,
                junctions_away: neighbour.hops,
                // Only upstream carries this, because only upstream is where a queue grows.
                a_queue_at_the_incident_would_reach_here_in: neighbour.wave_s === null ? null : ago(neighbour.wave_s).replace(' ago', ''),
            };
        }),
    };
}
/** What the arbiter is told about one still camera. Deliberately narrow: this question is about one picture and the road it sits on, and the documentation is explicit that accuracy falls as irrelevant state grows.
 *
 * The corridor is included because it is the evidence that separates the two answers. Traffic standing still at this camera while the cameras behind it on the same road are also slowing is a queue. The same stillness with the approach moving normally is an empty road or a dead picture. */
export function buildGateState(candidate, now) {
    const { camera, neighbours, incidentNearby, vehicles } = candidate;
    const state = picture(camera);
    return {
        camera: {
            camera_id: String(camera.uid),
            road: camera.roadway,
            view: camera.location,
            picture: state.summary,
            frame_difference: state.frame_difference,
            usual_frame_difference_this_hour: state.usual,
            times_its_usual: state.times_usual,
            frames_behind_this_hour: camera.baselineN,
            newest_frame: camera.lastTs === null ? 'none yet' : ago(Math.max(0, now - camera.lastTs)),
            time_of_day: new Date(now * 1000).toLocaleString('en-US', { weekday: 'long', hour: 'numeric' }),
            a_dispatch_record_already_names_this_camera: incidentNearby,
            // Worded rather than left null when there is no count, so that a missing detector reads as missing evidence and never as an empty road.
            vehicles_a_detector_counted_in_this_picture: vehicles === null ? 'not counted' : vehicles.vehicles,
            vehicle_types_counted: vehicles === null ? null : vehicles.by_class,
        },
        cameras_on_the_same_corridor: neighbours.map((neighbour) => ({
            camera_id: String(neighbour.uid),
            road: neighbour.roadway,
            view: neighbour.location,
            side: neighbour.side === 'upstream' ? 'on the approach to this camera' : neighbour.side === 'downstream' ? 'past this camera' : 'nearby, off the corridor',
            road_distance: `${String(Math.round(neighbour.length_m))} m`,
            junctions_away: neighbour.hops,
        })),
    };
}
/** The two questions asked about a still picture. Both Nouls, because each one is a single yes or no about a state of the world, and neither of them is a judgement about the wall.
 *
 * They are not exclusive and are not asked to be. A frozen feed answered yes takes precedence in code, in `gateFloor`, rather than in the rubric, because a model asked to rank its own two answers is being asked to do the recombination this project already does with weights it can see. */
export const GATE_RUBRICS = {
    standstill: {
        type: 'noul',
        instructions: 'Is the stillness in this camera most likely traffic that has stopped moving, rather than a road with nothing on it?',
        criteria: {
            true: 'This hour normally carries traffic here, the picture has gone still rather than emptied, with vehicles counted in it where a count is given, and the cameras on the approach are also quieter than usual, which is what a queue standing back from a blockage looks like.',
            false: 'The road is most likely simply empty, which an hour that usually moves can still be and which a count of no vehicles shows directly, or the approach is running normally, which a queue at this camera would not allow.',
        },
    },
    frozen: {
        type: 'noul',
        instructions: 'Is this camera most likely sending the same picture over and over because the feed has stopped updating, rather than showing a road that is genuinely still?',
        criteria: {
            true: 'The frame difference is at or near zero rather than merely low, which a real scene with light, weather and shadows in it almost never produces, and nothing on the corridor agrees with it.',
            false: 'The picture still changes a little, or the cameras around it agree that something unusual is happening on this road.',
        },
    },
};
/** The rubrics, written once and logged at the top of each day's file so that an answer can be read against the question that produced it.
 *
 * Each one asks a single thing. The documentation is explicit that a question needing several steps of reasoning should be split and recombined in code, and the recombination is `modulate` above, where this project's own weights already live. */
export const RUBRICS = {
    supported: {
        type: 'noul',
        instructions: 'Do the camera pictures described in the state show something consistent with this dispatch record describing a real event at the reported location?',
        criteria: {
            true: 'At least one camera the record names shows a picture that fits the report, such as traffic moving far less than it usually does at this hour, or a picture changing far more than usual.',
            false: 'Every camera looks the way it usually does at this hour, with nothing in any of them that fits the report.',
        },
    },
    cleared: {
        type: 'noul',
        instructions: 'Has whatever this dispatch record describes most likely already been cleared, so that the road is back to normal?',
        criteria: {
            true: 'The report is old enough that something of this kind would normally be over, or the remarks say it has been cleared, moved to the shoulder or released, and the cameras look ordinary for the hour.',
            false: 'The report is recent, or the remarks describe something still going on, or a camera still shows traffic behaving unusually.',
        },
    },
    screen: {
        type: 'score',
        instructions: 'How much of a wall of traffic cameras should this dispatch record be allowed to take over right now?',
        criteria: [
            'Nothing worth showing: ordinary police business, or something already over, on cameras that look exactly as they usually do.',
            'Worth a small tile: something is being attended to on or beside the road, but the traffic is moving and no camera shows it.',
            'Worth a large tile: the road itself is affected, and at least one camera shows traffic behaving unusually.',
            'Worth the main panel: a lane or the whole road is blocked, or traffic has stopped where it would normally be moving, and a camera shows it.',
        ],
    },
    camera: {
        type: 'choice',
        instructions: 'Which one of these cameras would show an operator the most about what this dispatch record describes?',
    },
};
/** The binding for the zero-motion gate. Two Nouls, one call, and the same client contract as the incident ask above.
 *
 * Shares the key with `createAsk` and nothing else. A deployment that wants incident arbitration without per-camera calls simply does not build this one, and the gate goes back to being recorded and never acted on. */
export function createGateAsk(apiKey, overrides = {}) {
    const client = new TypeSafeClient({ apiKey, timeout: JEV.TIMEOUT_MS, defaultModel: JEV.MODEL, ...overrides });
    return async (state) => {
        const started = Date.now();
        const result = await client.systemOne({
            state: state,
            questions: {
                standstill: noul(GATE_RUBRICS.standstill.instructions, GATE_RUBRICS.standstill.criteria),
                frozen: noul(GATE_RUBRICS.frozen.instructions, GATE_RUBRICS.frozen.criteria),
            },
        });
        const latencyMs = Date.now() - started;
        const { standstill, frozen } = result.answers;
        if (typeof standstill?.noul !== 'number' || typeof frozen?.noul !== 'number')
            throw new Error('answer missing a question');
        return {
            verdict: { standstill: standstill.noul, frozen: frozen.noul, model: result.model },
            usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
            raw: result.answers,
            latencyMs,
        };
    };
}
/** The binding to the SDK. The only place in this project that holds the key, and it is handed one rather than reading the environment itself.
 *
 * All four questions go in one call. They are evaluated independently and in parallel, so asking four costs barely more than asking one, and one of them is speculative: the Choice is answered whether or not the Score turns out to be high enough to act on. */
export function createAsk(apiKey, overrides = {}) {
    // `overrides` exists so a test can hand in its own `fetch` and so an operator can point at another base URL. Nothing in the running server passes it.
    const client = new TypeSafeClient({ apiKey, timeout: JEV.TIMEOUT_MS, defaultModel: JEV.MODEL, ...overrides });
    return async (state, options) => {
        const started = Date.now();
        const result = await client.systemOne({
            state: state,
            questions: {
                supported: noul(RUBRICS.supported.instructions, RUBRICS.supported.criteria),
                cleared: noul(RUBRICS.cleared.instructions, RUBRICS.cleared.criteria),
                screen: score(RUBRICS.screen.instructions, RUBRICS.screen.criteria),
                camera: choice(RUBRICS.camera.instructions, options),
            },
        });
        const latencyMs = Date.now() - started;
        const { supported, cleared, screen, camera } = result.answers;
        // A response that does not carry what the questions asked for is a failure, not a verdict of zero. Thrown here, it is caught one level up and the deterministic floor stands.
        if (typeof supported?.noul !== 'number' || typeof cleared?.noul !== 'number' || typeof screen?.score !== 'number' || typeof camera?.choice !== 'string') {
            throw new Error('answer missing a question');
        }
        const chosen = Number(camera.choice);
        return {
            verdict: {
                supported: supported.noul,
                cleared: cleared.noul,
                score: screen.score,
                // Taken from the legend the answer itself carries rather than from the rubric constant, so that a rubric edited in one place and not the other cannot silently rescale the multiplier.
                scoreLevels: Object.keys(screen.legend).length,
                scoreConfidence: typeof screen.confidence === 'number' ? screen.confidence : 0,
                chosen: Number.isInteger(chosen) && camera.choice in options ? chosen : null,
                chosenConfidence: typeof camera.confidence === 'number' ? camera.confidence : 0,
                model: result.model,
            },
            usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
            raw: result.answers,
            latencyMs,
        };
    };
}
//# sourceMappingURL=jev.js.map