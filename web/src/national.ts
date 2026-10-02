import type { Box } from './albers';
import { capture, release } from './ptz';
import { ACROSS, ALONG, explode, type SlabLayout } from './slabs';
import { MONO, PHOSPHOR, rgba, type Rgb } from './retro';
import type { CameraState, NationalRegion, NationalResponse, PulsePoint, SkyRegion } from './api';
import { prefersReducedMotion } from './motion';

const MAX_ZOOM_FACTOR = 26;
const HIT_RADIUS_PX = 18;
/** Screen size of a density cell at country zoom. Small enough to show a corridor, large enough that a metro does not turn into a solid block. */
const CELL_PX = 5;
/** How thick a slab is, in screen pixels, and how much higher a hovered one floats. */
const SLAB_DEPTH_PX = 9;
const HOVER_LIFT_PX = 12;
/** Past this much zoom the cells are finer than the cameras are spaced, so individual positions are drawn instead. */
const DOTS_FROM = 7;
const PULSE_MS = 2600;
/** How long the flight into a city takes. */
const ZOOM_MS = 900;

interface View {
  cx: number;
  cy: number;
  scale: number;
  fitted: boolean;
}

interface Marker {
  region: NationalRegion;
  /** The slab the city sits on, which it floats with. */
  slab: number;
  x: number;
  y: number;
  /** Polled cameras reporting frames, which only a served region has. */
  live: number;
  activity: number;
  /** Cameras the national index holds inside this region's box, which is what a configured-but-unserved region has instead. */
  indexed: number;
  /** The sky as this city's cameras see it, for the sunset wave. Null until the server has a recent picture from there. */
  sky: SkyRegion | null;
}

/** The sunset wave's color for a median camera brightness. Cameras expose for the scene, so daylight sits around 0.45 and a lit night street around 0.15, and the ramp spans that rather than 0..1. */
function skyColor(brightness: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (brightness - 0.15) / 0.3));
  const stops: Rgb[] = [[120, 38, 16], PHOSPHOR.mid, PHOSPHOR.hot];
  const scaled = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const [a, b] = [stops[i]!, stops[i + 1]!];
  return [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * f)) as [number, number, number];
}

/** One short phrase for a city's sky: the sun's angle, the cameras' own brightness, and the murk hint when it is up. */
function skyPhrase(sky: SkyRegion): string {
  const sun = sky.sun_elevation > 0 ? `sun ${Math.round(sky.sun_elevation)}°` : sky.sun_elevation > -6 ? 'twilight' : 'night';
  const light = sky.brightness === null ? '' : ` · cameras ${Math.round(sky.brightness * 100)}% bright`;
  const murk = sky.weather === 'snow' ? ` · snow, ${sky.snow_white} of ${sky.snow_known} cameras white` : sky.weather === 'murky' ? ` · murky, ${sky.contrast_low} of ${sky.contrast_known} flat` : '';
  return `${sun}${light}${murk}`;
}

/** The country view: the states this install can see, floating in a row on a tilted table, with their cameras as lights and the polled regions as markers.
 *
 * Two stacked canvases. The base holds the slabs and the lights and is redrawn only when the view, the data or a slab's height changes; the overlay holds the region markers and their pulse and is cheap enough to redraw every frame. */
export class NationalView {
  readonly root: HTMLElement;
  private readonly host: HTMLElement;
  private readonly base: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly tip: HTMLElement;
  private readonly list: HTMLElement;
  private readonly credit: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();

  private readonly layout: SlabLayout;
  private readonly tops: Path2D[];
  /** How much higher than its resting float each slab is right now, easing toward `liftTarget`. */
  private readonly lift: number[];
  private readonly liftTarget: number[];
  private liftFrame = 0;
  private hoveredSlab = -1;
  private readonly hitCtx: CanvasRenderingContext2D | null = document.createElement('canvas').getContext('2d');
  private readonly markers: Marker[] = [];

  private view: View | null = null;
  private zooming = false;
  private zoomFrame = 0;
  private width = 0;
  private height = 0;
  private frame = 0;
  private resizeFrame = 0;
  private pulseFrame = 0;
  private readonly observer: ResizeObserver;
  private dragging = false;
  private dragMoved = false;
  private lastX = 0;
  private lastY = 0;
  private hovered: Marker | null = null;

  constructor(
    private readonly data: NationalResponse,
    private readonly onRegion: (key: string) => void,
  ) {
    this.root = document.createElement('section');
    this.root.className = 'national';

    this.host = document.createElement('div');
    this.host.className = 'national-host';
    this.base = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'national-overlay';
    const baseCtx = this.base.getContext('2d');
    const overlayCtx = this.overlay.getContext('2d');
    if (!baseCtx || !overlayCtx) throw new Error('canvas 2d context is unavailable');
    this.baseCtx = baseCtx;
    this.overlayCtx = overlayCtx;

    this.tip = document.createElement('div');
    // Same styling as the region map's tooltip, with its own class so a selector cannot pick up the wrong view's.
    this.tip.className = 'map-tip national-tip';
    this.tip.hidden = true;
    this.credit = document.createElement('div');
    this.credit.className = 'map-credit';
    this.list = document.createElement('aside');
    this.list.className = 'national-list';

    // Zooming into the empty table between the slabs leaves a viewer looking at nothing with no obvious way back. Double-click re-fits, but nothing on screen says so.
    const fitButton = document.createElement('button');
    fitButton.type = 'button';
    fitButton.className = 'map-region national-fit';
    fitButton.textContent = 'Fit';
    fitButton.title = 'Frame the whole country (double-click the map does the same)';
    fitButton.addEventListener('click', () => this.fit(true));

    // The legend. Without it amber reads as "dense" rather than "live".
    const legend = document.createElement('div');
    legend.className = 'map-legend national-legend';
    for (const [cls, text] of [
      ['is-ramp', 'cameras'],
      ['is-live', 'polled now'],
      ['is-configured', 'configured'],
      ['is-sky-day', 'sky: day'],
      ['is-sky-dusk', 'dusk'],
      ['is-sky-night', 'night'],
      ['is-snow', 'snow'],
    ] as [string, string][]) {
      const item = document.createElement('span');
      item.className = 'map-legend-item';
      const swatch = document.createElement('i');
      swatch.className = cls;
      item.append(swatch, document.createTextNode(text));
      legend.appendChild(item);
    }

    this.host.append(this.base, this.overlay, fitButton, legend, this.tip);
    const frame = document.createElement('div');
    frame.className = 'national-frame';
    frame.append(this.host, this.credit);
    this.root.append(frame, this.list);

    // Everything is laid out once: the slabs are static, so every frame after this is one affine transform and a height per slab.
    this.layout = explode(data);
    this.tops = this.layout.slabs.map((slab) => {
      const path = new Path2D();
      for (const ring of slab.rings) {
        ring.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
        path.closePath();
      }
      return path;
    });
    this.lift = this.layout.slabs.map(() => 0);
    this.liftTarget = this.layout.slabs.map(() => 0);
    const total = this.layout.camX.length;
    this.buildMarkers();
    this.buildList(total);
    this.credit.textContent = `${data.attribution} · ${total.toLocaleString()} cameras indexed`;

    this.observer = new ResizeObserver(() => {
      if (this.resizeFrame !== 0) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = 0;
        this.resize();
      });
    });
    this.observer.observe(this.host);

    this.overlay.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.overlay.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.overlay.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.overlay.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.overlay.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    this.overlay.addEventListener('pointerleave', () => this.setHover(null, 0, 0));
    this.overlay.addEventListener('dblclick', () => this.fit(true));
  }

  /** Stops the pulse loop and releases the observer. The pulse re-arms itself every frame, so without this a double mount leaves a second loop running. */
  destroy(): void {
    this.observer.disconnect();
    for (const frame of [this.frame, this.resizeFrame, this.pulseFrame, this.zoomFrame, this.liftFrame]) if (frame !== 0) cancelAnimationFrame(frame);
    this.frame = 0;
    this.resizeFrame = 0;
    this.pulseFrame = 0;
    this.liftFrame = 0;
    this.root.remove();
  }

  private buildMarkers(): void {
    for (const region of this.data.regions) {
      const source = this.data.sources[region.source];
      const center = region.center ?? centreOfBox(region.bbox);
      if (!center) continue;
      // A city's name ends with its state, which names its slab; a name that does not is looked up by position.
      const code = region.name.split(', ').pop() ?? '';
      let slab = this.layout.slabs.findIndex((item) => item.code === code);
      if (slab === -1) slab = this.layout.slabOf(center[1], center[0]);
      if (slab === -1) continue;
      const at = this.layout.place(center[1], center[0], this.layout.slabs[slab]!.code);
      if (!at) continue;
      this.markers.push({ region, slab, x: at[0], y: at[1], live: 0, activity: 0, indexed: this.countInBox(region, source), sky: null });
    }
  }

  /** How many cataloged cameras fall inside a region's box, shown for a configured-but-unserved region in place of its polled count of zero. */
  private countInBox(region: NationalRegion, source: NationalResponse['sources'][string] | undefined): number {
    if (!source || !region.bbox) return 0;
    const [south, west, north, east] = region.bbox;
    const { lat, lon } = source.cameras;
    let n = 0;
    for (let i = 0; i < lat.length; i++) {
      const la = lat[i] as number;
      const lo = lon[i] as number;
      if (la >= south && la <= north && lo >= west && lo <= east) n++;
    }
    return n;
  }

  private buildList(totalCameras: number): void {
    const served = this.data.regions.filter((r) => r.served).length;
    const summary = document.createElement('div');
    summary.className = 'national-summary';
    // Most of what this view draws is catalog, not coverage.
    summary.innerHTML = `<b>${served} of ${this.data.regions.length}</b> regions polled in this run<br>${totalCameras.toLocaleString()} cameras indexed across ${this.data.covered_states.length} states<br><span class="national-summary-note">Only the states with cameras, lifted out and set west to east, sizes eased toward each other.</span>`;
    this.list.appendChild(summary);

    // Grouped by state, alphabetically, so many cities read as a handful of states rather than one long column.
    // The state's name comes from the outlines this map already draws, keyed by the two letters a city's name ends with.
    const stateOf = (marker: Marker): string => {
      const code = marker.region.name.split(', ').pop() ?? '';
      return this.data.states[code]?.name ?? code;
    };
    const ordered = [...this.markers].sort((a, b) => stateOf(a).localeCompare(stateOf(b)) || a.region.name.localeCompare(b.region.name));
    let heading = '';
    for (const marker of ordered) {
      const { region } = marker;
      const state = stateOf(marker);
      if (state !== heading) {
        heading = state;
        const count = ordered.filter((item) => stateOf(item) === state).length;
        const title = document.createElement('h3');
        title.className = 'national-state';
        title.textContent = `${state} · ${String(count)} ${count === 1 ? 'city' : 'cities'}`;
        this.list.appendChild(title);
      }
      const row = document.createElement('div');
      row.className = `national-row${region.served ? ' is-served' : ''}`;
      row.dataset.region = region.key;

      const name = document.createElement('button');
      name.type = 'button';
      name.disabled = !region.served;
      name.addEventListener('click', () => this.enter(region.key));
      name.className = 'national-row-name';
      name.textContent = region.name;

      const status = document.createElement('span');
      status.className = 'national-row-status';
      status.textContent = region.served ? 'Live' : region.built ? 'Configured' : 'Unbuilt';

      const detail = document.createElement('span');
      detail.className = 'national-row-detail';
      const source = this.data.sources[region.source];
      if (source) {
        const link = document.createElement('a');
        link.className = 'source-link';
        link.textContent = source.name;
        link.href = source.site_url;
        link.target = '_blank';
        link.rel = 'noopener';
        detail.appendChild(link);
      } else {
        detail.appendChild(document.createTextNode(region.source));
      }
      const counts = document.createElement('span');
      counts.className = 'national-row-counts';
      counts.textContent = region.served ? ` · ${region.cameras} polled` : ` · ${marker.indexed} in index, not polled`;
      detail.appendChild(counts);
      const sky = document.createElement('span');
      sky.className = 'national-row-sky';
      detail.appendChild(sky);
      // The city's pulse through the day, drawn by setPulse.
      const pulse = document.createElement('canvas');
      pulse.className = 'national-row-pulse';
      pulse.width = 240;
      pulse.height = 36;
      pulse.hidden = true;

      row.append(name, status, detail, pulse);
      row.addEventListener('pointerenter', () => {
        this.hovered = marker;
        this.drawOverlay();
      });
      row.addEventListener('pointerleave', () => {
        this.hovered = null;
        this.drawOverlay();
      });
      this.list.appendChild(row);
      this.rows.set(region.key, row);
    }
  }

  /** Live per-camera state, which only exists for served regions. It drives how hot a live marker reads. */
  setStates(states: CameraState[]): void {
    const live = new Map<string, { frames: number; activity: number; n: number }>();
    for (const state of states) {
      const key = state.region;
      if (key === undefined) continue;
      const bucket = live.get(key) ?? { frames: 0, activity: 0, n: 0 };
      if (state.frames > 0) bucket.frames++;
      if (state.activity !== null) {
        bucket.activity += state.activity;
        bucket.n++;
      }
      live.set(key, bucket);
    }
    for (const marker of this.markers) {
      const bucket = live.get(marker.region.key);
      marker.live = bucket?.frames ?? 0;
      marker.activity = bucket && bucket.n > 0 ? bucket.activity / bucket.n : 0;
      const row = this.rows.get(marker.region.key);
      if (row && marker.region.served) {
        const detail = row.querySelector('.national-row-counts');
        if (detail) {
          detail.textContent = ` · ${marker.region.cameras} polled · ${marker.live} with frames`;
        }
      }
    }
    this.drawOverlay();
  }

  /** The sky over each served city, from `/api/sky`. It paints a halo behind each marker, so the evening reads as a wave of color moving west. */
  setSky(regions: SkyRegion[]): void {
    const byKey = new Map(regions.map((region) => [region.key, region]));
    for (const marker of this.markers) {
      const sky = byKey.get(marker.region.key) ?? null;
      marker.sky = sky && sky.cameras > 0 ? sky : null;
      const text = this.rows.get(marker.region.key)?.querySelector('.national-row-sky');
      if (text) text.textContent = marker.sky ? ` · ${skyPhrase(marker.sky)}` : '';
    }
    this.drawOverlay();
  }

  /** Each city's movement through the day as a small line in its row, scaled to the city's own busiest minute so a quiet city's rush hour shows as clearly as a big one's. Gaps are left where the city had no pictures. */
  setPulse(regions: Record<string, PulsePoint[]>, now = Date.now() / 1000): void {
    const midnight = new Date(now * 1000);
    midnight.setHours(0, 0, 0, 0);
    const start = midnight.getTime() / 1000;
    for (const [key, row] of this.rows) {
      const canvas = row.querySelector('canvas.national-row-pulse') as HTMLCanvasElement | null;
      if (!canvas) continue;
      const points = (regions[key] ?? []).filter((p) => p.ts >= start);
      canvas.hidden = points.length < 2;
      if (canvas.hidden) continue;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      const peak = Math.max(...points.map((p) => p.diff)) || 1;
      const x = (ts: number): number => ((ts - start) / 86400) * width;
      const y = (diff: number): number => height - 3 - (diff / peak) * (height - 6);
      // Six-hour marks, so the morning and evening can be found at a glance.
      ctx.fillStyle = rgba(PHOSPHOR.dim, 0.3);
      for (let h = 6; h < 24; h += 6) ctx.fillRect(Math.round((h / 24) * width), 0, 1, height);
      ctx.strokeStyle = rgba(PHOSPHOR.bright, 0.9);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      points.forEach((p, i) => {
        // A gap of more than ten minutes is a break in the line, not a slope across it.
        const gap = i > 0 && p.ts - points[i - 1]!.ts > 600;
        if (i === 0 || gap) ctx.moveTo(x(p.ts), y(p.diff));
        else ctx.lineTo(x(p.ts), y(p.diff));
      });
      ctx.stroke();
      ctx.fillStyle = rgba(PHOSPHOR.hot, 0.85);
      ctx.fillRect(Math.round(x(now)), 0, 1, height);
      canvas.title = `Movement through the day, ${points.length} minutes recorded`;
    }
  }

  /** Called when the view becomes visible: a canvas sized while its container was hidden comes back as zero by zero. */
  resize(): void {
    const rect = this.host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = rect.width;
    this.height = rect.height;
    for (const canvas of [this.base, this.overlay]) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
    if (this.view === null || this.view.fitted) this.fit(true);
    this.invalidate();
  }

  /** The layout's extent with room around it for the slabs' thickness and float, which are in screen pixels and so cannot be part of the world box. */
  private bounds(): Box {
    const { minX, minY, maxX, maxY } = this.layout.bounds;
    const padX = (maxX - minX) * 0.03;
    const padY = (maxY - minY) * 0.12;
    return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
  }

  private fit(hard = false): void {
    if (this.width === 0) return;
    if (this.view !== null && !hard) return;
    const { minX, minY, maxX, maxY } = this.bounds();
    this.view = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale: this.fitScale(), fitted: true };
    this.invalidate();
  }

  private fitScale(): number {
    const { minX, minY, maxX, maxY } = this.bounds();
    return Math.min(this.width / Math.max(1e-9, maxX - minX), this.height / Math.max(1e-9, maxY - minY)) * 0.94;
  }

  private toScreen(x: number, y: number): [number, number] {
    const view = this.view as View;
    return [(x - view.cx) * view.scale + this.width / 2, (y - view.cy) * view.scale + this.height / 2];
  }

  /** How far above the table a slab's top face is drawn, in screen pixels. */
  private raised(slab: number): number {
    return (this.layout.slabs[slab]?.float ?? 0) + (this.lift[slab] ?? 0);
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const view = this.view;
    if (!view) return;
    const rect = this.overlay.getBoundingClientRect();
    const px = event.clientX - rect.left - this.width / 2;
    const py = event.clientY - rect.top - this.height / 2;
    const base = this.fitScale();
    const next = clamp(view.scale * Math.exp(-event.deltaY * 0.0016), base, base * MAX_ZOOM_FACTOR);
    if (next === view.scale) return;
    view.cx += px / view.scale - px / next;
    view.cy += py / view.scale - py / next;
    view.scale = next;
    view.fitted = false;
    this.clampView();
    this.invalidate();
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.dragging = true;
    this.dragMoved = false;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    capture(this.overlay, event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    const view = this.view;
    if (!view) return;
    if (!this.dragging) {
      const over = this.hit(event);
      const slab = over ? over.slab : this.hitSlab(event);
      this.overlay.style.cursor = over?.region.served ? 'pointer' : slab !== -1 ? 'zoom-in' : 'grab';
      this.setHover(over, event.clientX, event.clientY);
      this.setHoveredSlab(slab);
      return;
    }
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    view.cx -= dx / view.scale;
    view.cy -= dy / view.scale;
    view.fitted = false;
    this.clampView();
    this.overlay.style.cursor = 'grabbing';
    this.invalidate();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    release(this.overlay, event.pointerId);
    this.overlay.style.cursor = 'grab';
    if (this.dragMoved) return;
    const target = this.hit(event);
    if (target?.region.served) {
      this.enter(target.region.key);
      return;
    }
    // A click on a slab away from its cities brings that state up to fill the view.
    const slab = this.hitSlab(event);
    if (slab !== -1) this.flyTo(this.layout.slabs[slab]!.box);
  }

  private hit(event: { clientX: number; clientY: number }): Marker | null {
    if (!this.view) return null;
    const rect = this.overlay.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best: Marker | null = null;
    let bestDist = HIT_RADIUS_PX;
    for (const marker of this.markers) {
      const [sx, sy] = this.toScreen(marker.x, marker.y);
      const d = Math.hypot(sx - px, sy - this.raised(marker.slab) - py);
      if (d < bestDist) {
        bestDist = d;
        best = marker;
      }
    }
    return best;
  }

  /** The slab whose top face is under the pointer, frontmost first, or -1. */
  private hitSlab(event: { clientX: number; clientY: number }): number {
    const view = this.view;
    if (!view || !this.hitCtx) return -1;
    const rect = this.overlay.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    for (const i of this.drawOrder().reverse()) {
      const wx = (px - this.width / 2) / view.scale + view.cx;
      const wy = (py + this.raised(i) - this.height / 2) / view.scale + view.cy;
      if (this.hitCtx.isPointInPath(this.tops[i]!, wx, wy)) return i;
    }
    return -1;
  }

  private setHoveredSlab(slab: number): void {
    if (slab === this.hoveredSlab) return;
    this.hoveredSlab = slab;
    this.liftTarget.forEach((_, i) => (this.liftTarget[i] = i === slab ? HOVER_LIFT_PX : 0));
    if (prefersReducedMotion()) {
      this.liftTarget.forEach((value, i) => (this.lift[i] = value));
      this.invalidate();
      return;
    }
    this.animateLift();
  }

  /** Eases each slab toward its target height, redrawing until they all arrive. */
  private animateLift(): void {
    if (this.liftFrame !== 0) return;
    const step = (): void => {
      let moving = false;
      this.lift.forEach((value, i) => {
        const target = this.liftTarget[i]!;
        const next = value + (target - value) * 0.22;
        this.lift[i] = Math.abs(target - next) < 0.2 ? target : next;
        if (this.lift[i] !== target) moving = true;
      });
      this.draw();
      this.drawOverlay();
      this.liftFrame = moving ? requestAnimationFrame(step) : 0;
    };
    this.liftFrame = requestAnimationFrame(step);
  }

  private setHover(marker: Marker | null, clientX: number, clientY: number): void {
    if (marker) {
      const rect = this.host.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const region = marker.region;
      this.tip.textContent = region.served
        ? `${region.name} · ${region.cameras} cameras polled${marker.sky ? ` · ${skyPhrase(marker.sky)}` : ''}`
        : `${region.name} · configured, not polled in this run`;
      this.tip.hidden = false;
      this.tip.style.left = `${Math.min(x + 14, rect.width - this.tip.offsetWidth - 10)}px`;
      this.tip.style.top = `${Math.max(8, y - this.tip.offsetHeight - 12)}px`;
    } else if (!this.tip.hidden) {
      this.tip.hidden = true;
    }
    if (marker === this.hovered) return;
    this.hovered = marker;
    for (const [key, row] of this.rows) row.classList.toggle('is-hovered', marker?.region.key === key);
    this.drawOverlay();
  }

  private clampView(): void {
    const view = this.view;
    if (!view) return;
    const { minX, minY, maxX, maxY } = this.bounds();
    view.cx = clamp(view.cx, minX, maxX);
    view.cy = clamp(view.cy, minY, maxY);
  }

  /** Glides the view onto a box, the scale changing geometrically so the zoom feels even. */
  private flyTo(box: Box): void {
    const view = this.view;
    if (!view || this.zooming) return;
    const pad = 1.35;
    const scale = clamp(Math.min(this.width / ((box.maxX - box.minX) * pad), this.height / ((box.maxY - box.minY) * pad * 1.4)), this.fitScale(), this.fitScale() * MAX_ZOOM_FACTOR);
    const to = { cx: (box.minX + box.maxX) / 2, cy: (box.minY + box.maxY) / 2, scale };
    if (prefersReducedMotion()) {
      Object.assign(view, to, { fitted: false });
      this.invalidate();
      return;
    }
    const from = { cx: view.cx, cy: view.cy, scale: view.scale };
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ZOOM_MS);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      view.scale = from.scale * (to.scale / from.scale) ** eased;
      view.cx = from.cx + (to.cx - from.cx) * eased;
      view.cy = from.cy + (to.cy - from.cy) * eased;
      view.fitted = false;
      this.draw();
      this.drawOverlay();
      this.zoomFrame = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.zoomFrame = requestAnimationFrame(step);
  }

  /** Flies into a city, then hands over to it. The country fades in the last stretch so the city map, fading in behind it, takes over rather than replacing it. Without motion, or with no view yet, it hands over at once. */
  private enter(key: string): void {
    if (this.zooming) return;
    const marker = this.markers.find((item) => item.region.key === key);
    const view = this.view;
    if (!marker || !view || prefersReducedMotion()) {
      this.onRegion(key);
      return;
    }
    this.zooming = true;
    const from = { cx: view.cx, cy: view.cy, scale: view.scale };
    const to = Math.max(from.scale * 6, this.fitScale() * 9);
    const start = performance.now();
    this.root.classList.add('is-zooming');
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ZOOM_MS);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      view.scale = from.scale * (to / from.scale) ** eased;
      view.cx = from.cx + (marker.x - from.cx) * eased;
      view.cy = from.cy + (marker.y - from.cy) * eased;
      view.fitted = false;
      this.draw();
      this.drawOverlay();
      if (t > 0.72) this.root.classList.add('is-leaving');
      if (t < 1) {
        this.zoomFrame = requestAnimationFrame(step);
        return;
      }
      this.zoomFrame = 0;
      this.onRegion(key);
      // Back to the whole country, out of sight, so the map is ready when the viewer returns to it.
      window.setTimeout(() => {
        this.zooming = false;
        this.root.classList.remove('is-zooming', 'is-leaving');
        this.setHoveredSlab(-1);
        this.fit(true);
      }, 400);
    };
    this.zoomFrame = requestAnimationFrame(step);
  }

  private invalidate(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
      this.drawOverlay();
    });
  }

  /** Back to front: the slab nearest the top of the screen is the farthest away on the table. */
  private drawOrder(): number[] {
    return this.layout.slabs.map((_, i) => i).sort((a, b) => this.layout.slabs[a]!.box.maxY - this.layout.slabs[b]!.box.maxY);
  }

  private draw(): void {
    const ctx = this.baseCtx;
    const view = this.view;
    const dpr = this.base.width / Math.max(1, this.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    if (!view || this.width === 0) return;

    const world = (lift: number): void =>
      ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * (this.width / 2 - view.cx * view.scale), dpr * (this.height / 2 - view.cy * view.scale - lift));
    ctx.lineJoin = 'round';

    // The table: a faint grid in the same tilt as the slabs, so they read as floating over something.
    this.drawTable(ctx, view, dpr);

    const order = this.drawOrder();
    for (const i of order) {
      const top = this.tops[i]!;
      const up = this.raised(i);
      const hovered = i === this.hoveredSlab;

      // Its shadow on the table, softer the higher it floats.
      world(-SLAB_DEPTH_PX);
      ctx.filter = `blur(${(4 + up * 0.5).toFixed(1)}px)`;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fill(top);
      ctx.filter = 'none';

      // The sides: the top face stacked downwards a pixel at a time, which on a tilted table is exactly what the edge of a slab looks like.
      ctx.fillStyle = rgba(PHOSPHOR.deep, 1);
      for (let k = SLAB_DEPTH_PX; k > 0; k -= 1) {
        world(up - k);
        ctx.fill(top);
      }
      world(up - SLAB_DEPTH_PX);
      ctx.strokeStyle = rgba(PHOSPHOR.dim, 0.35);
      ctx.lineWidth = 0.8 / view.scale;
      ctx.stroke(top);

      world(up);
      ctx.fillStyle = hovered ? 'rgba(34, 22, 8, 1)' : 'rgba(22, 14, 5, 1)';
      ctx.fill(top);
      ctx.strokeStyle = rgba(PHOSPHOR.bright, hovered ? 0.95 : 0.6);
      ctx.lineWidth = (hovered ? 1.4 : 1) / view.scale;
      ctx.stroke(top);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawDensity(ctx, view);
    this.drawSlabLabels(ctx);
  }

  /** A grid on the table below the slabs, drawn in world units along the same tilt, so it turns and zooms with them. */
  private drawTable(ctx: CanvasRenderingContext2D, view: View, dpr: number): void {
    const { minX, minY, maxX, maxY } = this.bounds();
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const reach = (maxX - minX) * 0.8;
    const step = (maxX - minX) / 30;
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * (this.width / 2 - view.cx * view.scale), dpr * (this.height / 2 - view.cy * view.scale));
    ctx.strokeStyle = rgba(PHOSPHOR.dim, 0.1);
    ctx.lineWidth = 1 / view.scale;
    ctx.beginPath();
    for (const [a, b] of [
      [ALONG, ACROSS],
      [ACROSS, ALONG],
    ] as const) {
      for (let k = -30; k <= 30; k++) {
        const ox = cx + b[0] * k * step;
        const oy = cy + b[1] * k * step;
        ctx.moveTo(ox - a[0] * reach, oy - a[1] * reach);
        ctx.lineTo(ox + a[0] * reach, oy + a[1] * reach);
      }
    }
    ctx.stroke();
  }

  /** The lights: cameras binned into screen cells, each glowing by how many landed in it. Zoomed in past the point where a cell is finer than the cameras are spaced, the same data is drawn as individual lights. */
  private drawDensity(ctx: CanvasRenderingContext2D, view: View): void {
    const zoom = view.scale / this.fitScale();
    const { camX, camY, camSlab } = this.layout;
    const n = camX.length;
    const raised = this.layout.slabs.map((_, i) => this.raised(i));
    ctx.globalCompositeOperation = 'lighter';

    if (zoom >= DOTS_FROM) {
      ctx.fillStyle = rgba(PHOSPHOR.bright, 0.8);
      const radius = Math.min(2.6, 0.7 + zoom * 0.08);
      for (let i = 0; i < n; i++) {
        const slab = camSlab[i] as number;
        if (slab < 0) continue;
        const [sx, sy0] = this.toScreen(camX[i] as number, camY[i] as number);
        const sy = sy0 - raised[slab]!;
        if (sx < -4 || sy < -4 || sx > this.width + 4 || sy > this.height + 4) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      return;
    }

    const cell = CELL_PX;
    const cols = Math.ceil(this.width / cell) + 1;
    const counts = new Map<number, number>();
    let peak = 1;
    for (let i = 0; i < n; i++) {
      const slab = camSlab[i] as number;
      if (slab < 0) continue;
      const [sx, sy0] = this.toScreen(camX[i] as number, camY[i] as number);
      const sy = sy0 - raised[slab]!;
      if (sx < 0 || sy < 0 || sx > this.width || sy > this.height) continue;
      const key = ((sy / cell) | 0) * cols + ((sx / cell) | 0);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next > peak) peak = next;
    }
    const denominator = Math.log(1 + Math.min(peak, 24));
    for (const [key, count] of counts) {
      const t = Math.min(1, Math.log(1 + count) / denominator);
      // Polled cities are marked by their rings on the overlay, not by color, so dense never reads as live.
      const r = Math.round(PHOSPHOR.dim[0] + (PHOSPHOR.hot[0] - PHOSPHOR.dim[0]) * t);
      const g = Math.round(PHOSPHOR.dim[1] + (PHOSPHOR.hot[1] - PHOSPHOR.dim[1]) * t);
      const b = Math.round(PHOSPHOR.dim[2] + (PHOSPHOR.hot[2] - PHOSPHOR.dim[2]) * t);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(0.35 + t * 0.6).toFixed(3)})`;
      const cx = (key % cols) * cell + cell / 2;
      const cy = ((key / cols) | 0) * cell + cell / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 0.9 + t * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Each slab's name and camera count, hung off its front edge like a label on a monitor. */
  private drawSlabLabels(ctx: CanvasRenderingContext2D): void {
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'center';
    for (const i of this.drawOrder()) {
      const slab = this.layout.slabs[i]!;
      const [sx, sy] = this.toScreen(slab.center[0], slab.box.maxY);
      if (sx < -200 || sy < -40 || sx > this.width + 200 || sy > this.height + 60) continue;
      const hovered = i === this.hoveredSlab;
      const y = sy - this.raised(i) + SLAB_DEPTH_PX + 16;
      ctx.fillStyle = rgba(PHOSPHOR.bright, hovered ? 1 : 0.72);
      ctx.fillText(slab.name.toUpperCase(), sx, y);
      ctx.fillStyle = rgba(PHOSPHOR.dim, hovered ? 1 : 0.85);
      ctx.fillText(`${slab.cameras.toLocaleString()} CAM`, sx, y + 12);
    }
    ctx.textAlign = 'start';
  }

  /** Markers and their pulse. Cheap: a few dozen regions, redrawn on an animation frame while a live one is on screen. */
  private drawOverlay(): void {
    const ctx = this.overlayCtx;
    const view = this.view;
    const dpr = this.overlay.width / Math.max(1, this.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!view || this.width === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const phase = (Date.now() % PULSE_MS) / PULSE_MS;
    let animating = false;
    const zoom = view.scale / this.fitScale();

    for (const marker of this.markers) {
      const [sx, sy0] = this.toScreen(marker.x, marker.y);
      const sy = sy0 - this.raised(marker.slab);
      const served = marker.region.served;
      const hovered = this.hovered === marker;
      const radius = served ? 3.5 + marker.activity * 2 : 2.5;

      if (served && !prefersReducedMotion()) {
        animating = true;
        // One slow ring, not a strobe: this is meant to be left running on a screen. Flattened like the table it lies on.
        const grow = radius + 3 + phase * 14;
        ctx.beginPath();
        ctx.ellipse(sx, sy, grow, grow * 0.55, 0, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(PHOSPHOR.bright, 0.5 * (1 - phase));
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // The sunset wave: a soft halo in the color of the city's sky, behind the marker.
      if (marker.sky?.brightness != null) {
        const [r, g, b] = skyColor(marker.sky.brightness);
        const halo = ctx.createRadialGradient(sx, sy, radius, sx, sy, radius + 14);
        halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.6)`);
        halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 14, 0, Math.PI * 2);
        ctx.fillStyle = halo;
        ctx.fill();
      }
      if (marker.sky?.weather === 'snow') {
        // Snow is a solid pale ring, where murk is a dashed dim one.
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 8, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(PHOSPHOR.hot, 0.95);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (marker.sky?.weather === 'murky') {
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 8, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(PHOSPHOR.dim, 0.9);
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.arc(sx, sy, radius + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = rgba(PHOSPHOR.ink, 0.85);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      if (served) {
        ctx.fillStyle = rgba(PHOSPHOR.hot, 0.98);
        ctx.fill();
      } else {
        // Configured but not polled: an outline, deliberately not filled, so "present" never looks like "live".
        ctx.strokeStyle = rgba(PHOSPHOR.dim, 0.9);
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (hovered) {
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 6, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(PHOSPHOR.hot, 0.9);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Names only once there is room for them, or on the slab under the pointer, so the row is not buried in labels.
      if (!hovered && zoom < 1.8 && marker.slab !== this.hoveredSlab) continue;
      const label = marker.region.name.toUpperCase();
      ctx.font = `10px ${MONO}`;
      const width = ctx.measureText(label).width;
      const lx = sx + radius + 7;
      ctx.fillStyle = rgba(PHOSPHOR.ink, 0.8);
      ctx.fillRect(lx - 3, sy - 7, width + 6, 14);
      ctx.fillStyle = served ? rgba(PHOSPHOR.hot, 0.95) : rgba(PHOSPHOR.dim, 1);
      ctx.fillText(label, lx, sy + 3.5);
    }

    if (!animating) {
      this.pulseFrame = 0;
      return;
    }
    if (this.pulseFrame !== 0) return;
    this.pulseFrame = requestAnimationFrame(() => {
      this.pulseFrame = 0;
      this.drawOverlay();
    });
  }
}

function centreOfBox(bbox: [number, number, number, number] | null): [number, number] | null {
  if (!bbox) return null;
  const [south, west, north, east] = bbox;
  return [(south + north) / 2, (west + east) / 2];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
