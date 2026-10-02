/** Each city's pulse: the median frame difference across its recently seen cameras, minute by minute, through the day. A median so that one camera pointed at a flag in the wind does not become the city's heartbeat.
 *
 * Numbers only, never a picture. Kept in memory and appended to `out/pulse-<date>.jsonl`, so a restart keeps the day it is in. */

import { existsSync, readFileSync } from 'node:fs';
import type { PulsePoint } from '../../shared/src/index.js';
import { round } from './config.js';
import { JsonLog, localDay } from './jsonlog.js';
import { median } from './poller.js';

export const PULSE = {
  /** A camera's picture has to be this recent to count towards its city's minute. Five minutes, so a city on the slow tier still counts every camera. */
  RECENT_S: 300,
  /** A minute with fewer cameras than this says nothing about a city, and is not recorded. */
  MIN_CAMERAS: 2,
  LOG_MAX_BYTES: 4 * 1024 * 1024,
} as const;

export interface PulseCamera {
  region: string;
  lastTs: number | null;
  diff: number | null;
}

export class Pulse {
  private readonly log: JsonLog;
  private day: string;
  private readonly points = new Map<string, PulsePoint[]>();

  constructor(dir: string, now = Date.now() / 1000) {
    this.log = new JsonLog(dir, 'pulse', PULSE.LOG_MAX_BYTES);
    this.day = localDay(now);
    this.load(now);
  }

  /** Picks the day back up from its file after a restart. */
  private load(now: number): void {
    const path = this.log.path(now);
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { ts: number; region: string; diff: number; n: number };
        if (typeof rec.ts !== 'number' || typeof rec.region !== 'string') continue;
        this.push(rec.region, { ts: rec.ts, diff: rec.diff, n: rec.n });
      } catch {
        // A line cut short by a crash is skipped rather than losing the rest of the day.
      }
    }
  }

  private push(region: string, point: PulsePoint): void {
    const list = this.points.get(region) ?? [];
    list.push(point);
    this.points.set(region, list);
  }

  /** Records one minute for every city with enough recent pictures, and returns what was recorded. */
  record(cameras: Iterable<PulseCamera>, now = Date.now() / 1000): { region: string; point: PulsePoint }[] {
    const today = localDay(now);
    if (today !== this.day) {
      this.day = today;
      this.points.clear();
    }
    const byRegion = new Map<string, number[]>();
    for (const camera of cameras) {
      if (camera.lastTs === null || camera.diff === null || now - camera.lastTs > PULSE.RECENT_S) continue;
      const list = byRegion.get(camera.region) ?? [];
      list.push(camera.diff);
      byRegion.set(camera.region, list);
    }
    const out: { region: string; point: PulsePoint }[] = [];
    for (const [region, diffs] of byRegion) {
      if (diffs.length < PULSE.MIN_CAMERAS) continue;
      const point = { ts: round(now, 0), diff: round(median(diffs), 5), n: diffs.length };
      this.push(region, point);
      out.push({ region, point });
    }
    if (out.length > 0) this.log.write(out.map(({ region, point }) => ({ region, ...point })), now);
    return out;
  }

  /** Today's minutes for every city. */
  today(): Record<string, PulsePoint[]> {
    return Object.fromEntries(this.points);
  }

  async drain(): Promise<void> {
    await this.log.drain();
  }
}
