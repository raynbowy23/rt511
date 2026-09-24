/** Append-only JSON lines, rotated by local day and capped.
 *
 * Two things write records here, the ranking and the arbiter, and both want the same treatment: one object per line, a file per day, a hard ceiling on the day's size, and never a write on the request path. A log that blocked an endpoint or filled the disk would be a worse bug than anything it could help find, so every failure here is swallowed after one warning. */
import { appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
/** The local date. The hours these files record are local ones, so a day's file should cover the same day its contents belong to; `toISOString` would rotate in the middle of the evening. */
export function localDay(now) {
    const when = new Date(now * 1000);
    return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
}
export class JsonLog {
    dir;
    prefix;
    maxBytes;
    writes = Promise.resolve();
    full = null;
    /** Files this process has already written a header to. */
    opened = new Set();
    constructor(dir, prefix, maxBytes) {
        this.dir = dir;
        this.prefix = prefix;
        this.maxBytes = maxBytes;
    }
    /** Where a given moment's records go. Exported through the instance so a test can find the file it just caused. */
    path(now) {
        return join(this.dir, `${this.prefix}-${localDay(now)}.jsonl`);
    }
    /** Appends records, and `header` once at the top of each new day's file. Returns immediately; the write happens after. */
    write(records, now, header) {
        if (records.length === 0)
            return;
        const path = this.path(now);
        if (this.full === path)
            return;
        const lines = records.map((record) => JSON.stringify(record));
        this.writes = this.writes
            .then(async () => {
            const size = await stat(path).then((info) => info.size, () => 0);
            if (size >= this.maxBytes) {
                this.full = path;
                console.warn(`${this.prefix} log ${path} reached ${this.maxBytes} bytes, not writing to it again today`);
                return;
            }
            // A header describes what the day's records mean, so it belongs at the top of the file rather than repeated on every line.
            const opening = header && size === 0 && !this.opened.has(path) ? `${JSON.stringify(header())}\n` : '';
            if (opening)
                this.opened.add(path);
            await appendFile(path, `${opening}${lines.join('\n')}\n`);
        })
            .catch((error) => {
            console.warn(`${this.prefix} log: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    /** Resolves once everything queued has been written, for a test that needs to read the file back. */
    async drain() {
        await this.writes;
    }
}
//# sourceMappingURL=jsonlog.js.map