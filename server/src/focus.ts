/** The camera open in the panel, fetched as often as its agency refreshes the picture.
 *
 * Where a source names a `focus_period_s`, as ODOT does with five seconds, the camera open in the panel is fetched at that period for as long as a viewer keeps saying it is open, rather than at the wall's slower poll.
 *
 * These pictures are kept apart from the poller's ring on purpose, because fast frames would shorten the replay and shrink the camera's movement baseline to five-second differences. Only the newest picture is held, in memory, and it is dropped when the claim lapses. */

import type { Client, Snapshot } from './client.js';
import type { CatalogCamera } from './config.js';

export const FOCUS = {
  /** A claim lapses unless the viewer restates it. The panel restates it on every fetch, so this only has to outlast one fetch period and a slow network. */
  TTL_S: 30,
  /** Open panels held at once across every viewer of this server. A claim beyond this pushes out the oldest, so several tabs cannot multiply the requests one agency receives. */
  MAX: 4,
} as const;

export interface FocusFrame {
  ts: number;
  data: Buffer;
  content_type: string;
}

interface Claim {
  camera: CatalogCamera;
  client: Client;
  period: number;
  expires: number;
  frame: FocusFrame | null;
  lastModified: string | null;
  timer: NodeJS.Timeout | null;
  polling: boolean;
}

export class Focus {
  private readonly claims = new Map<number, Claim>();

  constructor(private readonly clientFor: (camera: CatalogCamera) => Client | undefined) {}

  /** Keeps a camera, by its global id, on its source's focus period for another TTL, and returns that period. Null when the source names none, in which case nothing is fetched here and the ordinary poll is all there is. */
  claim(uid: number, camera: CatalogCamera, now = Date.now() / 1000): number | null {
    const client = this.clientFor(camera);
    const period = client?.source.focus_period_s ?? null;
    if (!client || period === null) return null;
    const held = this.claims.get(uid);
    if (held) {
      held.expires = now + FOCUS.TTL_S;
      return period;
    }
    while (this.claims.size >= FOCUS.MAX) {
      const oldest = [...this.claims.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
      if (!oldest) break;
      this.release(oldest[0]);
    }
    const claim: Claim = { camera, client, period, expires: now + FOCUS.TTL_S, frame: null, lastModified: null, timer: null, polling: false };
    this.claims.set(uid, claim);
    void this.tick(uid);
    return period;
  }

  /** The newest focus picture for a camera, if one is held. */
  frame(uid: number): FocusFrame | null {
    return this.claims.get(uid)?.frame ?? null;
  }

  private async tick(uid: number): Promise<void> {
    const claim = this.claims.get(uid);
    if (!claim || claim.polling) return;
    if (Date.now() / 1000 > claim.expires) {
      this.release(uid);
      return;
    }
    claim.polling = true;
    try {
      // Conditional, so a picture that has not changed since the last fetch costs the agency a 304 rather than the image.
      const snap = await claim.client.snapshot(claim.camera.image_path, claim.lastModified);
      if (snap !== 'not_modified' && snap !== 'unavailable') this.adopt(claim, snap);
    } catch {
      // A failed fetch leaves the last picture up, and the ordinary poll carries on regardless.
    }
    claim.polling = false;
    if (this.claims.get(uid) !== claim) return;
    claim.timer = setTimeout(() => void this.tick(uid), claim.period * 1000);
  }

  private adopt(claim: Claim, snap: Snapshot): void {
    claim.lastModified = snap.last_modified;
    // The same bytes again are not a new picture, and keeping the old timestamp lets the panel skip reloading it.
    if (claim.frame && claim.frame.data.equals(snap.data)) return;
    claim.frame = { ts: snap.fetched_at, data: snap.data, content_type: snap.content_type };
  }

  private release(uid: number): void {
    const claim = this.claims.get(uid);
    if (!claim) return;
    if (claim.timer) clearTimeout(claim.timer);
    this.claims.delete(uid);
  }

  /** Cameras held right now, for the politeness report. */
  get size(): number {
    return this.claims.size;
  }

  stop(): void {
    for (const uid of [...this.claims.keys()]) this.release(uid);
  }
}
