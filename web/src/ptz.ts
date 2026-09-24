/** Digital pan, tilt and zoom over a media element. These are public read-only feeds, so nothing here talks to the camera: it transforms what has already arrived, which is why the transform has to sit on a wrapper holding both the video and the replay still rather than on the video alone. */

const MIN_SCALE = 1;
const MAX_SCALE = 8;
// Above this the source pixels are large enough that smoothing turns them to mush, so nearest-neighbour reads better than an upscale blur. Wisconsin publishes 352x240, which reaches that point quickly.
const PIXELATE_AT = 2.2;

export class Ptz {
  private scale = 1;
  /** Intrinsic aspect of what is playing. The media is fitted, not cropped, so the picture is usually smaller than the stage and the pan limits have to be computed from the picture rather than from the box. */
  private sourceAspect: number | null = null;
  private x = 0;
  private y = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private frame = 0;

  /** `viewport` takes the gestures and clips, `target` is the wrapper that gets transformed, `readout` shows the factor. */
  constructor(
    private readonly viewport: HTMLElement,
    private readonly target: HTMLElement,
    private readonly readout: HTMLElement,
  ) {
    viewport.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    viewport.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    viewport.addEventListener('pointermove', (event) => this.onPointerMove(event));
    viewport.addEventListener('pointerup', (event) => this.onPointerUp(event));
    viewport.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    // Dragging across an <img> otherwise starts a native image drag, which fires pointercancel and silently ends the pan after the first move.
    viewport.addEventListener('dragstart', (event) => event.preventDefault());
    viewport.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.reset();
    });
    this.apply();
  }

  /** Cancels a queued transform write. The listeners live on the viewport element and go with it. */
  destroy(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  get factor(): number {
    return this.scale;
  }

  /** Called when the video or the still reports its intrinsic size. Changing source re-clamps, because a 352x240 picture leaves far more slack in a wide stage than a 720x480 one. */
  setSourceAspect(aspect: number | null): void {
    if (aspect !== null && (!Number.isFinite(aspect) || aspect <= 0)) return;
    if (aspect === this.sourceAspect) return;
    this.sourceAspect = aspect;
    this.apply();
  }

  reset(): void {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.apply();
  }

  /** Size of the rendered picture inside the stage at 1x, which is what `object-fit: contain` produces. */
  private pictureSize(boxW: number, boxH: number): [number, number] {
    const aspect = this.sourceAspect;
    if (aspect === null || boxW === 0 || boxH === 0) return [boxW, boxH];
    return aspect > boxW / boxH ? [boxW, boxW / aspect] : [boxH * aspect, boxH];
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = this.viewport.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Cursor position relative to the centre, which is where the transform origin sits.
    const px = event.clientX - rect.left - rect.width / 2;
    const py = event.clientY - rect.top - rect.height / 2;
    const next = clamp(this.scale * Math.exp(-event.deltaY * 0.0016), MIN_SCALE, MAX_SCALE);
    if (next === this.scale) return;
    // Keep whatever is under the cursor under the cursor.
    const k = next / this.scale;
    this.x = px - (px - this.x) * k;
    this.y = py - (py - this.y) * k;
    this.scale = next;
    this.apply();
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.scale <= MIN_SCALE) return;
    event.preventDefault();
    this.dragging = true;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    capture(this.viewport, event.pointerId);
    this.viewport.classList.add('is-panning');
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.dragging) return;
    this.x += event.clientX - this.lastX;
    this.y += event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.apply();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    release(this.viewport, event.pointerId);
    this.viewport.classList.remove('is-panning');
  }

  /** Writes the transform on the next frame, so a burst of wheel or move events costs one style recalculation rather than one each. */
  private apply(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const rect = this.viewport.getBoundingClientRect();
      // The picture is letterboxed inside the stage (object-fit: contain), so the slack is half of however much the scaled picture overhangs the box, which is zero along the letterboxed axis until the zoom has filled it.
      const [pictureW, pictureH] = this.pictureSize(rect.width, rect.height);
      const maxX = Math.max(0, (pictureW * this.scale - rect.width) / 2);
      const maxY = Math.max(0, (pictureH * this.scale - rect.height) / 2);
      this.x = clamp(this.x, -maxX, maxX);
      this.y = clamp(this.y, -maxY, maxY);
      this.target.style.transform = `translate(${this.x.toFixed(2)}px, ${this.y.toFixed(2)}px) scale(${this.scale.toFixed(4)})`;
      this.target.classList.toggle('is-magnified', this.scale >= PIXELATE_AT);
      const zoomed = this.scale > MIN_SCALE + 0.001;
      this.viewport.classList.toggle('is-zoomed', zoomed);
      this.readout.textContent = zoomed ? `${this.scale.toFixed(1)}x` : '';
    });
  }
}

/** Capturing a pointer that is no longer active throws, and a throw here would leave the drag half-started. */
export function capture(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Nothing to capture; the drag still tracks through the element's own move events.
  }
}

export function release(element: HTMLElement, pointerId: number): void {
  try {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // Already released.
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
