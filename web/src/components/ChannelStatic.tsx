import { useEffect, useRef, type ReactElement } from 'react';
import { prefersReducedMotion } from '../motion';

/** How long the snow lasts. Long enough to read as a monitor changing channel, short enough never to be waited on. */
const STATIC_MS = 260;
/** The noise is drawn this small and stretched, which is both cheaper and closer to the coarse grain of an analogue tube. */
const GRAIN_W = 192;
const GRAIN_H = 120;

/** A burst of analogue snow over the whole screen whenever `channel` changes, the way a control-room monitor switched between cameras. It never takes a click, never runs on the first render, and never runs for a viewer who asked for less motion. */
export function ChannelStatic({ channel }: { channel: string }): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The channel last shown. Compared rather than counted, so a development double render of the first view is not taken for a change. */
  const shown = useRef(channel);

  useEffect(() => {
    if (shown.current === channel) return;
    shown.current = channel;
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context || prefersReducedMotion()) return;
    element.width = GRAIN_W;
    element.height = GRAIN_H;
    const image = context.createImageData(GRAIN_W, GRAIN_H);
    const pixels = new Uint32Array(image.data.buffer);
    const start = performance.now();
    let frame = 0;
    const draw = (now: number): void => {
      const t = (now - start) / STATIC_MS;
      if (t >= 1) {
        element.style.opacity = '0';
        frame = 0;
        return;
      }
      // Amber-grey grain, with a few rolling dark bands, fading out as the new picture settles.
      const band = Math.floor(now / 16) % GRAIN_H;
      for (let y = 0; y < GRAIN_H; y++) {
        const dark = Math.abs(y - band) < 6 || Math.abs(y - ((band + GRAIN_H / 2) % GRAIN_H)) < 3 ? 0.45 : 1;
        for (let x = 0; x < GRAIN_W; x++) {
          const v = Math.random() * 255 * dark;
          // Little-endian RGBA: alpha in the top byte.
          pixels[y * GRAIN_W + x] = (255 << 24) | ((v * 0.55) << 16) | ((v * 0.8) << 8) | v;
        }
      }
      context.putImageData(image, 0, 0);
      element.style.opacity = (0.55 * (1 - t) ** 1.4).toFixed(3);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      element.style.opacity = '0';
    };
  }, [channel]);

  return <canvas ref={canvas} className="channel-static" aria-hidden="true" />;
}
