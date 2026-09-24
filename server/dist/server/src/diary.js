/** A written record of what the wall noticed each day, for reading back later.
 *
 * It stands in for a highlight reel. A reel would mean keeping the pictures, and the imagery belongs to the state transportation departments that publish it, for individual use and not for re-use. So the diary keeps words and numbers only: when, which camera, what the highlight said at the time, and the city's sky turning. Opening an entry opens the camera as it is now.
 *
 * One file per local day under `out/`, append-only, and it survives restarts the way the wall's own memory does not. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { round } from './config.js';
import { JsonLog } from './jsonlog.js';
export const DIARY = {
    /** How often the diary looks at the wall. It reads state the server already holds and makes no request of anyone. */
    EVERY_S: 60,
    /** The same camera with the same kind of event is written again only after this long, so a jam that lasts an hour is one entry rather than sixty. */
    REPEAT_S: 1800,
    LOG_MAX_BYTES: 4 * 1024 * 1024,
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FILE = /^diary-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export class Diary {
    dir;
    log;
    said = new Map();
    /** What each city's sky was at the last look. A city seen for the first time sets this without writing anything, or every restart would record a sunset. */
    skies = new Map();
    constructor(dir) {
        this.dir = dir;
        this.log = new JsonLog(dir, 'diary', DIARY.LOG_MAX_BYTES);
    }
    /** Writes whatever is new since the last look, and returns it. */
    note(highlights, sky, now) {
        const entries = [];
        for (const item of highlights) {
            const key = `${item.kind}:${String(item.camera)}`;
            const last = this.said.get(key);
            if (last !== undefined && now - last < DIARY.REPEAT_S)
                continue;
            this.said.set(key, now);
            entries.push({ ts: round(now, 1), kind: item.kind, region: item.region, camera: item.camera, brief: item.brief, attention: round(item.attention, 3) });
        }
        for (const region of sky) {
            // A city with no recent picture has nothing to say about its sky, and its old state is kept rather than guessed at.
            if (region.cameras === 0)
                continue;
            const up = region.sun_elevation > 0;
            const murky = region.weather === 'murky';
            const snow = region.weather === 'snow';
            const before = this.skies.get(region.key);
            this.skies.set(region.key, { up, murky, snow });
            if (!before)
                continue;
            const light = region.brightness === null ? '' : ` Its cameras read ${String(Math.round(region.brightness * 100))}% brightness.`;
            if (before.up && !up)
                entries.push(this.sky(now, 'sunset', region, `Sunset over ${region.name}.${light}`));
            if (!before.up && up)
                entries.push(this.sky(now, 'sunrise', region, `Sunrise over ${region.name}.${light}`));
            if (!before.murky && murky)
                entries.push(this.sky(now, 'murky', region, `${String(region.contrast_low)} of ${String(region.contrast_known)} cameras over ${region.name} went flat together, which may be rain, fog or low cloud.`));
            if (before.murky && !murky && !snow)
                entries.push(this.sky(now, 'clear', region, `The cameras over ${region.name} are sharp again.`));
            if (!before.snow && snow) {
                const first = !this.snowedThisSeason(region.key, now);
                entries.push(this.sky(now, 'snow', region, `${first ? 'First snow of the season' : 'Snow'} around ${region.name}: ${String(region.snow_white)} of ${String(region.snow_known)} cameras turned white together.`));
            }
        }
        if (entries.length > 0)
            this.log.write(entries, now);
        return entries;
    }
    sky(now, kind, region, brief) {
        return { ts: round(now, 1), kind, region: region.key, camera: null, brief, attention: null };
    }
    /** Whether the diary already records snow for a region since the start of this snow season, taken as the first of July, so the first snowfall of a winter can say so. */
    snowedThisSeason(region, now) {
        const when = new Date(now * 1000);
        const seasonStart = `${String(when.getMonth() >= 6 ? when.getFullYear() : when.getFullYear() - 1)}-07-01`;
        return this.days()
            .filter((day) => day >= seasonStart)
            .some((day) => this.read(day).some((entry) => entry.kind === 'snow' && entry.region === region));
    }
    /** Every day with a diary, newest first. */
    days() {
        if (!existsSync(this.dir))
            return [];
        return readdirSync(this.dir)
            .flatMap((name) => {
            const match = FILE.exec(name);
            return match ? [match[1]] : [];
        })
            .sort()
            .reverse();
    }
    /** One day's entries, oldest first. An unknown or malformed day is an empty day. A line that does not parse, which a crash mid-write could leave, is skipped rather than losing the rest. */
    read(day) {
        if (!DAY.test(day))
            return [];
        const path = join(this.dir, `diary-${day}.jsonl`);
        if (!existsSync(path))
            return [];
        return readFileSync(path, 'utf8')
            .split('\n')
            .flatMap((line) => {
            if (!line.trim())
                return [];
            try {
                const entry = JSON.parse(line);
                return typeof entry.ts === 'number' && typeof entry.brief === 'string' ? [entry] : [];
            }
            catch {
                return [];
            }
        });
    }
    /** Resolves once every queued line is on disk, for a test that reads the file back. */
    async drain() {
        await this.log.drain();
    }
}
//# sourceMappingURL=diary.js.map