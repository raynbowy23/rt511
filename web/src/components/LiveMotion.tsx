import { useEffect, useRef, type ReactElement } from 'react';
import { HoverCard } from './HoverCard';
import { period } from '../format';
import { SCORE, combineAttention, type AttentionAxes } from '@rt511/shared';

// The same constants the server scores with, from the shared package, so the live line and the wall cannot drift apart.
const { ANOMALY_AT_BASELINE, SCALE_AMPLIFIER_MIN, SCALE_AMPLIFIER_MAX } = SCORE;
const WIDTH = 64;
const HEIGHT = 48;
const WINDOW = 60;
const WARMUP = 10;
/** One tenth of a gray level across the image suppresses codec fluctuations without the much larger noise floor used for snapshots a minute apart. A live measurement floor, never the server baseline. */
const EPSILON = 0.1 / 255;
/** One hundredth of a gray level averaged across the image filters near-identical readbacks while staying ten times below the scoring floor so small real changes can still count. */
const DUPLICATE_THRESHOLD = 0.01 / 255;
const STALL_MS = 5000;

/** The measurement itself, shared by video frames sampled every second and snapshots from an agency that refreshes every few seconds. Everything is in fixed arrays so a sample allocates nothing but its readback. */
class MotionTrack {
  private readonly previous = new Float64Array(WIDTH * HEIGHT);
  private readonly current = new Float64Array(WIDTH * HEIGHT);
  private readonly differences = new Float64Array(WINDOW);
  private readonly sorted = new Float64Array(WINDOW);
  private readonly attention = new Float64Array(WINDOW);
  private readonly times = new Float64Array(WINDOW);
  private count = 0;
  private cursor = 0;
  private scores = 0;
  private scoreCursor = 0;
  private havePrevious = false;

  reset(): void {
    this.count = 0;
    this.cursor = 0;
    this.havePrevious = false;
  }

  /** One picture's pixels, RGBA as a canvas returns them. A `duplicate` never enters the baseline, matching the server skipping byte-identical polls. */
  push(pixels: Uint8ClampedArray, axes: AttentionAxes | null, nowMs: number): { kind: 'duplicate' | 'first' | 'warming' | 'unscored' } | { kind: 'scored'; change: number; median: number; anomaly: number; score: number } {
    let difference = 0;
    for (let i = 0; i < this.previous.length; i++) {
      const offset = i * 4;
      const gray = (0.299 * pixels[offset]! + 0.587 * pixels[offset + 1]! + 0.114 * pixels[offset + 2]!) / 255;
      difference += Math.abs(gray - this.previous[i]!);
      this.current[i] = gray;
    }
    const diff = difference / this.previous.length;
    if (this.havePrevious && diff < DUPLICATE_THRESHOLD) return { kind: 'duplicate' };
    this.previous.set(this.current);
    if (!this.havePrevious) {
      this.havePrevious = true;
      return { kind: 'first' };
    }
    this.differences[this.cursor] = diff;
    this.cursor = (this.cursor + 1) % WINDOW;
    this.count = Math.min(WINDOW, this.count + 1);
    /** Insertion into fixed scratch space avoids allocating a sorted copy or a subarray for a partially filled window. */
    for (let i = 0; i < this.count; i++) {
      const value = this.differences[i]!;
      let j = i;
      while (j > 0 && this.sorted[j - 1]! > value) {
        this.sorted[j] = this.sorted[j - 1]!;
        j--;
      }
      this.sorted[j] = value;
    }
    if (this.count < WARMUP) return { kind: 'warming' };
    if (!axes) return { kind: 'unscored' };
    const middle = Math.floor(this.count / 2);
    const median = this.count % 2 ? this.sorted[middle]! : (this.sorted[middle - 1]! + this.sorted[middle]!) / 2;
    /** Mirrors server/src/attention.ts with ANOMALY_AT_BASELINE at 0.5 and ALPHA_ABSOLUTE at zero, so spectacle equals anomaly and the two weights sum to one. Revisit this equation when that server tuning changes. */
    const anomaly = Math.min(1, ANOMALY_AT_BASELINE * diff / Math.max(median, EPSILON));
    const score = combineAttention(axes.scale_amplifier * (axes.review?.factor ?? 1) * anomaly, Math.max(axes.incident_floor, axes.queue_floor, axes.gate?.floor ?? 0));
    this.attention[this.scoreCursor] = score;
    this.times[this.scoreCursor] = nowMs;
    this.scoreCursor = (this.scoreCursor + 1) % WINDOW;
    this.scores = Math.min(WINDOW, this.scores + 1);
    return { kind: 'scored', change: diff, median, anomaly, score };
  }

  /** Draws the scores of the last `spanS` seconds onto a polyline preallocated with WINDOW points. */
  plot(trace: SVGPolylineElement, nowMs: number, spanS: number, latest: number): void {
    let plotted = 0;
    for (let i = 0; i < this.scores; i++) {
      const index = (this.scoreCursor - this.scores + i + WINDOW) % WINDOW;
      const age = (nowMs - this.times[index]!) / 1000;
      if (age >= spanS) continue;
      const point = trace.points.getItem(plotted++);
      point.x = 2 + (1 - age / spanS) * 236;
      point.y = 32 - this.attention[index]! * 30;
    }
    /** Unused points repeat the newest sample so the preallocated polyline never draws a spurious tail to zero. */
    for (let i = plotted; i < WINDOW; i++) {
      const point = trace.points.getItem(i);
      point.x = 238;
      point.y = 32 - latest * 30;
    }
    trace.style.visibility = 'visible';
  }
}

/** Pixel work and the readout stay outside React renders so sampling does not rebuild the player every second. Canvas readback necessarily returns a fresh ImageData because browsers offer no reusable destination buffer.
 *
 * With live video it samples a frame a second. Without it, a `still` camera is measured once per new picture, so its line spans sixty pictures rather than sixty seconds. */
export function LiveMotion({ video, axes, active, still = null }: { video: HTMLVideoElement | null; axes: AttentionAxes | null; active: boolean; still?: { src: string; periodS: number } | null }): ReactElement {
  const label = useRef<HTMLSpanElement>(null);
  const plot = useRef<SVGSVGElement>(null);
  const line = useRef<SVGPolylineElement>(null);
  const latestAxes = useRef(axes);
  const blocked = useRef(false);
  const measurement = useRef<{ change: number; median: number; anomaly: number } | null>(null);
  const liveExplanation = useRef<HTMLParagraphElement>(null);
  const track = useRef(new MotionTrack());
  const explain = (): string => {
    const sample = measurement.current;
    const a = latestAxes.current;
    if (!sample || !a) return 'Waiting for enough new frames to measure this camera.';
    const look = a.review?.factor ?? 1;
    const movement = a.scale_amplifier * look * sample.anomaly;
    const still = a.gate?.floor ?? 0;
    const strongest = Math.max(a.incident_floor, a.queue_floor, still);
    const band = strongest >= SCORE.FLOOR_HOLD_MIN ? `A floor of at least ${SCORE.FLOOR_HOLD_MIN} holds the camera in the upper band, from ${SCORE.BAND} to 1, above every camera without one.` : `With no floor of ${SCORE.FLOOR_HOLD_MIN} or more, the camera scores in the lower band, from 0 to ${SCORE.BAND}.`;
    return `Current change ${sample.change.toFixed(5)}. Typical change ${sample.median.toFixed(5)}. Ratio ${(sample.change / Math.max(sample.median, EPSILON)).toFixed(2)} with a small noise floor. Movement ${sample.anomaly.toFixed(3)}${look === 1 ? ' and' : ','} road factor ${a.scale_amplifier.toFixed(3)}${look === 1 ? '' : ` and second look ${look.toFixed(2)}`} give ${movement.toFixed(3)}. Incident floor ${a.incident_floor.toFixed(3)}, queue floor ${a.queue_floor.toFixed(3)}, stopped-traffic floor ${still.toFixed(3)}. ${band} Within a band, the larger of the movement and the strongest floor sets the level.`;
  };
  const explainRef = useRef(explain);
  explainRef.current = explain;

  useEffect(() => { latestAxes.current = axes; }, [axes]);

  const stillMode = !active && still !== null;
  const spanS = stillMode && still ? WINDOW * still.periodS : WINDOW;

  /** Shows what one accepted picture did to the measurement. Returns false for a repeat. */
  const record = (pixels: Uint8ClampedArray, readout: HTMLSpanElement, trace: SVGPolylineElement, span: number): boolean => {
    const now = performance.now();
    const result = track.current.push(pixels, latestAxes.current, now);
    if (result.kind === 'duplicate') return false;
    if (result.kind === 'first' || result.kind === 'warming') readout.textContent = 'measuring';
    else if (result.kind === 'unscored') readout.textContent = 'waiting for camera score';
    else if (result.kind === 'scored') {
      measurement.current = { change: result.change, median: result.median, anomaly: result.anomaly };
      if (liveExplanation.current) liveExplanation.current.textContent = explainRef.current();
      readout.textContent = result.score.toFixed(3);
      track.current.plot(trace, now, span, result.score);
    }
    return true;
  };
  const recordRef = useRef(record);
  recordRef.current = record;

  // Video: a frame a second while the stream plays.
  useEffect(() => {
    const readout = label.current;
    const svg = plot.current;
    const trace = line.current;
    if (!readout || !svg || !trace || stillMode) return;
    measurement.current = null;
    track.current.reset();
    trace.points.clear();
    trace.style.visibility = 'hidden';
    if (blocked.current) return;
    readout.textContent = active ? 'measuring' : 'waiting for live video';
    if (!video || !active) return;
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      readout.textContent = 'live motion is not available for this stream';
      blocked.current = true;
      return;
    }
    for (let i = 0; i < WINDOW; i++) trace.points.appendItem(svg.createSVGPoint());
    let timer: number | undefined;
    const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    let frameCallback: number | undefined;
    let presentedMediaTime: number | undefined;
    let sampledMediaTime: number | undefined;
    let lastAcceptedAt = 0;

    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      presentedMediaTime = metadata.mediaTime;
      frameCallback = video.requestVideoFrameCallback(onFrame);
    };

    const stop = (): void => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
      frameCallback = undefined;
      presentedMediaTime = undefined;
      sampledMediaTime = undefined;
      track.current.reset();
    };
    const ready = (): boolean => !video.paused && !video.ended && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && video.videoWidth > 0 && document.visibilityState === 'visible';
    const skipDuplicate = (): void => {
      if (performance.now() - lastAcceptedAt >= STALL_MS) readout.textContent = 'stream is not updating';
    };
    const sample = (): void => {
      if (!ready()) {
        stop();
        readout.textContent = 'waiting for live video';
        return;
      }
      // Like server/src/attention.ts observe() skipping byte-identical polls, repeated frames must not enter the baseline or plotted history. This saves the readback when the timestamp already says the frame repeats.
      if (hasFrameCallback && (presentedMediaTime === undefined || presentedMediaTime === sampledMediaTime)) {
        skipDuplicate();
        return;
      }
      let pixels: Uint8ClampedArray;
      try {
        context.drawImage(video, 0, 0, WIDTH, HEIGHT);
        pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
      } catch {
        /** A tainted canvas cannot recover on another tick. Stop on readback failures and allow a new camera to create a fresh sampler. */
        blocked.current = true;
        stop();
        readout.textContent = 'live motion is not available for this stream';
        return;
      }
      if (!recordRef.current(pixels, readout, trace, WINDOW)) {
        skipDuplicate();
        return;
      }
      sampledMediaTime = presentedMediaTime;
      lastAcceptedAt = performance.now();
    };
    const sync = (): void => {
      if (blocked.current) return;
      if (!ready()) {
        stop();
        trace.style.visibility = 'hidden';
        readout.textContent = 'waiting for live video';
      } else if (timer === undefined) {
        readout.textContent = 'measuring';
        lastAcceptedAt = performance.now();
        if (hasFrameCallback) frameCallback = video.requestVideoFrameCallback(onFrame);
        timer = window.setInterval(sample, 1000);
      }
    };
    const events = ['playing', 'pause', 'ended', 'waiting', 'emptied', 'loadeddata', 'canplay', 'seeking', 'seeked'];
    for (const event of events) video.addEventListener(event, sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      stop();
      for (const event of events) video.removeEventListener(event, sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [video, active, stillMode]);

  // Snapshots: the track is set up once per camera and fed each new picture as it arrives.
  const stillReady = useRef(false);
  useEffect(() => {
    const readout = label.current;
    const svg = plot.current;
    const trace = line.current;
    if (!readout || !svg || !trace || !stillMode) return;
    measurement.current = null;
    track.current.reset();
    trace.points.clear();
    for (let i = 0; i < WINDOW; i++) trace.points.appendItem(svg.createSVGPoint());
    trace.style.visibility = 'hidden';
    readout.textContent = 'measuring';
    stillReady.current = true;
    return () => {
      stillReady.current = false;
    };
  }, [stillMode]);

  const stillSrc = stillMode ? still?.src ?? '' : '';
  useEffect(() => {
    const readout = label.current;
    const trace = line.current;
    if (!stillSrc || !readout || !trace || !stillReady.current) return;
    let canceled = false;
    const picture = new Image();
    picture.decoding = 'async';
    picture.onload = () => {
      if (canceled) return;
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      try {
        context.drawImage(picture, 0, 0, WIDTH, HEIGHT);
        recordRef.current(context.getImageData(0, 0, WIDTH, HEIGHT).data, readout, trace, spanS);
      } catch {
        readout.textContent = 'motion is not available for this camera';
      }
    };
    picture.src = stillSrc;
    return () => {
      canceled = true;
    };
  }, [stillSrc, spanS]);

  const span = spanS >= 120 ? `${String(Math.round(spanS / 60))} minutes` : `${String(spanS)} seconds`;
  const every = still ? period(still.periodS) : '';
  return (
    <div className="hero-motion">
      <div><HoverCard content={() => <>
        {stillMode ? (
          <p>Each time the agency publishes a new picture, every {every}, the browser compares it with the previous one on a small grayscale copy and averages how much the pixels changed.</p>
        ) : (
          <p>Every second the browser compares the newest new video frame with the previous one on a small grayscale copy and averages how much the pixels changed.</p>
        )}
        <p>Change is compared with this camera’s typical change over its last {WINDOW} new {stillMode ? 'pictures' : 'frames'}. Matching typical scores {ANOMALY_AT_BASELINE} and twice typical saturates. Repeated {stillMode ? 'pictures' : 'frames'} are skipped.</p>
        <p>The road factor multiplies movement and runs from {SCALE_AMPLIFIER_MIN} for a quiet street to {SCALE_AMPLIFIER_MAX} for a major interstate. A higher incident, queue or stopped traffic floor wins.</p>
        <p ref={liveExplanation}>{explainRef.current()}</p>
        <p>The wall uses the same formula on snapshots a minute apart with an hourly baseline.</p>
      </>}>Live attention <span ref={label}>measuring</span></HoverCard></div>
      <svg ref={plot} viewBox="0 0 240 34" preserveAspectRatio="none" role="img" aria-label={`Live attention over the last ${span} on a scale from 0 to 1`}>
        <polyline ref={line} />
      </svg>
      <p>{stillMode ? `Measured from each new picture, every ${every}.` : 'Measured from the live video every second.'} The wall score comes from minute-by-minute snapshots. The line shows the last {span}.</p>
    </div>
  );
}
