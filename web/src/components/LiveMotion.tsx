import { useEffect, useRef, type ReactElement } from 'react';
import { HoverCard } from './HoverCard';
import type { AttentionAxes } from '@rt511/shared';

// These anchors mirror server TUNING alongside the sampler equation so live explanations work even when the Scores pane has never been opened.
const ANOMALY_AT_BASELINE = 0.5;
const SCALE_AMPLIFIER_MIN = 0.5;
const SCALE_AMPLIFIER_MAX = 1.5;
const WIDTH = 64;
const HEIGHT = 48;
const WINDOW = 60;
const WARMUP = 10;
/** One tenth of a grey level across the image suppresses tiny codec fluctuations without imposing the much larger noise floor used for snapshots a minute apart. This is a live measurement floor, never the server baseline. */
const EPSILON = 0.1 / 255;
/** One hundredth of a grey level averaged across the image filters near-identical readbacks while staying ten times below the scoring floor so small real changes can still count. */
const DUPLICATE_THRESHOLD = 0.01 / 255;
const STALL_MS = 5000;

/** Pixel work and the small readout stay outside React renders so sampling does not rebuild the player or allocate new history arrays every second. Canvas readback itself necessarily returns a fresh ImageData because browsers offer no reusable destination buffer. */
export function LiveMotion({ video, axes, active }: { video: HTMLVideoElement | null; axes: AttentionAxes | null; active: boolean }): ReactElement {
  const label = useRef<HTMLSpanElement>(null);
  const plot = useRef<SVGSVGElement>(null);
  const line = useRef<SVGPolylineElement>(null);
  const latestAxes = useRef(axes);
  const blocked = useRef(false);
  const measurement = useRef<{ change: number; median: number; anomaly: number } | null>(null);
  const liveExplanation = useRef<HTMLParagraphElement>(null);
  const explain = (): string => {
    const sample = measurement.current;
    const a = latestAxes.current;
    if (!sample || !a) return 'Waiting for enough new frames to measure this camera.';
    const movement = a.scale_amplifier * sample.anomaly;
    const floor = a.gate?.floor ?? 0;
    const winner = a.incident_floor >= movement && a.incident_floor >= floor ? 'Incident' : floor >= movement ? 'Stopped traffic' : 'Movement';
    return `Current change ${sample.change.toFixed(5)}. Typical change ${sample.median.toFixed(5)}. Ratio ${(sample.change / Math.max(sample.median, EPSILON)).toFixed(2)} with a small noise floor. Movement ${sample.anomaly.toFixed(3)}. Road factor ${a.scale_amplifier.toFixed(3)} gives ${movement.toFixed(3)}. Incident floor ${a.incident_floor.toFixed(3)}. Stopped traffic floor ${floor.toFixed(3)}. ${winner} wins. A floor wins a tie. The result is limited to 0 through 1.`;
  };
  const explainRef = useRef(explain);
  explainRef.current = explain;

  useEffect(() => { latestAxes.current = axes; }, [axes]);

  useEffect(() => {
    const readout = label.current;
    const svg = plot.current;
    const trace = line.current;
    if (!readout || !svg || !trace) return;
    measurement.current = null;
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
    const previous = new Float64Array(WIDTH * HEIGHT);
    const current = new Float64Array(WIDTH * HEIGHT);
    const differences = new Float64Array(WINDOW);
    const sorted = new Float64Array(WINDOW);
    const attention = new Float64Array(WINDOW);
    const times = new Float64Array(WINDOW);
    for (let i = 0; i < WINDOW; i++) trace.points.appendItem(svg.createSVGPoint());
    let count = 0;
    let cursor = 0;
    let scores = 0;
    let scoreCursor = 0;
    let havePrevious = false;
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
      havePrevious = false;
      count = 0;
      cursor = 0;
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
      // Like server/src/attention.ts observe() skipping byte-identical polls, repeated frames must not enter the baseline or plotted history.
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
      let difference = 0;
      for (let i = 0; i < previous.length; i++) {
        const offset = i * 4;
        const grey = (0.299 * pixels[offset]! + 0.587 * pixels[offset + 1]! + 0.114 * pixels[offset + 2]!) / 255;
        difference += Math.abs(grey - previous[i]!);
        current[i] = grey;
      }
      const diff = difference / previous.length;
      // Match server/src/attention.ts observe()'s byte-identical-poll skip, retaining the last accepted comparison frame. Applied whether or not presentation timestamps exist: an encoder emitting a steady frame rate from a slower camera stamps a repeated picture with a fresh mediaTime, so the timestamp check above only saves a readback and it is this content check that keeps repeats out of the baseline.
      if (havePrevious && diff < DUPLICATE_THRESHOLD) {
        skipDuplicate();
        return;
      }
      previous.set(current);
      sampledMediaTime = presentedMediaTime;
      lastAcceptedAt = performance.now();
      if (!havePrevious) {
        havePrevious = true;
        readout.textContent = 'measuring';
        return;
      }
      differences[cursor] = diff;
      cursor = (cursor + 1) % WINDOW;
      count = Math.min(WINDOW, count + 1);
      /** Insertion into fixed scratch space avoids allocating a sorted copy or a subarray for a partially filled window. */
      for (let i = 0; i < count; i++) {
        const value = differences[i]!;
        let j = i;
        while (j > 0 && sorted[j - 1]! > value) {
          sorted[j] = sorted[j - 1]!;
          j--;
        }
        sorted[j] = value;
      }
      const currentAxes = latestAxes.current;
      if (count < WARMUP || !currentAxes) {
        readout.textContent = count < WARMUP ? 'measuring' : 'waiting for camera score';
        return;
      }
      const middle = Math.floor(count / 2);
      const median = count % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
      /** Mirrors server/src/attention.ts with ANOMALY_AT_BASELINE at 0.5 and ALPHA_ABSOLUTE at zero, so spectacle equals anomaly and the two weights sum to one. Revisit this equation when that server tuning changes. */
      const anomaly = Math.min(1, ANOMALY_AT_BASELINE * diff / Math.max(median, EPSILON));
      const score = Math.max(0, Math.min(1, Math.max(currentAxes.scale_amplifier * anomaly, currentAxes.incident_floor, currentAxes.queue_floor, currentAxes.gate?.floor ?? 0)));
      measurement.current = { change: diff, median, anomaly };
      if (liveExplanation.current) liveExplanation.current.textContent = explainRef.current();
      readout.textContent = score.toFixed(3);
      const now = performance.now();
      attention[scoreCursor] = score;
      times[scoreCursor] = now;
      scoreCursor = (scoreCursor + 1) % WINDOW;
      scores = Math.min(WINDOW, scores + 1);
      let plotted = 0;
      for (let i = 0; i < scores; i++) {
        const index = (scoreCursor - scores + i + WINDOW) % WINDOW;
        const age = (now - times[index]!) / 1000;
        if (age >= WINDOW) continue;
        const point = trace.points.getItem(plotted++);
        point.x = 2 + (1 - age / WINDOW) * 236;
        point.y = 32 - attention[index]! * 30;
      }
      /** Unused points repeat the newest sample so the preallocated polyline never draws a spurious tail to zero. */
      for (let i = plotted; i < WINDOW; i++) {
        const point = trace.points.getItem(i);
        point.x = 238;
        point.y = 32 - score * 30;
      }
      trace.style.visibility = 'visible';
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
  }, [video, active]);

  return (
    <div className="hero-motion">
      <div><HoverCard content={() => <>
        <p>Every second the browser compares the newest new video frame with the previous one on a small greyscale copy and averages how much the pixels changed.</p>
        <p>Change is compared with this camera’s typical change over the last minute of new frames. Matching typical scores {ANOMALY_AT_BASELINE} and twice typical saturates. Repeated frames are skipped.</p>
        <p>The road factor multiplies movement and runs from {SCALE_AMPLIFIER_MIN} for a quiet street to {SCALE_AMPLIFIER_MAX} for a major interstate. A higher incident, queue or stopped traffic floor wins.</p>
        <p ref={liveExplanation}>{explainRef.current()}</p>
        <p>The wall uses the same formula on snapshots a minute apart with an hourly baseline.</p>
      </>}>Live attention <span ref={label}>measuring</span></HoverCard></div>
      <svg ref={plot} viewBox="0 0 240 34" preserveAspectRatio="none" role="img" aria-label="Live attention over the last 60 seconds on a scale from 0 to 1">
        <polyline ref={line} />
      </svg>
      <p>Measured from the live video every second. The wall score comes from minute-by-minute snapshots. The line shows the last 60 seconds.</p>
    </div>
  );
}
