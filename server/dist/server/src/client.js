/** One HTTP client per camera source: conditional snapshot fetches with a polite concurrency budget.
 *
 * One per source rather than one per process, because the budget is per agency. Every request carries the project's identifying User-Agent and nothing else: no borrowed Referer or Origin, because every source publishes its images for exactly this kind of use. Video is never fetched here; the browser loads each agency's open stream itself. */
const TIMEOUT_MS = 20_000;
/** How long a network whose bulk document failed is left alone. */
const BULK_RETRY_S = 60;
/** A counting semaphore. The politeness budget is the point: a source is never asked for more than this many things at once. */
class Limit {
    max;
    active = 0;
    waiting = [];
    constructor(max) {
        this.max = max;
    }
    async run(task) {
        if (this.active >= this.max)
            await new Promise((resolve) => this.waiting.push(resolve));
        this.active++;
        try {
            return await task();
        }
        finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }
}
/** Paces request starts so that a source is never sent more than its published rate. The concurrency budget bounds how many are in the air; this bounds how many begin each second, which is what an agency's rate limit counts. */
class Pace {
    gapMs;
    next = 0;
    constructor(gapMs) {
        this.gapMs = gapMs;
    }
    async wait() {
        if (this.gapMs <= 0)
            return;
        const now = Date.now();
        const at = Math.max(now, this.next);
        this.next = at + this.gapMs;
        if (at > now)
            await new Promise((resolve) => setTimeout(resolve, at - now));
    }
}
const SNAPSHOT_RE = /<cctvSnapshot\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/cctvSnapshot>/g;
const SNIPPET_RE = /<snippet>([^<]*)<\/snippet>/;
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** Every picture in one state's C2C snapshot document, by device id. The document is a flat list of `cctvSnapshot` elements with the JPEG in base64, which a pair of patterns reads without an XML library; a camera with no picture carries an empty snippet and is left out. */
export function parseCompassSnapshots(xml) {
    const out = new Map();
    for (const match of xml.matchAll(SNAPSHOT_RE)) {
        const snippet = SNIPPET_RE.exec(match[2] ?? '')?.[1]?.trim();
        if (!snippet)
            continue;
        const id = (match[1] ?? '').replace(/&(\w+);/g, (whole, name) => XML_ENTITIES[name] ?? whole);
        out.set(id, Buffer.from(snippet, 'base64'));
    }
    return out;
}
export class Client {
    source;
    headers;
    userAgent;
    limit;
    pace;
    /** Bulk snapshot documents by network, and the fetch in flight for each, so that every camera in a state polling at once costs one document between them. */
    bulk = new Map();
    bulkInFlight = new Map();
    /** After a failed bulk fetch, when that network may be asked again. Without it every camera in the state would retry a multi-megabyte document on its own next poll. */
    bulkRetryAt = new Map();
    /** Counted for the politeness report: every outbound request to this source. */
    requests = 0;
    /** Bytes received from this site, which is the half of the bill that a request count does not show. */
    bytes = 0;
    constructor(source, userAgent, concurrency = 4) {
        this.source = source;
        this.userAgent = userAgent;
        this.headers = { 'User-Agent': userAgent };
        this.limit = new Limit(concurrency);
        this.pace = new Pace(source.max_requests_per_s ? 1000 / source.max_requests_per_s : 0);
    }
    async fetch(url, init) {
        await this.pace.wait();
        this.requests++;
        return fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
    /** A new snapshot, or `not_modified` (a 304, which carries no fresh Last-Modified) or `unavailable` (an error status, or the placeholder graphic the site serves for a camera with no feed). Whether a 200's bytes actually changed is the caller's decision, because these sites re-stamp Last-Modified on every regeneration. */
    async snapshot(imagePath, ifModifiedSince) {
        if (imagePath.startsWith('compass:'))
            return this.bulkSnapshot(imagePath);
        const headers = { ...this.headers };
        if (ifModifiedSince)
            headers['If-Modified-Since'] = ifModifiedSince;
        // A published feed hands out absolute image URLs. The platform hands out paths on its own site.
        const url = /^https?:\/\//.test(imagePath) ? imagePath : `${this.source.base_url}${imagePath}`;
        const res = await this.limit.run(() => this.fetch(url, { headers }));
        if (res.status === 304) {
            await res.arrayBuffer().catch(() => undefined);
            return 'not_modified';
        }
        const ctype = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
        // A dead camera answers 200 with a placeholder graphic, and the content type is what distinguishes it. Sniffing magic bytes would not: Florida's placeholder is a valid PNG and Wisconsin's real cameras are PNG.
        if (res.status !== 200 || ctype !== this.source.snapshot_content_type) {
            await res.arrayBuffer().catch(() => undefined);
            return 'unavailable';
        }
        const data = Buffer.from(await res.arrayBuffer());
        this.bytes += data.byteLength;
        // The site re-stamps Last-Modified on every regeneration even when the picture did not change, so the caller compares bytes as well.
        return { fetched_at: Date.now() / 1000, last_modified: res.headers.get('last-modified'), data, content_type: ctype };
    }
    /** One camera's picture out of its state's bulk document, fetching the document only when the copy held is older than the source's poll period. Every camera in the state reads the same copy, and a camera polled between fetches gets the picture it already has, which the poller recognises as unchanged by its bytes. */
    async bulkSnapshot(imagePath) {
        const [network, device] = imagePath.slice('compass:'.length).split('/');
        const doc = await this.bulkDocument(network);
        const data = doc?.images.get(decodeURIComponent(device ?? ''));
        if (!doc || !data)
            return 'unavailable';
        return { fetched_at: Date.now() / 1000, last_modified: doc.lastModified, data, content_type: this.source.snapshot_content_type };
    }
    async bulkDocument(network) {
        const held = this.bulk.get(network);
        if (held && Date.now() / 1000 - held.fetchedAt < this.source.poll_period_s)
            return held;
        const pending = this.bulkInFlight.get(network);
        if (pending)
            return pending;
        if (Date.now() / 1000 < (this.bulkRetryAt.get(network) ?? 0))
            return held ?? null;
        const url = String(this.source.feed.url ?? '');
        const request = this.limit
            .run(() => this.fetch(`${url}?networks=${encodeURIComponent(network)}&dataTypes=cctvSnapshotData`, { headers: this.headers }))
            .then(async (res) => {
            if (!res.ok) {
                await res.arrayBuffer().catch(() => undefined);
                this.bulkRetryAt.set(network, Date.now() / 1000 + BULK_RETRY_S);
                return held ?? null;
            }
            const text = await res.text();
            this.bytes += Buffer.byteLength(text);
            const doc = { fetchedAt: Date.now() / 1000, lastModified: new Date().toUTCString(), images: parseCompassSnapshots(text) };
            this.bulk.set(network, doc);
            return doc;
        })
            // A failed fetch keeps the pictures already held rather than blanking a whole state. They age out through the poller's own staleness.
            .catch(() => {
            this.bulkRetryAt.set(network, Date.now() / 1000 + BULK_RETRY_S);
            return held ?? null;
        })
            .finally(() => this.bulkInFlight.delete(network));
        this.bulkInFlight.set(network, request);
        return request;
    }
    get agent() {
        return this.userAgent;
    }
}
//# sourceMappingURL=client.js.map