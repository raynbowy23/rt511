/** Background snapshot poller.
 *
 * Each 511 site regenerates a snapshot on demand once its cached copy has expired, and stamps Last-Modified with the time of the request that regenerated it. A poll that lands even slightly early makes the edge re-cache the stale image for another period, so the next poll is scheduled at the newest Last-Modified plus the source's poll period plus a safety margin, never on a fixed clock. The regenerated image is frequently byte-identical to the previous one because the picture behind it changes more slowly than the cache expires, so a frame is appended only when the bytes change. Cameras start at staggered offsets to spread the load. */
import sharp from 'sharp';
import { RADAR } from './radar.js';
import { round } from './config.js';
const THUMB_W = 64;
const THUMB_H = 48;
export const MARGIN_S = 4;
const RETRY_S = 20;
const MIN_DELAY_S = 10;
const UNAVAILABLE_S = 300;
export const ACTIVITY_MIN_SAMPLES = 3;
/** A frame difference below this is sensor noise on a still scene, and dividing by it would make an empty rural camera look busy. */
export const ACTIVITY_FLOOR = 0.004;
export const DEFAULT_RING = 10;
/** Frames kept per camera for the replay scrub. Each one is the snapshot as the site sent it, tens to a couple of hundred kilobytes, so this number multiplies by however many cameras are polled: ten frames across 669 cameras is roughly half a gigabyte at the top end. Ten gives about ten minutes of replay, since a picture changes about once a minute. Raise it with --ring if you have the memory and want longer history. */
export const DIFF_HISTORY = 24;
/** A camera in a watched city that nobody can see still needs the occasional frame, because the map colours its nodes by activity and a stale activity score is a lie. Five minutes keeps that honest at a twelfth of the cost. */
export const SLOW_PERIOD_S = 300;
/** Visibility is a claim with a shelf life. The wall restates it every ten seconds; if it stops, either the viewer left the wall or the tab is asleep, and everything falls back to the slow tier on its own. */
export const VISIBLE_TTL_S = 30;
/** How far a quiet camera's period may stretch, as a multiple of its source's own period. Four minutes on a sixty second source is the point where the picture is old enough to be worth refreshing whatever the scene is doing. */
const MAX_STRETCH = 4;
/** One step per quiet poll, so a camera eases out to its longest period over several minutes rather than jumping there after one still frame. */
const STRETCH_STEP = 0.5;
/** A frame difference above this is real movement rather than sensor noise, and it snaps the period straight back. Twice the noise floor, so a camera that is merely grainy does not keep itself awake. */
export const ACTIVE_DIFF = ACTIVITY_FLOOR * 2;
/** `unchanged` means the server handed us a fresh timestamp but identical bytes, so the next regeneration time is known. `not_modified` means a 304, which tells us nothing about when the next one is due. The two need different schedules. */
/** Greyscale 64x48 thumbnail, its mean brightness, its contrast, and the mean absolute difference against the previous one.
 *
 * Contrast is the standard deviation of the thumbnail's luma. Rain on the lens, fog and low cloud all flatten a picture, so a whole city's cameras losing contrast together is the sky page's hint that the weather has turned. It is measured here because the thumbnail already exists and costs nothing more to read.
 *
 * Resizing and then taking the luma is the same operation as PIL's convert-then-resize: both are linear, so they commute. The luma weights are ITU-R 601-2, which is what PIL's "L" conversion uses. */
export async function analyze(data, prevThumb) {
    const { data: raw } = await sharp(data)
        // Bilinear, matching PIL's BILINEAR in the Python this replaces. sharp's runtime accepts 'linear' (it is in sharp.kernel) but its bundled typings omit it, hence the cast.
        .resize(THUMB_W, THUMB_H, { fit: 'fill', kernel: 'linear' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });
    const pixels = THUMB_W * THUMB_H;
    const thumb = new Float32Array(pixels);
    let sum = 0;
    for (let i = 0; i < pixels; i++) {
        const r = raw[i * 3];
        const g = raw[i * 3 + 1];
        const b = raw[i * 3 + 2];
        const value = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        thumb[i] = value;
        sum += value;
    }
    const brightness = sum / pixels;
    let spread = 0;
    for (let i = 0; i < pixels; i++)
        spread += (thumb[i] - brightness) ** 2;
    const contrast = Math.sqrt(spread / pixels);
    let diff = null;
    if (prevThumb) {
        let total = 0;
        for (let i = 0; i < pixels; i++)
            total += Math.abs(thumb[i] - prevThumb[i]);
        diff = total / pixels;
    }
    return { thumb, brightness, contrast, diff };
}
export function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    // Even-length lists average the two middle values, as Python's statistics.median does.
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export class CameraSlot {
    uid;
    camera;
    frames = [];
    diffs = [];
    /** Contrast of the newest frame, and of recent ones, for the sky page. Kept on the slot rather than the frame because nothing reads it for a frame in the replay ring. */
    contrast = null;
    contrasts = [];
    polls = 0;
    unchanged = 0;
    unavailable = 0;
    errors = 0;
    last_error = null;
    last_modified_seen = null;
    /** The newest frame's greyscale thumbnail, kept only to difference the next frame against. */
    lastThumb = null;
    /** Wall-clock of every frame appended, for the freshness report. */
    freshAt = [];
    /** Multiplier on this camera's base period, raised while nothing is happening in front of it and dropped the moment something is. */
    stretch = 1;
    /** The timer this camera is waiting on, and when it is due, so that a camera scrolling into view can be pulled forward instead of sitting out a five minute sleep. */
    timer = null;
    dueAt = 0;
    polling = false;
    lastPollAt = null;
    constructor(uid, camera) {
        this.uid = uid;
        this.camera = camera;
    }
    get latest() {
        return this.frames.length > 0 ? this.frames[this.frames.length - 1] : null;
    }
    /** How busy this camera looks right now on a 0 to 1 scale, relative to its own recent behaviour rather than to other cameras.
     *
     * A quiet rural camera and a downtown intersection have frame differences an order of magnitude apart, so an absolute threshold would leave the wall permanently showing the same few busy cameras. Scoring each camera against its own median puts them on equal footing: sitting at the median reads as 0.5, twice the median saturates.
     *
     * A camera needs several frames before its own median means anything, and a Florida camera only yields a frame every minute or two, so it would take the best part of ten minutes for the wall to start breathing. Until then the region's median stands in, which is a decent prior because cameras in one region share a refresh rate and a scene type. */
    activity(fallbackBaseline) {
        const frame = this.latest;
        if (!frame || frame.diff === null)
            return null;
        let baseline;
        if (this.diffs.length >= ACTIVITY_MIN_SAMPLES)
            baseline = median(this.diffs);
        else if (fallbackBaseline !== null)
            baseline = fallbackBaseline;
        else
            return null;
        return round(Math.min(1, (0.5 * frame.diff) / Math.max(baseline, ACTIVITY_FLOOR)), 3);
    }
    summary(fallbackBaseline, periodS, scored) {
        const frame = this.latest;
        return {
            id: this.uid,
            region: this.camera.region,
            period_s: periodS,
            frames: this.frames.length,
            polls: this.polls,
            unchanged: this.unchanged,
            unavailable: this.unavailable,
            errors: this.errors,
            last_error: this.last_error,
            last_ts: frame ? frame.ts : null,
            last_modified: frame ? frame.last_modified : null,
            brightness: frame ? round(frame.brightness, 3) : null,
            diff: frame && frame.diff !== null ? round(frame.diff, 4) : null,
            activity: this.activity(fallbackBaseline),
            attention: scored ? scored.attention : null,
            axes: scored ? scored.axes : null,
        };
    }
}
export class Poller {
    clients;
    ring;
    cameras = new Map();
    started_at = Date.now() / 1000;
    timers = new Set();
    stopped = false;
    onStop = null;
    radar = new Set();
    isRadar(uid) {
        const slot = this.cameras.get(uid);
        return !!slot && !this.watching.has(slot.camera.region) && this.radar.has(uid);
    }
    /** New anchors are spread across a full radar period, including rotation, so a national tick never creates a burst of snapshot requests. */
    setRadar(ids) {
        const before = this.radar;
        this.radar = new Set(ids);
        const added = ids.filter((id) => !before.has(id));
        added.forEach((id, i) => {
            const slot = this.cameras.get(id);
            if (!slot || this.watching.has(slot.camera.region) || slot.polling || this.prioritised(id))
                return;
            const spacing = RADAR.RADAR_PERIOD_S * (i + 1) / added.length;
            const remaining = slot.lastPollAt === null ? 0 : slot.lastPollAt + RADAR.RADAR_PERIOD_S - Date.now() / 1000;
            this.schedule(slot, Math.max(spacing, remaining));
        });
    }
    constructor(clients, cameras, ring = DEFAULT_RING) {
        this.clients = clients;
        this.ring = ring;
        for (const [uid, camera] of cameras)
            this.cameras.set(uid, new CameraSlot(uid, camera));
    }
    get interval_s() {
        const periods = new Set();
        for (const slot of this.cameras.values()) {
            const client = this.clients.get(slot.camera.source);
            if (client)
                periods.add(client.source.poll_period_s);
        }
        return periods.size > 0 ? Math.min(...periods) : 60;
    }
    /** Called after every poll that says something about the scene in front of the camera, which is a fresh frame or byte-identical bytes; a 304 or an unavailable camera says nothing and is not reported. Set by whoever wants to accumulate history; the poller itself does nothing with it and its own scheduling does not depend on it. */
    onPoll = null;
    /** Regions with viewer demand. Outside this set only radar anchors and explicit priority claims may poll. */
    watching = new Set();
    /** What the viewer can actually see, per region, with the time it was last stated. */
    visible = new Map();
    /** Independent claims keep the pane and graph from cancelling each other's attention, and expiry releases cameras when a caller stops restating its claim. */
    priority = new Map();
    /** Newly promoted cameras are pulled forward so an existing slow sleep does not delay the first useful picture. */
    setPriority(source, ids, ttlS = VISIBLE_TTL_S) {
        const now = Date.now() / 1000;
        const before = new Set(ids.filter((uid) => this.prioritised(uid)));
        const after = new Set(ids);
        this.priority.set(source, { ids: after, expires: now + ttlS });
        for (const id of after) {
            if (before.has(id))
                continue;
            const slot = this.cameras.get(id);
            if (!slot || slot.polling)
                continue;
            const target = now + this.dueIn(slot, this.periodFor(slot, 'fast'));
            if (!slot.timer || slot.dueAt > target + 1) {
                this.schedule(slot, Math.max(0, target - now));
            }
        }
    }
    prioritised(uid) {
        const now = Date.now() / 1000;
        return [...this.priority.values()].some((claim) => now < claim.expires && claim.ids.has(uid));
    }
    /** The wall names the cameras on screen on every state poll. An absent list leaves the previous one alone, because the country view and any other client have no notion of visible tiles; an empty list is a positive statement that nothing is on screen, which is what the city map view sends. */
    setVisible(region, ids) {
        if (ids === null)
            return;
        const before = this.visible.get(region)?.ids ?? new Set();
        const now = Date.now() / 1000;
        const after = new Set(ids);
        this.visible.set(region, { ids: after, at: now });
        // A camera that has just come into view may be asleep for another few minutes. Pull it forward rather than making the viewer wait for a tile that is already on their screen.
        for (const id of after) {
            if (before.has(id))
                continue;
            const slot = this.cameras.get(id);
            if (!slot || slot.camera.region !== region || !this.watching.has(region))
                continue;
            const target = now + this.dueIn(slot, this.periodFor(slot, 'fast'));
            if (slot.timer && slot.dueAt > target + 1) {
                clearTimeout(slot.timer);
                this.timers.delete(slot.timer);
                this.schedule(slot, Math.max(0, target - now));
            }
        }
    }
    /** Which tier a camera is in right now. */
    tierOf(slot) {
        if (this.prioritised(slot.uid))
            return 'fast';
        if (!this.watching.has(slot.camera.region))
            return this.radar.has(slot.uid) ? 'radar' : 'idle';
        const seen = this.visible.get(slot.camera.region);
        if (!seen || Date.now() / 1000 - seen.at > VISIBLE_TTL_S)
            return 'slow';
        return seen.ids.has(slot.uid) ? 'fast' : 'slow';
    }
    tierCounts() {
        const counts = { fast: 0, slow: 0, radar: 0, idle: 0 };
        for (const slot of this.cameras.values())
            counts[this.tierOf(slot)]++;
        return counts;
    }
    /** The period this camera is actually being polled at: its source's own period when it is on screen, the slow period when it is not, and stretched further while nothing is happening in front of it. The wall judges staleness against this number, so it has to be the real one rather than the source default. */
    periodFor(slot, tier = this.tierOf(slot)) {
        const base = this.clients.get(slot.camera.source)?.source.poll_period_s ?? 60;
        // A prioritised camera is exempt from the stretch as well as from the slow period. The stretch exists to stop a quiet road being polled for nothing, and a camera with a crash reported on it that is showing no movement is the one case where the stillness is the thing worth seeing.
        if (this.prioritised(slot.uid))
            return base;
        if (tier === 'radar')
            return RADAR.RADAR_PERIOD_S;
        const floor = tier === 'fast' ? base : SLOW_PERIOD_S;
        return Math.max(floor, base * slot.stretch);
    }
    /** True once this region's cameras are being polled. */
    isWatching(region) {
        return this.watching.has(region);
    }
    watchedRegions() {
        return [...this.watching].sort();
    }
    /** Begin polling one region's cameras. Cheap to call repeatedly; it does nothing if the region is already running. */
    watch(region) {
        if (this.stopped || this.watching.has(region))
            return;
        this.watching.add(region);
        this.startSlots([...this.cameras.values()].filter((slot) => slot.camera.region === region));
    }
    /** Release viewer demand while retaining scored history for the national board and the next radar frame. */
    unwatch(region) {
        if (!this.watching.delete(region))
            return;
        // Keep the newest picture and the difference history, which is a few dozen numbers, so a radar anchor in this city carries on differencing without a gap and the board can still show its latest frame. Drop the rest of the replay ring. Each frame is tens to a couple of hundred kilobytes, and keeping every ring after its city closed would let a session that browses the country hold the replay of every camera it ever showed, on the order of a gigabyte.
        for (const slot of this.cameras.values()) {
            if (slot.camera.region !== region || slot.frames.length <= 1)
                continue;
            slot.frames.splice(0, slot.frames.length - 1);
        }
        this.visible.delete(region);
        console.log(`stopped polling ${region}`);
    }
    start() {
        this.startSlots([...this.cameras.values()]);
    }
    startSlots(slots0) {
        const bySource = new Map();
        for (const slot of slots0) {
            this.watching.add(slot.camera.region);
            const list = bySource.get(slot.camera.source);
            if (list)
                list.push(slot);
            else
                bySource.set(slot.camera.source, [slot]);
        }
        for (const [key, slots] of bySource) {
            const client = this.clients.get(key);
            if (!client)
                continue;
            const period = client.source.poll_period_s;
            slots.sort((a, b) => a.uid - b.uid);
            slots.forEach((slot, i) => {
                // Staggered starts: one camera's poll every period/n rather than the whole region at once.
                this.schedule(slot, (period * i) / slots.length);
            });
            // The rate is no longer simply the camera count over the period: only the cameras on screen run at that period, and the rest tick over slowly, so what this run actually costs is printed every minute instead.
            console.log(`watching ${slots.length} cameras from ${key}: ${period.toFixed(0)}s on screen, ${SLOW_PERIOD_S}s otherwise`);
        }
    }
    schedule(slot, delayS) {
        if (this.stopped || slot.polling)
            return;
        if (slot.timer) {
            clearTimeout(slot.timer);
            this.timers.delete(slot.timer);
        }
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            slot.timer = null;
            void this.tick(slot);
        }, delayS * 1000);
        this.timers.add(timer);
        slot.timer = timer;
        slot.dueAt = Date.now() / 1000 + delayS;
    }
    async tick(slot) {
        if (this.stopped || this.tierOf(slot) === 'idle')
            return;
        if (!this.watching.has(slot.camera.region) && slot.lastPollAt !== null) {
            const remaining = slot.lastPollAt + this.periodFor(slot) - Date.now() / 1000;
            if (remaining > 0) {
                this.schedule(slot, remaining);
                return;
            }
        }
        slot.polling = true;
        slot.lastPollAt = Date.now() / 1000;
        // The period is read now rather than when this poll was scheduled, so a tile that scrolled into view, or a scene that woke up, takes effect on the next hop rather than the one after.
        const period = this.periodFor(slot);
        let delay = period;
        try {
            const result = await this.pollOnce(slot);
            this.adapt(slot, result);
            if (this.onPoll && (result === 'fresh' || result === 'unchanged'))
                this.onPoll(slot, result);
            delay = this.nextDelay(slot, result, this.periodFor(slot));
        }
        catch (error) {
            // Whatever the network does, the loop stays alive.
            slot.errors++;
            const name = error instanceof Error ? error.name : 'Error';
            const message = error instanceof Error ? error.message : String(error);
            slot.last_error = `${name}: ${message}`.slice(0, 200);
            console.warn(`camera ${slot.uid}: ${slot.last_error}`);
        }
        slot.polling = false;
        if (!this.watching.has(slot.camera.region))
            delay = Math.max(delay, this.periodFor(slot));
        if (this.tierOf(slot) !== 'idle')
            this.schedule(slot, delay);
    }
    /** How long this camera would wait if it were polled at `period` right now, by the same rule the scheduler uses. Used to decide whether a camera coming into view is worth pulling forward. */
    dueIn(slot, period) {
        return this.nextDelay(slot, 'unchanged', period);
    }
    /** Stretches a quiet camera's period and snaps it back the instant something moves.
     *
     * The signal is the frame difference the poller already computes; there is no second measurement. Up is gradual and down is immediate on purpose: a rural road easing out to four minutes overnight costs nothing, but a camera that wakes up must be back on its normal period for the very next poll, or a stretch would quietly become a way to miss an incident. */
    adapt(slot, result) {
        if (result === 'unavailable' || result === 'not_modified')
            return;
        const diff = result === 'fresh' ? slot.latest?.diff ?? null : 0;
        if (diff !== null && diff > ACTIVE_DIFF) {
            slot.stretch = 1;
            return;
        }
        // Identical bytes, or a fresh frame that differs only by sensor noise: nothing is happening in front of this camera.
        if (diff !== null && diff <= ACTIVITY_FLOOR)
            slot.stretch = Math.min(MAX_STRETCH, slot.stretch + STRETCH_STEP);
    }
    /** Seconds until this camera's next poll. Whenever the server handed us a Last-Modified, fresh bytes or not, the next regeneration is that time plus the poll period, so wait until then plus a margin. A 304 carries no new timestamp, so retry sparsely. A placeholder means the camera has no feed right now, so back off. */
    nextDelay(slot, result, period) {
        if (result === 'unavailable')
            return UNAVAILABLE_S;
        // A 304 carries no new Last-Modified, so the one we hold is already stale and deriving a target from it would compute a time in the past and clamp to the floor, polling this camera six times a minute forever. Wait a fixed retry instead.
        if (result === 'not_modified')
            return RETRY_S;
        if (slot.last_modified_seen) {
            const stamp = Date.parse(slot.last_modified_seen);
            if (Number.isFinite(stamp)) {
                const target = stamp / 1000 + period + MARGIN_S - Date.now() / 1000;
                return Math.min(period + MARGIN_S, Math.max(MIN_DELAY_S, target));
            }
        }
        return period + MARGIN_S;
    }
    async pollOnce(slot) {
        slot.polls++;
        const prev = slot.latest;
        const client = this.clients.get(slot.camera.source);
        if (!client)
            throw new Error(`no client for source ${slot.camera.source}`);
        const snap = await client.snapshot(slot.camera.image_path, prev ? prev.last_modified : null);
        if (snap === 'not_modified') {
            slot.unchanged++;
            return 'not_modified';
        }
        if (snap === 'unavailable') {
            slot.unavailable++;
            return 'unavailable';
        }
        slot.last_modified_seen = snap.last_modified;
        // Freshness is bytes, not timestamps: the regenerated image is frequently identical.
        if (prev && prev.data.equals(snap.data)) {
            slot.unchanged++;
            return 'unchanged';
        }
        const { thumb, brightness, contrast, diff } = await analyze(snap.data, slot.lastThumb);
        // Only the newest thumbnail is ever read, to diff the next frame against. Keeping one per retained frame cost 12 KB times the ring times every camera, for nothing.
        slot.lastThumb = thumb;
        slot.frames.push({
            ts: snap.fetched_at,
            last_modified: snap.last_modified,
            data: snap.data,
            content_type: snap.content_type,
            brightness,
            diff,
        });
        if (slot.frames.length > this.ring)
            slot.frames.shift();
        slot.freshAt.push(snap.fetched_at);
        slot.contrast = contrast;
        slot.contrasts.push(contrast);
        if (slot.contrasts.length > DIFF_HISTORY)
            slot.contrasts.shift();
        if (diff !== null) {
            slot.diffs.push(diff);
            if (slot.diffs.length > DIFF_HISTORY)
                slot.diffs.shift();
        }
        return 'fresh';
    }
    /** Per-camera state, with each region's median frame difference supplied as the baseline for cameras that do not yet have enough history of their own.
     *
     * `score` decorates each camera with its attention score. It is passed the same regional fallback the activity number uses, so the two cannot be measured against different baselines. Without it every camera reports a null score and nothing else changes. */
    summaries(score) {
        const byRegion = new Map();
        for (const slot of this.cameras.values()) {
            const list = byRegion.get(slot.camera.region);
            if (list)
                list.push(...slot.diffs);
            else
                byRegion.set(slot.camera.region, [...slot.diffs]);
        }
        const baselines = new Map();
        for (const [region, diffs] of byRegion)
            if (diffs.length > 0)
                baselines.set(region, median(diffs));
        return [...this.cameras.values()].map((slot) => {
            const fallback = baselines.get(slot.camera.region) ?? null;
            return slot.summary(fallback, this.periodFor(slot), score ? score(slot, fallback) : null);
        });
    }
    stop() {
        this.stopped = true;
        this.onStop?.();
        for (const timer of this.timers)
            clearTimeout(timer);
        this.timers.clear();
    }
}
//# sourceMappingURL=poller.js.map