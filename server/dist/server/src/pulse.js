/** Each city's pulse: how much its cameras moved, minute by minute, through the day.
 *
 * The number is the median frame difference across the city's cameras that returned a picture in the last few minutes, which is plain movement, measured the same way all day, so rush hours show as bumps and the small hours as a flat line. It is a median rather than a mean so that one camera pointed at a flag in the wind does not become the city's heartbeat. A city nobody has open is read from its sparse radar cameras, so its line is thinner but still there.
 *
 * Numbers only, never a picture. Kept in memory for the page and appended to `out/pulse-<date>.jsonl`, so a restart keeps the day it is in. */
import { existsSync, readFileSync } from 'node:fs';
import { round } from './config.js';
import { JsonLog, localDay } from './jsonlog.js';
import { median } from './poller.js';
export const PULSE = {
    /** A camera's picture has to be this recent to count towards its city's minute. Five minutes, so a city on the slow tier still counts every camera. */
    RECENT_S: 300,
    /** A minute with fewer cameras than this says nothing about a city, and is not recorded. */
    MIN_CAMERAS: 2,
    LOG_MAX_BYTES: 4 * 1024 * 1024,
};
export class Pulse {
    log;
    day;
    points = new Map();
    constructor(dir, now = Date.now() / 1000) {
        this.log = new JsonLog(dir, 'pulse', PULSE.LOG_MAX_BYTES);
        this.day = localDay(now);
        this.load(now);
    }
    /** Picks the day back up from its file after a restart. */
    load(now) {
        const path = this.log.path(now);
        if (!existsSync(path))
            return;
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                const rec = JSON.parse(line);
                if (typeof rec.ts !== 'number' || typeof rec.region !== 'string')
                    continue;
                this.push(rec.region, { ts: rec.ts, diff: rec.diff, n: rec.n });
            }
            catch {
                // A line cut short by a crash is skipped rather than losing the rest of the day.
            }
        }
    }
    push(region, point) {
        const list = this.points.get(region) ?? [];
        list.push(point);
        this.points.set(region, list);
    }
    /** Records one minute for every city with enough recent pictures, and returns what was recorded. */
    record(cameras, now = Date.now() / 1000) {
        const today = localDay(now);
        // A new day starts a new line.
        if (today !== this.day) {
            this.day = today;
            this.points.clear();
        }
        const byRegion = new Map();
        for (const camera of cameras) {
            if (camera.lastTs === null || camera.diff === null || now - camera.lastTs > PULSE.RECENT_S)
                continue;
            const list = byRegion.get(camera.region) ?? [];
            list.push(camera.diff);
            byRegion.set(camera.region, list);
        }
        const out = [];
        for (const [region, diffs] of byRegion) {
            if (diffs.length < PULSE.MIN_CAMERAS)
                continue;
            const point = { ts: round(now, 0), diff: round(median(diffs), 5), n: diffs.length };
            this.push(region, point);
            out.push({ region, point });
        }
        if (out.length > 0)
            this.log.write(out.map(({ region, point }) => ({ region, ...point })), now);
        return out;
    }
    /** Today's minutes for every city. */
    today() {
        return Object.fromEntries(this.points);
    }
    async drain() {
        await this.log.drain();
    }
}
//# sourceMappingURL=pulse.js.map