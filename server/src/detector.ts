/** Counts vehicles in a still frame, for the zero-motion gate.
 *
 * The gate fires on a frame that changed by nothing in an hour that usually moves. Frame difference cannot say whether that is traffic standing still or a road with nothing on it, and those are the two answers the arbiter is asked to choose between. A count of vehicles in the picture is the evidence that separates them, so the frame the gate fired on is posted to the detector and the count is handed to the arbiter alongside the telemetry it already reads. The count decides nothing here. It is evidence, and the floor stays the arbiter's to set.
 *
 * The detector is a separate process, `uv run rt511 detect`, because the model behind it is AGPL-3.0 and optional. Every path through this file has a way out that leaves the gate exactly as it was before the detector existed: no process listening, a timeout, an error, a frame it cannot decode. In all of them the arbiter is asked without a count rather than not asked. */

import type { Frame } from './poller.js';
import { round } from './config.js';
import { JsonLog } from './jsonlog.js';

export const DETECTOR = {
  /** Where `rt511 detect` listens by default. Overridden by RT511_DETECTOR_URL. */
  URL: 'http://127.0.0.1:8513',
  /** Per frame. Inference takes tens of milliseconds once warm, so anything near this is a process that has gone away rather than one that is busy. */
  TIMEOUT_MS: 5000,
  /** Frames in the air at once. The gate fires on a camera at a time, and the detector serves one frame at a time anyway, so more than this would only queue on its side. */
  MAX_IN_FLIGHT: 2,
  /** After the detector fails to answer, it is left alone for this long and still cameras are asked about without a count. Also how often a detector that was not running at startup is looked for again, so starting it later needs no restart of the server. */
  RETRY_AFTER_S: 60,
  LOG_MAX_BYTES: 8 * 1024 * 1024,
} as const;

/** What the detector found in one frame. */
export interface VehicleCount {
  vehicles: number;
  by_class: Record<string, number>;
  /** Highest first, one per vehicle counted. */
  confidences: number[];
  model: string;
  latency_ms: number;
}

/** One call to the detector. Injected so that the gate can be tested without a process listening. */
export type Detect = (image: Buffer, contentType: string) => Promise<VehicleCount>;

/** What the gate should do about a camera's newest frame right now. `pending` means a count is on its way and the arbiter should wait for it; null means there will be no count for this frame and the arbiter should be asked without one. */
export type Evidence = { count: VehicleCount; frameTs: number } | 'pending' | null;

export class Detector {
  /** The newest count per camera, and which frame it belongs to. A count is only ever evidence about the frame it was taken from. */
  private readonly counts = new Map<number, { frameTs: number; count: VehicleCount }>();
  /** Frames the detector could not count, so the same frame is never retried and never holds the arbiter back. */
  private readonly failed = new Map<number, number>();
  private readonly pending = new Set<number>();
  private readonly log: JsonLog;
  /** Null until the detector has answered once. Until then, and whenever it stops answering, the gate runs without it. */
  private model: string | null = null;
  private downUntil = 0;
  private probing = false;
  calls = 0;
  errors = 0;

  constructor(
    private readonly detect: Detect | null,
    logDir: string,
    private readonly probe: (() => Promise<string>) | null = null,
  ) {
    this.log = new JsonLog(logDir, 'detector', DETECTOR.LOG_MAX_BYTES);
  }

  get enabled(): boolean {
    return this.detect !== null && this.model !== null;
  }

  /** Looks for the detector, and returns at once. Called at startup and again from `evidence` while it is missing, at most once per retry window. */
  look(now = Date.now() / 1000): void {
    if (!this.probe || this.probing || now < this.downUntil) return;
    this.probing = true;
    this.probe()
      .then((model) => {
        if (this.model === null) console.log(`detector ${model} on, still cameras will be asked about with a vehicle count`);
        this.model = model;
      })
      .catch(() => {
        this.downUntil = Date.now() / 1000 + DETECTOR.RETRY_AFTER_S;
      })
      .finally(() => {
        this.probing = false;
      });
  }

  /** The count for a camera's newest frame, starting one if there is none yet. Never waits: a count lands for the next pass of the gate rather than this one, which is ten seconds on a watched wall. */
  evidence(uid: number, frame: Frame | null, now = Date.now() / 1000): Evidence {
    if (!this.detect || !frame) return null;
    if (this.model === null) {
      this.look(now);
      return null;
    }
    const held = this.counts.get(uid);
    if (held && held.frameTs === frame.ts) return held;
    if (this.failed.get(uid) === frame.ts) return null;
    if (now < this.downUntil) return null;
    if (this.pending.has(uid)) return 'pending';
    // Every slot is taken. Waiting a pass is cheaper than asking without a count that is a few tens of milliseconds away.
    if (this.pending.size >= DETECTOR.MAX_IN_FLIGHT) return 'pending';
    void this.run(uid, frame);
    return 'pending';
  }

  private async run(uid: number, frame: Frame): Promise<void> {
    const detect = this.detect;
    if (!detect) return;
    this.pending.add(uid);
    try {
      const count = await detect(frame.data, frame.content_type);
      this.calls++;
      this.counts.set(uid, { frameTs: frame.ts, count });
      const at = Date.now() / 1000;
      this.log.write(
        [
          {
            ts: round(at, 3),
            camera: uid,
            frame_ts: round(frame.ts, 3),
            frame_diff: frame.diff === null ? null : round(frame.diff, 5),
            vehicles: count.vehicles,
            by_class: count.by_class,
            confidences: count.confidences,
            model: count.model,
            latency_ms: count.latency_ms,
          },
        ],
        at,
      );
    } catch (error) {
      this.errors++;
      this.failed.set(uid, frame.ts);
      // A frame the detector refused is that frame's problem. Anything else is the detector's, and it is left alone for a while rather than asked again on every pass.
      if ((error as { status?: unknown }).status !== 400) {
        if (Date.now() / 1000 >= this.downUntil) console.warn(`detector unavailable (${error instanceof Error ? error.name : 'Error'}), still cameras are asked about without a vehicle count`);
        this.downUntil = Date.now() / 1000 + DETECTOR.RETRY_AFTER_S;
      }
    } finally {
      this.pending.delete(uid);
    }
  }

  /** Resolves once every queued log line is on disk, for a test that needs to read the file back. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await this.log.drain();
  }

  stats(): { enabled: boolean; model: string | null; calls: number; errors: number } {
    return { enabled: this.enabled, model: this.model, calls: this.calls, errors: this.errors };
  }
}

class DetectorError extends Error {
  constructor(readonly status: number) {
    super(`detector answered ${String(status)}`);
    this.name = 'DetectorError';
  }
}

/** The binding to `rt511 detect`: the frame goes up as its own bytes, and a count comes back. */
export function createDetect(url: string): { detect: Detect; probe: () => Promise<string> } {
  const base = url.replace(/\/+$/, '');
  return {
    detect: async (image, contentType) => {
      const response = await fetch(`${base}/detect`, { method: 'POST', body: image, headers: { 'content-type': contentType }, signal: AbortSignal.timeout(DETECTOR.TIMEOUT_MS) });
      if (!response.ok) throw new DetectorError(response.status);
      const body = (await response.json()) as Partial<VehicleCount>;
      // A body that does not carry a count is a failure, not a count of zero. An empty road is exactly the answer that must not be invented.
      if (typeof body.vehicles !== 'number' || typeof body.by_class !== 'object' || body.by_class === null) throw new Error('detector answer missing a count');
      return {
        vehicles: body.vehicles,
        by_class: body.by_class,
        confidences: Array.isArray(body.confidences) ? body.confidences : [],
        model: typeof body.model === 'string' ? body.model : 'unknown',
        latency_ms: typeof body.latency_ms === 'number' ? body.latency_ms : 0,
      };
    },
    probe: async () => {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(DETECTOR.TIMEOUT_MS) });
      if (!response.ok) throw new DetectorError(response.status);
      const body = (await response.json()) as { model?: unknown };
      return typeof body.model === 'string' ? body.model : 'unknown';
    },
  };
}
