/** Background snapshot poller.
 *
 * A source may regenerate a snapshot on demand once its cached copy has expired and stamp Last-Modified with the time of that request, so a poll that lands slightly early re-caches the stale image for another period. The next poll is therefore scheduled at the newest Last-Modified plus the poll period plus a margin, never on a fixed clock. The regenerated image is often byte-identical, so a frame is appended only when the bytes change. */

import sharp from 'sharp';
import { RADAR } from './radar.js';
import { SCORE, type AttentionAxes, type CameraState as WireCameraState } from '../../shared/src/index.js';
import type { Client } from './client.js';
import { round, type CatalogCamera } from './config.js';

const THUMB_W = 64;
const THUMB_H = 48;
export const MARGIN_S = 4;
const MIN_DELAY_S = 10;
const UNAVAILABLE_S = 300;
export const ACTIVITY_MIN_SAMPLES = 3;
/** Frame differences a camera needs of its own before its movement score may reach the top of the range, because a baseline of a handful of differences is noisy. */
const ACTIVITY_WARMUP_SAMPLES = 10;

/** The highest movement score a camera with this much history may have, rising from 0.5 to 1 at ACTIVITY_WARMUP_SAMPLES. A cap rather than a pull towards the middle, so a still picture still reads 0 from the start. */
export function warmupCap(samples: number): number {
  return 0.5 + 0.5 * Math.min(1, samples / ACTIVITY_WARMUP_SAMPLES);
}
/** A frame difference below this is sensor noise on a still scene, and dividing by it would make an empty rural camera look busy. */
export const ACTIVITY_FLOOR = 0.004;
/** Frames kept per camera for the replay scrub. Each is tens to a couple of hundred kilobytes, so this multiplies by every polled camera. Raise it with --ring for longer history. */
export const DEFAULT_RING = 10;
export const DIFF_HISTORY = 24;

/** A camera in a watched city that nobody can see still needs the occasional frame, because the map colors its nodes by activity. */
export const SLOW_PERIOD_S = 600;

/** What one server asks of one agency, whatever the size of the wall: at most one on-screen picture every ON_SCREEN_S, and one off-screen picture every OFF_SCREEN_S, so the load stays about what one person watching the agency's own site puts on it. The budget sets each camera's period and is also enforced when each request is sent, because periods alone bound only the average and cameras can come due together. The camera open in the panel is outside the budget and keeps its source's own rate. */
export const BUDGET = {
  ON_SCREEN_S: 5,
  OFF_SCREEN_S: 10,
  /** How long a count of cameras per tier is reused, since counting is a pass over every camera. */
  RECOUNT_MS: 5000,
} as const;
/** Visibility is a claim with a shelf life. If the wall stops restating it, everything falls back to the slow tier on its own. */
export const VISIBLE_TTL_S = 30;
/** How far a quiet camera's period may stretch, as a multiple of its source's own period. */
const MAX_STRETCH = 4;
/** One step per quiet poll, so a camera eases out to its longest period over several minutes rather than jumping there after one still frame. */
const STRETCH_STEP = 0.5;
/** A frame difference above this is real movement rather than sensor noise, and it snaps the period straight back. Twice the noise floor, so a camera that is merely grainy does not keep itself awake. */
export const ACTIVE_DIFF = ACTIVITY_FLOOR * 2;

/** What a camera costs right now. `fast` is on screen, `slow` is in a watched city but nobody can see it, `radar` is a sparse national anchor, and `idle` has neither viewer demand nor a radar or priority claim. */
export type Tier = 'fast' | 'slow' | 'radar' | 'idle';

export interface Frame {
  ts: number;
  last_modified: string | null;
  data: Buffer;
  content_type: string;
  brightness: number;
  diff: number | null;
}

/** `unchanged` means a fresh timestamp but identical bytes, so the next regeneration time is known. `not_modified` means a 304, which says nothing about when the next one is due. */
export type PollResult = 'fresh' | 'unchanged' | 'not_modified' | 'unavailable';

/** A pixel counts as white when every channel is bright and the three are close together: snow, not a sunlit red truck or a yellow sky. */
const WHITE_MIN = 0.72 * 255;
const WHITE_SPREAD = 0.12 * 255;

/** Seconds until a camera's next poll, never sooner than its source's refresh period allows on average.
 *
 * A fresh Last-Modified says when the agency last made a picture, so the poll is timed to land just after the next one: one request per new picture.
 *
 * A Last-Modified already more than a period old says the camera is not updating on that schedule right now, and timing to it would poll at the ten-second floor about a picture that has not moved. So it waits a full period, as it does after a 304. A camera with no feed backs off for five minutes. */
export function nextPollDelay(result: PollResult, lastModified: string | null, period: number, now: number): number {
  if (result === 'unavailable') return UNAVAILABLE_S;
  const full = period + MARGIN_S;
  if (result === 'not_modified' || !lastModified) return full;
  const stamp = Date.parse(lastModified);
  if (!Number.isFinite(stamp)) return full;
  const target = stamp / 1000 + full - now;
  // Only a picture made within the last period is a schedule worth timing to.
  if (target < 0) return full;
  return Math.min(full, Math.max(MIN_DELAY_S, target));
}

/** Grayscale 64x48 thumbnail, its mean brightness, its contrast (the standard deviation of luma, for the sky page), its white share, and the mean absolute difference against the previous one. Luma weights are ITU-R 601-2, as PIL's "L" conversion uses. */
export async function analyze(data: Buffer, prevThumb: Float32Array | null): Promise<{ thumb: Float32Array; brightness: number; contrast: number; white: number; diff: number | null }> {
  const { data: raw } = await sharp(data)
    // Bilinear, matching PIL's BILINEAR.
    .resize(THUMB_W, THUMB_H, { fit: 'fill', kernel: 'linear' })
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = THUMB_W * THUMB_H;
  const thumb = new Float32Array(pixels);
  let sum = 0;
  let whites = 0;
  for (let i = 0; i < pixels; i++) {
    const r = raw[i * 3] as number;
    const g = raw[i * 3 + 1] as number;
    const b = raw[i * 3 + 2] as number;
    if (Math.min(r, g, b) >= WHITE_MIN && Math.max(r, g, b) - Math.min(r, g, b) <= WHITE_SPREAD) whites++;
    const value = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    thumb[i] = value;
    sum += value;
  }
  const brightness = sum / pixels;
  let spread = 0;
  for (let i = 0; i < pixels; i++) spread += ((thumb[i] as number) - brightness) ** 2;
  const contrast = Math.sqrt(spread / pixels);

  let diff: number | null = null;
  if (prevThumb) {
    let total = 0;
    for (let i = 0; i < pixels; i++) total += Math.abs((thumb[i] as number) - (prevThumb[i] as number));
    diff = total / pixels;
  }
  // The share of the picture that is white, which snow cover raises and nothing else in a daylight road scene does for long.
  const white = whites / pixels;
  return { thumb, brightness, contrast, white, diff };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  // Even-length lists average the two middle values, as Python's statistics.median does.
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export class CameraSlot {
  readonly frames: Frame[] = [];
  readonly diffs: number[] = [];
  /** Contrast of the newest frame, and of recent ones, for the sky page. */
  contrast: number | null = null;
  readonly contrasts: number[] = [];
  /** The white share of the newest frame and of recent ones, for the snow hint. */
  white: number | null = null;
  readonly whites: number[] = [];
  polls = 0;
  unchanged = 0;
  unavailable = 0;
  errors = 0;
  last_error: string | null = null;
  last_modified_seen: string | null = null;
  /** The newest frame's grayscale thumbnail, kept only to difference the next frame against. */
  lastThumb: Float32Array | null = null;
  /** Wall-clock of every frame appended, for the freshness report. */
  readonly freshAt: number[] = [];
  /** Multiplier on this camera's base period, raised while nothing is happening in front of it and dropped the moment something is. */
  stretch = 1;
  /** The timer this camera is waiting on, and when it is due, so that a camera scrolling into view can be pulled forward. */
  timer: NodeJS.Timeout | null = null;
  dueAt = 0;
  /** True while this camera waits for a turn it has already been given, so it does not ask for a second one when it wakes. */
  reserved = false;
  polling = false;
  lastPollAt: number | null = null;

  constructor(
    readonly uid: number,
    readonly camera: CatalogCamera,
  ) {}

  get latest(): Frame | null {
    return this.frames.length > 0 ? (this.frames[this.frames.length - 1] as Frame) : null;
  }

  /** How busy this camera looks right now on a 0 to 1 scale, relative to its own recent behavior rather than to other cameras.
   *
   * Frame differences vary by an order of magnitude between cameras, so each is scored against its own median: sitting at the median reads as 0.5, twice the median saturates. Until a camera has enough frames, the region's median stands in. */
  activity(fallbackBaseline: number | null): number | null {
    const frame = this.latest;
    if (!frame || frame.diff === null) return null;
    let baseline: number;
    if (this.diffs.length >= ACTIVITY_MIN_SAMPLES) baseline = median(this.diffs);
    else if (fallbackBaseline !== null) baseline = fallbackBaseline;
    else return null;
    return round(Math.min(warmupCap(this.diffs.length), (SCORE.ANOMALY_AT_BASELINE * frame.diff) / Math.max(baseline, ACTIVITY_FLOOR)), 3);
  }

  summary(fallbackBaseline: number | null, periodS: number, scored: Scored | null): WireCameraState {
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

/** What a scorer hands back for one camera. */
export interface Scored {
  attention: number | null;
  axes: AttentionAxes | null;
}

export class Poller {
  readonly cameras = new Map<number, CameraSlot>();
  readonly started_at = Date.now() / 1000;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  onStop: (() => void) | null = null;
  private radar = new Set<number>();

  isRadar(uid: number): boolean {
    const slot = this.cameras.get(uid);
    return !!slot && !this.watching.has(slot.camera.region) && this.radar.has(uid);
  }

  /** New anchors are spread across a full radar period, including rotation, so a national tick never creates a burst of snapshot requests. */
  setRadar(ids: number[]): void {
    const before = this.radar;
    this.radar = new Set(ids);
    const added = ids.filter((id) => !before.has(id));
    added.forEach((id, i) => {
      const slot = this.cameras.get(id);
      if (!slot || this.watching.has(slot.camera.region) || slot.polling || this.prioritized(id)) return;
      const spacing = RADAR.RADAR_PERIOD_S * (i + 1) / added.length;
      const remaining = slot.lastPollAt === null ? 0 : slot.lastPollAt + RADAR.RADAR_PERIOD_S - Date.now() / 1000;
      this.schedule(slot, Math.max(spacing, remaining));
    });
  }

  constructor(
    private readonly clients: Map<string, Client>,
    cameras: Map<number, CatalogCamera>,
    private readonly ring: number = DEFAULT_RING,
  ) {
    for (const [uid, camera] of cameras) this.cameras.set(uid, new CameraSlot(uid, camera));
  }

  get interval_s(): number {
    const periods = new Set<number>();
    for (const slot of this.cameras.values()) {
      const client = this.clients.get(slot.camera.source);
      if (client) periods.add(client.source.poll_period_s);
    }
    return periods.size > 0 ? Math.min(...periods) : 60;
  }

  /** Called after every poll that says something about the scene, which is a fresh frame or byte-identical bytes; a 304 or an unavailable camera is not reported. */
  onPoll: ((slot: CameraSlot, result: PollResult) => void) | null = null;

  /** Regions with viewer demand. Outside this set only radar anchors and explicit priority claims may poll. */
  private readonly watching = new Set<string>();

  /** What the viewer can actually see, per region, with the time it was last stated. */
  private readonly visible = new Map<string, { ids: Set<number>; at: number }>();

  /** Independent claims keep the pane and graph from canceling each other's attention, and expiry releases cameras when a caller stops restating its claim. */
  private readonly priority = new Map<string, { ids: Set<number>; expires: number }>();

  /** Newly promoted cameras are pulled forward so an existing slow sleep does not delay the first useful picture. */
  setPriority(source: string, ids: number[], ttlS = VISIBLE_TTL_S): void {
    const now = Date.now() / 1000;
    const before = new Set(ids.filter((uid) => this.prioritized(uid)));
    const after = new Set(ids);
    this.priority.set(source, { ids: after, expires: now + ttlS });
    for (const id of after) {
      if (before.has(id)) continue;
      const slot = this.cameras.get(id);
      if (!slot || slot.polling) continue;
      const target = now + this.dueIn(slot, this.periodFor(slot, 'fast'));
      if (!slot.timer || slot.dueAt > target + 1) {
        this.schedule(slot, Math.max(0, target - now));
      }
    }
  }

  private prioritized(uid: number): boolean {
    const now = Date.now() / 1000;
    return [...this.priority.values()].some((claim) => now < claim.expires && claim.ids.has(uid));
  }

  /** The wall names the cameras on screen on every state poll. An absent list leaves the previous one alone, because some clients have no notion of visible tiles; an empty list says that nothing is on screen. */
  setVisible(region: string, ids: number[] | null): void {
    if (ids === null) return;
    const before = this.visible.get(region)?.ids ?? new Set<number>();
    const now = Date.now() / 1000;
    const after = new Set(ids);
    this.visible.set(region, { ids: after, at: now });
    // A camera that has just come into view may be asleep for another few minutes, so pull it forward.
    for (const id of after) {
      if (before.has(id)) continue;
      const slot = this.cameras.get(id);
      if (!slot || slot.camera.region !== region || !this.watching.has(region)) continue;
      const target = now + this.dueIn(slot, this.periodFor(slot, 'fast'));
      if (slot.timer && slot.dueAt > target + 1) {
        clearTimeout(slot.timer);
        this.timers.delete(slot.timer);
        this.schedule(slot, Math.max(0, target - now));
      }
    }
  }

  /** Which tier a camera is in right now. */
  tierOf(slot: CameraSlot): Tier {
    if (this.prioritized(slot.uid)) return 'fast';
    if (!this.watching.has(slot.camera.region)) return this.radar.has(slot.uid) ? 'radar' : 'idle';
    const seen = this.visible.get(slot.camera.region);
    if (!seen || Date.now() / 1000 - seen.at > VISIBLE_TTL_S) return 'slow';
    return seen.ids.has(slot.uid) ? 'fast' : 'slow';
  }

  tierCounts(): Record<Tier, number> {
    const counts: Record<Tier, number> = { fast: 0, slow: 0, radar: 0, idle: 0 };
    for (const slot of this.cameras.values()) counts[this.tierOf(slot)]++;
    return counts;
  }

  /** The period this camera is actually being polled at, which the wall judges staleness against, so it has to be the real one rather than the source default. */
  periodFor(slot: CameraSlot, tier: Tier = this.tierOf(slot)): number {
    const base = this.clients.get(slot.camera.source)?.source.poll_period_s ?? 60;
    // The camera open in the panel keeps its source's own rate, outside the budget.
    if (this.inPanel(slot.uid)) return base;
    if (tier === 'radar') return RADAR.RADAR_PERIOD_S;
    const counts = this.budgetCounts();
    const source = slot.camera.source;
    // A camera held up by an incident or a neighbor's alarm is exempt from the stretch, since its stillness may be the thing worth seeing, but it shares the on-screen budget like any tile.
    if (this.prioritized(slot.uid)) return Math.max(base, (counts.fast.get(source) ?? 1) * BUDGET.ON_SCREEN_S);
    const floor = tier === 'fast' ? Math.max(base, (counts.fast.get(source) ?? 1) * BUDGET.ON_SCREEN_S) : Math.max(SLOW_PERIOD_S, (counts.slow.get(source) ?? 1) * BUDGET.OFF_SCREEN_S);
    return Math.max(floor, base * slot.stretch);
  }

  private counted: { at: number; fast: Map<string, number>; slow: Map<string, number> } = { at: 0, fast: new Map(), slow: new Map() };

  /** On-screen and off-screen cameras per source right now, for the budget, taken at most every few seconds. */
  private budgetCounts(): { fast: Map<string, number>; slow: Map<string, number> } {
    const now = Date.now();
    if (now - this.counted.at < BUDGET.RECOUNT_MS) return this.counted;
    const fast = new Map<string, number>();
    const slow = new Map<string, number>();
    for (const slot of this.cameras.values()) {
      if (this.inPanel(slot.uid)) continue;
      const tier = this.tierOf(slot);
      const into = tier === 'fast' ? fast : tier === 'slow' ? slow : null;
      if (into) into.set(slot.camera.source, (into.get(slot.camera.source) ?? 0) + 1);
    }
    this.counted = { at: now, fast, slow };
    return this.counted;
  }

  /** True for a camera a viewer has open in the panel right now. */
  private inPanel(uid: number): boolean {
    const claim = this.priority.get(`panel:${String(uid)}`);
    return claim !== undefined && Date.now() / 1000 < claim.expires;
  }

  /** True once this region's cameras are being polled. */
  isWatching(region: string): boolean {
    return this.watching.has(region);
  }

  watchedRegions(): string[] {
    return [...this.watching].sort();
  }

  /** Begin polling one region's cameras. Cheap to call repeatedly; it does nothing if the region is already running. */
  watch(region: string): void {
    if (this.stopped || this.watching.has(region)) return;
    this.watching.add(region);
    this.startSlots([...this.cameras.values()].filter((slot) => slot.camera.region === region));
  }

  /** Release viewer demand while retaining scored history for the national board and the next radar frame. */
  unwatch(region: string): void {
    if (!this.watching.delete(region)) return;
    // Keep the newest picture and the difference history, so a radar anchor carries on differencing and the board can still show its latest frame. Drop the rest of the replay ring, or a session that browses the country would hold the replay of every camera it ever showed.
    for (const slot of this.cameras.values()) {
      if (slot.camera.region !== region || slot.frames.length <= 1) continue;
      slot.frames.splice(0, slot.frames.length - 1);
    }
    this.visible.delete(region);
    console.log(`stopped polling ${region}`);
  }

  start(): void {
    this.startSlots([...this.cameras.values()]);
  }

  private startSlots(slots0: CameraSlot[]): void {
    const bySource = new Map<string, CameraSlot[]>();
    for (const slot of slots0) {
      this.watching.add(slot.camera.region);
      const list = bySource.get(slot.camera.source);
      if (list) list.push(slot);
      else bySource.set(slot.camera.source, [slot]);
    }
    for (const [key, slots] of bySource) {
      const client = this.clients.get(key);
      if (!client) continue;
      const period = client.source.poll_period_s;
      slots.sort((a, b) => a.uid - b.uid);
      slots.forEach((slot, i) => {
        // Staggered starts: one camera's poll every period/n rather than the whole region at once.
        this.schedule(slot, (period * i) / slots.length);
      });
      console.log(`watching ${slots.length} cameras from ${key}: at most one picture every ${String(BUDGET.ON_SCREEN_S)}s on screen and every ${String(BUDGET.OFF_SCREEN_S)}s off it, each camera no faster than every ${period.toFixed(0)}s`);
    }
  }

  private schedule(slot: CameraSlot, delayS: number): void {
    if (this.stopped || slot.polling) return;
    slot.reserved = false;
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

  /** When each source may next be asked for a picture, per tier. */
  private readonly nextTurn = new Map<string, number>();

  /** Seconds until this camera's source may next be asked for a picture in its tier, with that turn reserved for it, so that requests are spaced by the budget however the cameras' own timers line up. The camera open in the panel and radar anchors are outside the budget. */
  private turn(slot: CameraSlot): number {
    const tier = this.tierOf(slot);
    if (this.inPanel(slot.uid) || (tier !== 'fast' && tier !== 'slow')) return 0;
    const key = `${slot.camera.source}:${tier}`;
    const now = Date.now() / 1000;
    const at = Math.max(now, this.nextTurn.get(key) ?? 0);
    this.nextTurn.set(key, at + (tier === 'fast' ? BUDGET.ON_SCREEN_S : BUDGET.OFF_SCREEN_S));
    return at - now;
  }

  private async tick(slot: CameraSlot): Promise<void> {
    if (this.stopped || this.tierOf(slot) === 'idle') return;
    if (!this.watching.has(slot.camera.region) && slot.lastPollAt !== null) {
      const remaining = slot.lastPollAt + this.periodFor(slot) - Date.now() / 1000;
      if (remaining > 0) { this.schedule(slot, remaining); return; }
    }
    if (!slot.reserved) {
      const wait = this.turn(slot);
      if (wait > 0) {
        this.schedule(slot, wait);
        slot.reserved = true;
        return;
      }
    }
    slot.reserved = false;
    slot.polling = true;
    slot.lastPollAt = Date.now() / 1000;
    // Read now rather than when this poll was scheduled, so a change in tier or stretch takes effect on the next hop.
    const period = this.periodFor(slot);
    let delay = period;
    try {
      const result = await this.pollOnce(slot);
      this.adapt(slot, result);
      if (this.onPoll && (result === 'fresh' || result === 'unchanged')) this.onPoll(slot, result);
      delay = this.nextDelay(slot, result, this.periodFor(slot));
    } catch (error) {
      // Whatever the network does, the loop stays alive.
      slot.errors++;
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      slot.last_error = `${name}: ${message}`.slice(0, 200);
      console.warn(`camera ${slot.uid}: ${slot.last_error}`);
    }
    slot.polling = false;
    if (!this.watching.has(slot.camera.region)) delay = Math.max(delay, this.periodFor(slot));
    if (this.tierOf(slot) !== 'idle') this.schedule(slot, delay);
  }

  /** How long this camera would wait if it were polled at `period` right now, by the same rule the scheduler uses. Used to decide whether a camera coming into view is worth pulling forward. */
  private dueIn(slot: CameraSlot, period: number): number {
    return this.nextDelay(slot, 'unchanged', period);
  }

  /** Stretches a quiet camera's period and snaps it back the instant something moves.
   *
   * Up is gradual and down is immediate on purpose, because a camera that wakes up must be back on its normal period for the very next poll, or a stretch would quietly become a way to miss an incident. */
  private adapt(slot: CameraSlot, result: PollResult): void {
    if (result === 'unavailable' || result === 'not_modified') return;
    const diff = result === 'fresh' ? slot.latest?.diff ?? null : 0;
    if (diff !== null && diff > ACTIVE_DIFF) {
      slot.stretch = 1;
      return;
    }
    // Identical bytes, or a fresh frame that differs only by sensor noise: nothing is happening in front of this camera.
    if (diff !== null && diff <= ACTIVITY_FLOOR) slot.stretch = Math.min(MAX_STRETCH, slot.stretch + STRETCH_STEP);
  }

  /** Seconds until this camera's next poll, by `nextPollDelay`. */
  private nextDelay(slot: CameraSlot, result: PollResult, period: number): number {
    return nextPollDelay(result, slot.last_modified_seen, period, Date.now() / 1000);
  }

  async pollOnce(slot: CameraSlot): Promise<PollResult> {
    slot.polls++;
    const prev = slot.latest;
    const client = this.clients.get(slot.camera.source);
    if (!client) throw new Error(`no client for source ${slot.camera.source}`);
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
    const { thumb, brightness, contrast, white, diff } = await analyze(snap.data, slot.lastThumb);
    slot.lastThumb = thumb;
    slot.frames.push({
      ts: snap.fetched_at,
      last_modified: snap.last_modified,
      data: snap.data,
      content_type: snap.content_type,
      brightness,
      diff,
    });
    if (slot.frames.length > this.ring) slot.frames.shift();
    slot.freshAt.push(snap.fetched_at);
    slot.contrast = contrast;
    slot.contrasts.push(contrast);
    if (slot.contrasts.length > DIFF_HISTORY) slot.contrasts.shift();
    slot.white = white;
    slot.whites.push(white);
    if (slot.whites.length > DIFF_HISTORY) slot.whites.shift();
    if (diff !== null) {
      slot.diffs.push(diff);
      if (slot.diffs.length > DIFF_HISTORY) slot.diffs.shift();
    }
    return 'fresh';
  }

  /** Per-camera state, with each region's median frame difference supplied as the baseline for cameras that do not yet have enough history of their own.
   *
   * `score` decorates each camera with its attention score, passed the same regional fallback the activity number uses so the two share a baseline. */
  summaries(score?: (slot: CameraSlot, fallbackBaseline: number | null) => Scored): WireCameraState[] {
    const byRegion = new Map<string, number[]>();
    for (const slot of this.cameras.values()) {
      const list = byRegion.get(slot.camera.region);
      if (list) list.push(...slot.diffs);
      else byRegion.set(slot.camera.region, [...slot.diffs]);
    }
    const baselines = new Map<string, number>();
    for (const [region, diffs] of byRegion) if (diffs.length > 0) baselines.set(region, median(diffs));
    return [...this.cameras.values()].map((slot) => {
      const fallback = baselines.get(slot.camera.region) ?? null;
      return slot.summary(fallback, this.periodFor(slot), score ? score(slot, fallback) : null);
    });
  }

  stop(): void {
    this.stopped = true;
    this.onStop?.();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
