/** One HTTP client per camera source, because the politeness budget is per agency: conditional snapshot fetches with a bounded concurrency.
 *
 * Every request carries the project's identifying User-Agent and no borrowed Referer or Origin. Video is never fetched here; the browser loads each agency's open stream itself. */

import type { Source } from './config.js';

const TIMEOUT_MS = 20_000;
/** How long a network whose bulk document failed is left alone. */
const BULK_RETRY_S = 60;

export interface Snapshot {
  fetched_at: number;
  last_modified: string | null;
  data: Buffer;
  content_type: string;
}

export type SnapshotResult = Snapshot | 'not_modified' | 'unavailable';

/** A counting semaphore. The politeness budget is the point: a source is never asked for more than this many things at once. */
class Limit {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Paces request starts so that a source is never sent more than its published rate, which counts requests begun per second rather than requests in the air. */
class Pace {
  private next = 0;

  constructor(private readonly gapMs: number) {}

  async wait(): Promise<void> {
    if (this.gapMs <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }
}

/** One state's bulk snapshot document, split into pictures by device id. */
interface Bulk {
  fetchedAt: number;
  lastModified: string;
  images: Map<string, Buffer>;
}

const SNAPSHOT_RE = /<cctvSnapshot\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/cctvSnapshot>/g;
const SNIPPET_RE = /<snippet>([^<]*)<\/snippet>/;
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Every picture in one state's C2C snapshot document, by device id. The document is a flat list of `cctvSnapshot` elements with the JPEG in base64; a camera with no picture carries an empty snippet and is left out. */
export function parseCompassSnapshots(xml: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const match of xml.matchAll(SNAPSHOT_RE)) {
    const snippet = SNIPPET_RE.exec(match[2] ?? '')?.[1]?.trim();
    if (!snippet) continue;
    const id = (match[1] ?? '').replace(/&(\w+);/g, (whole, name: string) => XML_ENTITIES[name] ?? whole);
    out.set(id, Buffer.from(snippet, 'base64'));
  }
  return out;
}

export class Client {
  readonly source: Source;
  private readonly headers: Record<string, string>;
  private readonly userAgent: string;
  private readonly limit: Limit;
  private readonly pace: Pace;
  /** Bulk snapshot documents by network, and the fetch in flight for each, so that every camera in a state polling at once costs one document between them. */
  private readonly bulk = new Map<string, Bulk>();
  private readonly bulkInFlight = new Map<string, Promise<Bulk | null>>();
  /** After a failed bulk fetch, when that network may be asked again, so every camera in the state does not retry a multi-megabyte document on its own. */
  private readonly bulkRetryAt = new Map<string, number>();
  /** Counted for the politeness report. */
  requests = 0;
  bytes = 0;

  constructor(source: Source, userAgent: string, concurrency = 4) {
    this.source = source;
    this.userAgent = userAgent;
    this.headers = { 'User-Agent': userAgent };
    this.limit = new Limit(concurrency);
    this.pace = new Pace(source.max_requests_per_s ? 1000 / source.max_requests_per_s : 0);
  }

  private async fetch(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
    await this.pace.wait();
    this.requests++;
    return fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  /** A new snapshot, or `not_modified` (a 304, which carries no fresh Last-Modified) or `unavailable` (an error status, or the placeholder graphic the site serves for a camera with no feed). Whether a 200's bytes actually changed is the caller's decision, because these sites re-stamp Last-Modified on every regeneration. */
  async snapshot(imagePath: string, ifModifiedSince: string | null): Promise<SnapshotResult> {
    if (imagePath.startsWith('compass:')) return this.bulkSnapshot(imagePath);
    const headers = { ...this.headers };
    if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;
    // Some sources hand out absolute image URLs, others paths on their own site.
    const url = /^https?:\/\//.test(imagePath) ? imagePath : `${this.source.base_url}${imagePath}`;
    const res = await this.limit.run(() => this.fetch(url, { headers }));
    if (res.status === 304) {
      await res.arrayBuffer().catch(() => undefined);
      return 'not_modified';
    }
    const ctype = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    // A dead camera can answer 200 with a placeholder graphic, and the content type is what distinguishes it, since a placeholder can be a valid image in the same format as real pictures.
    if (res.status !== 200 || ctype !== this.source.snapshot_content_type) {
      await res.arrayBuffer().catch(() => undefined);
      return 'unavailable';
    }
    const data = Buffer.from(await res.arrayBuffer());
    this.bytes += data.byteLength;
    return { fetched_at: Date.now() / 1000, last_modified: res.headers.get('last-modified'), data, content_type: ctype };
  }

  /** One camera's picture out of its state's bulk document, fetching the document only when the copy held is older than the source's poll period. A camera polled between fetches gets the picture it already has, which the poller recognizes as unchanged by its bytes. */
  private async bulkSnapshot(imagePath: string): Promise<SnapshotResult> {
    const [network, device] = imagePath.slice('compass:'.length).split('/') as [string, string];
    const doc = await this.bulkDocument(network);
    const data = doc?.images.get(decodeURIComponent(device ?? ''));
    if (!doc || !data) return 'unavailable';
    return { fetched_at: Date.now() / 1000, last_modified: doc.lastModified, data, content_type: this.source.snapshot_content_type };
  }

  private async bulkDocument(network: string): Promise<Bulk | null> {
    const held = this.bulk.get(network);
    if (held && Date.now() / 1000 - held.fetchedAt < this.source.poll_period_s) return held;
    const pending = this.bulkInFlight.get(network);
    if (pending) return pending;
    if (Date.now() / 1000 < (this.bulkRetryAt.get(network) ?? 0)) return held ?? null;
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
        const doc: Bulk = { fetchedAt: Date.now() / 1000, lastModified: new Date().toUTCString(), images: parseCompassSnapshots(text) };
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

  get agent(): string {
    return this.userAgent;
  }
}
