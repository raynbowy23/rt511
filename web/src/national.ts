import { AlbersUsa, groupForState, groupForStates, type Box, type ProjGroup } from './albers';
import { latOfLonLat, lonOfLonLat, type LonLat } from '@rt511/shared';
import { capture, release } from './ptz';
import type { CameraState, NationalRegion, NationalResponse, PulsePoint, SkyRegion } from './api';
import { prefersReducedMotion } from './motion';

const MAX_ZOOM_FACTOR = 26;
const HIT_RADIUS_PX = 18;
/** Screen size of a density cell at country zoom. Small enough to show a corridor, large enough that 19,327 cameras do not turn the east coast into a solid block. */
const CELL_PX = 6;
/** Past this much zoom the cells are finer than the cameras are spaced, so individual positions are drawn instead. */
const DOTS_FROM = 7;
const PULSE_MS = 2600;

interface View {
  cx: number;
  cy: number;
  scale: number;
  fitted: boolean;
}

interface Marker {
  region: NationalRegion;
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

/** The sunset wave's colour for a median camera brightness. Cameras expose for the scene, so daylight sits around 0.45 and a lit night street around 0.15; the ramp spans that rather than 0..1, and runs from night blue through a dusk amber to a pale day gold. */
function skyColour(brightness: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (brightness - 0.15) / 0.3));
  const stops: [number, number, number][] = [
    [34, 48, 110],
    [226, 118, 70],
    [246, 222, 150],
  ];
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

/** The country view: where cameras exist at all, which states this install can see, and which regions are being polled right now.
 *
 * Two stacked canvases. The base holds the states and the density layer and is redrawn only when the view or the data changes; the overlay holds the region markers and their pulse and is cheap enough to redraw every frame. Nineteen thousand points binned per frame would not survive a 60 Hz pulse. */
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

  private readonly projection: AlbersUsa;
  private readonly covered: Path2D;
  private readonly plain: Path2D;
  private readonly insetFrames: { label: string; box: Box }[];
  private readonly camX: Float64Array;
  private readonly camY: Float64Array;
  private readonly markers: Marker[] = [];

  private view: View | null = null;
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

    // Zooming into an ocean, or into the empty band beside the insets, leaves a viewer looking at nothing with no obvious way back. Double-click re-fits, but nothing on screen says so.
    const fitButton = document.createElement('button');
    fitButton.type = 'button';
    fitButton.className = 'map-region national-fit';
    fitButton.textContent = 'Fit';
    fitButton.title = 'Frame the whole country (double-click the map does the same)';
    fitButton.addEventListener('click', () => this.fit(true));

    // What the colours mean: the density ramp for the catalogue, and the two marker states. Without it amber reads as "dense" rather than "live".
    const legend = document.createElement('div');
    legend.className = 'map-legend national-legend';
    for (const [cls, text] of [
      ['is-ramp', 'cameras indexed'],
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

    // Outlines and camera positions are projected once: the composite is static, so every frame after this is one affine transform.
    const byGroup: Record<ProjGroup, LonLat[]> = { conus: [], alaska: [], hawaii: [] };
    for (const [code, state] of Object.entries(data.states)) {
      const group = groupForState(code);
      for (const ring of state.polygons) for (const point of ring) byGroup[group].push(point);
    }
    this.projection = new AlbersUsa(byGroup);

    const coveredSet = new Set(data.covered_states);
    this.covered = new Path2D();
    this.plain = new Path2D();
    for (const [code, state] of Object.entries(data.states)) {
      const group = groupForState(code);
      const target = coveredSet.has(code) ? this.covered : this.plain;
      for (const ring of state.polygons) {
        // GeoJSON order here: longitude first. The branded type is what makes drawing a graph edge on this path a compile error.
        ring.forEach((point, i) => {
          const [x, y] = this.projection.project(lonOfLonLat(point), latOfLonLat(point), group);
          if (i === 0) target.moveTo(x, y);
          else target.lineTo(x, y);
        });
        target.closePath();
      }
    }
    this.insetFrames = this.projection.insets.map(({ label, box }) => ({ label, box }));

    let total = 0;
    for (const source of Object.values(data.sources)) total += source.cameras.ids.length;
    this.camX = new Float64Array(total);
    this.camY = new Float64Array(total);
    let at = 0;
    for (const source of Object.values(data.sources)) {
      const group = groupForStates(source.states);
      const { lat, lon } = source.cameras;
      for (let i = 0; i < lat.length; i++) {
        const [x, y] = this.projection.project(lon[i] as number, lat[i] as number, group);
        this.camX[at] = x;
        this.camY[at] = y;
        at++;
      }
    }

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

  /** Stops the pulse loop and releases the observer. The pulse re-arms itself every frame, so without this a double mount would leave a second loop redrawing an orphaned canvas forever. */
  destroy(): void {
    this.observer.disconnect();
    for (const frame of [this.frame, this.resizeFrame, this.pulseFrame]) if (frame !== 0) cancelAnimationFrame(frame);
    this.frame = 0;
    this.resizeFrame = 0;
    this.pulseFrame = 0;
    this.root.remove();
  }

  private buildMarkers(): void {
    for (const region of this.data.regions) {
      const source = this.data.sources[region.source];
      const group = source ? groupForStates(source.states) : 'conus';
      const centre = region.center ?? centreOfBox(region.bbox);
      if (!centre) continue;
      const [x, y] = this.projection.project(centre[1], centre[0], group);
      this.markers.push({ region, x, y, live: 0, activity: 0, indexed: this.countInBox(region, source), sky: null });
    }
  }

  /** How many catalogued cameras fall inside a region's box. It is what a configured-but-unserved region can honestly show in place of a polled count, which the backend reports as zero. */
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
    // The honest headline: most of what this view draws is catalogue, not coverage.
    summary.innerHTML = `<b>${served} of ${this.data.regions.length}</b> regions polled in this run<br>${totalCameras.toLocaleString()} cameras indexed across ${this.data.covered_states.length} states`;
    this.list.appendChild(summary);

    for (const marker of this.markers) {
      const { region } = marker;
      const row = document.createElement('div');
      row.className = `national-row${region.served ? ' is-served' : ''}`;
      row.dataset.region = region.key;

      const name = document.createElement('button');
      name.type = 'button';
      name.disabled = !region.served;
      name.addEventListener('click', () => this.onRegion(region.key));
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

  /** The sky over each served city, from `/api/sky`. It paints a halo behind each marker, so the evening reads as a wave of colour moving west. */
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

  /** Each city's movement through the day, as a small line in its row: midnight at the left, the next midnight at the right, the line scaled to the city's own busiest minute so a quiet city's rush hour shows as clearly as a big one's. Gaps are left where the city had no pictures. */
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
      ctx.fillStyle = 'rgba(150, 165, 185, 0.18)';
      for (let h = 6; h < 24; h += 6) ctx.fillRect(Math.round((h / 24) * width), 0, 1, height);
      ctx.strokeStyle = 'rgba(226, 178, 104, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      points.forEach((p, i) => {
        // A gap of more than ten minutes is a break in the line, not a slope across it.
        const gap = i > 0 && p.ts - points[i - 1]!.ts > 600;
        if (i === 0 || gap) ctx.moveTo(x(p.ts), y(p.diff));
        else ctx.lineTo(x(p.ts), y(p.diff));
      });
      ctx.stroke();
      ctx.fillStyle = 'rgba(236, 240, 246, 0.8)';
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

  private fit(hard = false): void {
    if (this.width === 0) return;
    if (this.view !== null && !hard) return;
    const { minX, minY, maxX, maxY } = this.projection.bounds;
    const scale = Math.min(this.width / Math.max(1e-9, maxX - minX), this.height / Math.max(1e-9, maxY - minY)) * 0.94;
    this.view = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale, fitted: true };
    this.invalidate();
  }

  private fitScale(): number {
    const { minX, minY, maxX, maxY } = this.projection.bounds;
    return Math.min(this.width / Math.max(1e-9, maxX - minX), this.height / Math.max(1e-9, maxY - minY)) * 0.94;
  }

  private toScreen(x: number, y: number): [number, number] {
    const view = this.view as View;
    return [(x - view.cx) * view.scale + this.width / 2, (y - view.cy) * view.scale + this.height / 2];
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
      this.overlay.style.cursor = over?.region.served ? 'pointer' : 'grab';
      this.setHover(over, event.clientX, event.clientY);
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
    if (target?.region.served) this.onRegion(target.region.key);
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
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestDist) {
        bestDist = d;
        best = marker;
      }
    }
    return best;
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
    const { minX, minY, maxX, maxY } = this.projection.bounds;
    view.cx = clamp(view.cx, minX, maxX);
    view.cy = clamp(view.cy, minY, maxY);
  }

  private invalidate(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
      this.drawOverlay();
    });
  }

  private draw(): void {
    const ctx = this.baseCtx;
    const view = this.view;
    const dpr = this.base.width / Math.max(1, this.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    if (!view || this.width === 0) return;

    ctx.setTransform(
      dpr * view.scale,
      0,
      0,
      dpr * view.scale,
      dpr * (this.width / 2 - view.cx * view.scale),
      dpr * (this.height / 2 - view.cy * view.scale),
    );
    ctx.lineJoin = 'round';

    // States this install has no source for are outline only; the seventeen it can see are filled, so the covered footprint reads before anything else does.
    ctx.fillStyle = 'rgba(24, 32, 43, 0.9)';
    ctx.fill(this.plain);
    ctx.strokeStyle = 'rgba(120, 140, 165, 0.22)';
    ctx.lineWidth = 0.9 / view.scale;
    ctx.stroke(this.plain);

    ctx.fillStyle = 'rgba(48, 70, 95, 0.95)';
    ctx.fill(this.covered);
    ctx.strokeStyle = 'rgba(160, 194, 230, 0.62)';
    ctx.lineWidth = 1.1 / view.scale;
    ctx.stroke(this.covered);

    for (const { box } of this.insetFrames) {
      ctx.strokeStyle = 'rgba(120, 140, 165, 0.18)';
      ctx.lineWidth = 0.8 / view.scale;
      ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawDensity(ctx, view);
    this.drawInsetLabels(ctx);
  }

  /** The density layer. Individual dots at 19,327 points say nothing at country scale, so cameras are binned into screen cells and coloured by how many landed in each: the corridors and metros are the signal. Zoomed in past the point where a cell is finer than the cameras are spaced, the same data is drawn as individual positions. */
  private drawDensity(ctx: CanvasRenderingContext2D, view: View): void {
    const zoom = view.scale / this.fitScale();
    const n = this.camX.length;

    if (zoom >= DOTS_FROM) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.75)';
      const radius = Math.min(2.6, 0.7 + zoom * 0.08);
      for (let i = 0; i < n; i++) {
        const [sx, sy] = this.toScreen(this.camX[i] as number, this.camY[i] as number);
        if (sx < -4 || sy < -4 || sx > this.width + 4 || sy > this.height + 4) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    const cell = CELL_PX;
    const cols = Math.ceil(this.width / cell) + 1;
    const counts = new Map<number, number>();
    let peak = 1;
    for (let i = 0; i < n; i++) {
      const [sx, sy] = this.toScreen(this.camX[i] as number, this.camY[i] as number);
      if (sx < 0 || sy < 0 || sx > this.width || sy > this.height) continue;
      const key = ((sy / cell) | 0) * cols + ((sx / cell) | 0);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next > peak) peak = next;
    }
    const denominator = Math.log(1 + Math.min(peak, 24));
    for (const [key, count] of counts) {
      const t = Math.min(1, Math.log(1 + count) / denominator);
      // Sparse is a dim steel blue, dense is near white. The ramp deliberately never reaches amber: amber on this map means a region is being polled right now, and a density scale that also went amber would make "lots of cameras" look like "live".
      const r = Math.round(104 + (233 - 104) * t);
      const g = Math.round(136 + (241 - 136) * t);
      const b = Math.round(178 + (252 - 178) * t);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(0.3 + t * 0.62).toFixed(3)})`;
      const cx = (key % cols) * cell;
      const cy = ((key / cols) | 0) * cell;
      const size = cell - 1 + t * 1.6;
      ctx.fillRect(cx, cy, size, size);
    }
  }

  private drawInsetLabels(ctx: CanvasRenderingContext2D): void {
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(150, 165, 185, 0.6)';
    for (const { label, box } of this.insetFrames) {
      const [sx, sy] = this.toScreen(box.minX, box.maxY);
      if (sx < -200 || sy < -40 || sx > this.width + 200 || sy > this.height + 40) continue;
      ctx.fillText(label.toUpperCase(), sx + 2, sy + 12);
    }
  }

  /** Markers and their pulse. Cheap: four regions, redrawn on an animation frame while a live one is on screen. */
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

    for (const marker of this.markers) {
      const [sx, sy] = this.toScreen(marker.x, marker.y);
      const served = marker.region.served;
      const hovered = this.hovered === marker;
      const radius = served ? 5.5 + marker.activity * 2.5 : 4;

      if (served && !prefersReducedMotion()) {
        animating = true;
        // One slow ring, not a strobe: this is meant to be left running on a screen.
        const grow = radius + 4 + phase * 16;
        ctx.beginPath();
        ctx.arc(sx, sy, grow, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(226, 178, 104, ${(0.42 * (1 - phase)).toFixed(3)})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // The sunset wave: a soft halo in the colour of the city's sky, behind everything else the marker draws.
      if (marker.sky?.brightness != null) {
        const [r, g, b] = skyColour(marker.sky.brightness);
        const halo = ctx.createRadialGradient(sx, sy, radius, sx, sy, radius + 16);
        halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.7)`);
        halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 16, 0, Math.PI * 2);
        ctx.fillStyle = halo;
        ctx.fill();
      }
      if (marker.sky?.weather === 'snow') {
        // Snow is a solid white ring, where murk is a dashed grey one.
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(245, 248, 255, 0.95)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (marker.sky?.weather === 'murky') {
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(190, 200, 212, 0.8)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.arc(sx, sy, radius + 3.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(5, 6, 8, 0.8)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      if (served) {
        ctx.fillStyle = 'rgba(226, 178, 104, 0.95)';
        ctx.fill();
      } else {
        // Configured but not polled: an outline, deliberately not filled, so "present" never looks like "live".
        ctx.fillStyle = 'rgba(150, 183, 219, 0.14)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(150, 183, 219, 0.75)';
        ctx.lineWidth = 1.3;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (hovered) {
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 7, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(236, 240, 246, 0.85)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      const label = marker.region.name.toUpperCase();
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      const width = ctx.measureText(label).width;
      const lx = sx + radius + 8;
      ctx.fillStyle = 'rgba(5, 6, 8, 0.72)';
      ctx.fillRect(lx - 4, sy - 7, width + 8, 15);
      ctx.fillStyle = served ? 'rgba(236, 240, 246, 0.92)' : 'rgba(180, 196, 214, 0.72)';
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
