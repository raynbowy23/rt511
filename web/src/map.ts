import { capture, release } from './ptz';
import { getRoads, ROAD_CLASSES, type Camera, type CameraState, type EdgeKind, type Graph, type Incident, type RoadClass, type Site } from './api';
import { latOf, lonOf, type LatLon } from '@rt511/shared';
import { measure, pointAt, roadPath, type AttentionFlow, type FlowReason, type Link } from './flows';
import { prefersReducedMotion } from './motion';

/** Road colors and stroke weights, dimmed so the camera graph sits on top of them rather than competing. Weight is held in screen pixels so a motorway stays a motorway at every zoom. */
const ROAD_STYLE: Record<RoadClass, { color: string; width: number }> = {
  motorway: { color: '#4a3414', width: 3 },
  motorway_link: { color: '#3e2c12', width: 1.5 },
  trunk: { color: '#433013', width: 2.2 },
  trunk_link: { color: '#382810', width: 1.2 },
  primary: { color: '#3a2a12', width: 1.8 },
  primary_link: { color: '#30230f', width: 1 },
  secondary: { color: '#30240f', width: 1.4 },
  secondary_link: { color: '#2a1f0d', width: 1 },
  tertiary: { color: '#271c0c', width: 1 },
  tertiary_link: { color: '#22190b', width: 0.8 },
  unclassified: { color: '#1f170a', width: 0.8 },
};

/** Edge colors by kind, in the one phosphor at different strengths, so the kinds can be told apart at a glance. Nearby edges join sites you cannot drive between and have zero length, so they are dashed and drawn last. */
const EDGE_STYLE: Record<EdgeKind, { width: number; color: string; alpha: number; dash?: [number, number] }> = {
  freeway: { width: 4, color: '#ffb43c', alpha: 0.9 },
  street: { width: 2.5, color: '#b87a28', alpha: 0.85 },
  ramp: { width: 2, color: '#ffe0a0', alpha: 0.85 },
  nearby: { width: 2.2, color: '#8a5a22', alpha: 0.7, dash: [4, 6] },
};

const EDGE_KINDS: EdgeKind[] = ['street', 'ramp', 'freeway', 'nearby'];
/** The color of attention by what set it moving, as RGB for mixing with an alpha. */
const FLOW_COLOR: Record<FlowReason, string> = { incident: '255, 84, 60', still: '255, 138, 30', movement: '255, 230, 180' };
/** How fast a pulse travels along the road on screen. */
const FLOW_SPEED_PX = 70;

/** A site is colored by what it sits on and burns towards the phosphor's hottest as its camera gets busy. */
const NODE_FREEWAY = [255, 180, 60] as const;
const NODE_STREET = [184, 122, 40] as const;
const NODE_HOT = [255, 232, 176] as const;

/** Background color behind a node's halo. Matching the canvas background is what separates a dot from the line it sits on. */
const MAP_BG = '#080603';

/** Activity at which a node starts warming towards amber, matching the wall's threshold for a hot tile. */
const HOT_FROM = 0.6;

/** How far the map turns per pixel dragged with Ctrl held. */
const ORBIT_RADIANS_PER_PX = 0.006;
/** Tilt stops here. Beyond about 60 degrees a flat map squashes into an unreadable band. */
const MAX_PITCH = 1.05;
const HIT_RADIUS_PX = 14;
/** Incident markers are drawn larger than camera nodes and take a larger target, since they sit on top of them. */
const INCIDENT_HIT_PX = 18;
const INCIDENT_COLOR = '#ff543c';
// Twenty-four times the framing zoom puts a couple of kilometers across the view, which is as deep as this data rewards: past that there is nothing but empty space between the ways.
const MAX_ZOOM_FACTOR = 24;

const regionOf = (siteId: string): string => {
  const cut = siteId.indexOf(':');
  return cut === -1 ? '' : siteId.slice(0, cut);
};

interface MapSite {
  site: Site;
  x: number;
  y: number;
  /** What the hover label says: the camera's location text, or the site id for a site the poller does not serve. */
  label: string;
  /** Cameras at this site that the backend is actually polling, and so the only click targets. The poller serves frames, streams and snapshots for these and 404s the rest. */
  live: number[];
}

interface View {
  cx: number;
  cy: number;
  scale: number;
  /** Rotation of the map, in radians, clockwise. Ctrl and drag sideways. */
  bearing: number;
  /** Tilt away from straight down, in radians. Ctrl and drag up or down. The map is drawn flat and squashed vertically, which reads as an oblique view. */
  pitch: number;
  /** True until the view is panned or zoomed. A still-framed map re-frames itself when the pane is resized; one the viewer has moved is left alone. */
  fitted: boolean;
}

interface IncidentEdge {
  kind: EdgeKind;
  /** Graph geometry, latitude first. The branded type stops a GeoJSON ring from being drawn here by mistake. */
  points: LatLon[];
}

interface RegionLayer {
  key: string;
  /** Longitude is compressed by the cosine of the region's own latitude, so a region is drawn in its own local projection rather than one shared across 1500 km. */
  kx: number;
  sites: MapSite[];
  edges: Map<EdgeKind, Path2D>;
  /** Edge geometry per site, so selecting a node can restroke just its own edges on top of the bulk paths. */
  incident: Map<string, IncidentEdge[]>;
  roads: Map<RoadClass, Path2D>;
  /** Every road link from each site, in both directions, for finding the road between two cameras. */
  links: Map<string, Link[]>;
  siteOf: Map<number, string>;
  roadsLoaded: boolean;
  /** Everything drawn, roads included. Panning is clamped to this. */
  bounds: Bounds;
  /** Only the camera sites, for the initial framing: the road query covers a bbox far wider than the cameras. */
  siteBounds: Bounds;
  view: View | null;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The map view: roads and the camera graph on one canvas.
 *
 * Canvas rather than SVG because a region is thousands of ways, and one DOM node per way makes panning crawl. No tiles and no external requests: the road geometry comes from the backend. */
export class MapView {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly host: HTMLElement;
  private readonly note: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly credit: HTMLElement;

  private readonly layers = new Map<string, RegionLayer>();
  private states = new Map<number, CameraState>();
  private current: RegionLayer | null = null;
  private activeSite: string | null = null;
  /** What the state patrol is responding to in this city right now, drawn over the graph. */
  private incidents: Incident[] = [];
  private activeIncident: string | null = null;
  private hoveredIncident: Incident | null = null;
  private activeEdges: Map<EdgeKind, Path2D> | null = null;
  private hovered: MapSite | null = null;
  private pending = 0;
  private dragging = false;
  /** True while Ctrl is held on a drag, which rotates and tilts instead of panning. */
  private orbiting = false;
  private dragMoved = false;
  private lastX = 0;
  private lastY = 0;
  private width = 0;
  private height = 0;
  private frame = 0;
  private resizeFrame = 0;
  private readonly observer: ResizeObserver;
  /** A second canvas for attention spreading along the roads, redrawn every frame while there is something to show, which the map's thousands of cached road paths could not afford. */
  private readonly fx: HTMLCanvasElement;
  private readonly fxCtx: CanvasRenderingContext2D;
  private readonly flowNote: HTMLElement;
  private flows: { layer: string; points: LatLon[]; reason: FlowReason; strength: number }[] = [];
  private fxFrame = 0;
  private readonly still = prefersReducedMotion();

  constructor(
    graph: Graph,
    private readonly onSelect: (siteId: string, cameraId: number) => void,
    private readonly onIncident: (id: string) => void = () => undefined,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'map';

    this.host = document.createElement('div');
    this.host.className = 'map-host';
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context is unavailable');
    this.ctx = ctx;

    this.note = document.createElement('div');
    this.note.className = 'map-note';
    this.tip = document.createElement('div');
    this.tip.className = 'map-tip';
    this.tip.hidden = true;
    this.legend = document.createElement('div');
    this.legend.className = 'map-legend';
    for (const kind of ['freeway', 'street', 'ramp', 'nearby'] as EdgeKind[]) {
      const chip = document.createElement('span');
      chip.className = 'map-legend-item';
      const swatch = document.createElement('i');
      swatch.style.background = EDGE_STYLE[kind].color;
      if (kind === 'nearby') swatch.classList.add('is-dashed');
      chip.append(swatch, document.createTextNode(kind));
      this.legend.appendChild(chip);
    }
    this.credit = document.createElement('div');
    this.credit.className = 'map-credit';

    this.fx = document.createElement('canvas');
    this.fx.className = 'map-fx';
    const fxCtx = this.fx.getContext('2d');
    if (!fxCtx) throw new Error('canvas 2d context is unavailable');
    this.fxCtx = fxCtx;
    this.flowNote = document.createElement('div');
    this.flowNote.className = 'map-flow-note';
    this.flowNote.hidden = true;
    this.flowNote.innerHTML = '<b>Attention spreading.</b> A camera that sees something makes the cameras along its road worth watching: <i class="is-incident"></i> an incident, <i class="is-still"></i> stopped traffic, <i class="is-movement"></i> unusual movement.';
    this.host.append(this.canvas, this.fx, this.legend, this.note, this.tip, this.flowNote);
    this.root.append(this.host, this.credit);

    this.build(graph);

    // The splitter resizes this pane continuously, so the observer is coalesced onto a frame exactly as panning is.
    this.observer = new ResizeObserver(() => {
      if (this.resizeFrame !== 0) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = 0;
        this.resize();
      });
    });
    this.observer.observe(this.host);
    this.canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('dblclick', () => this.fit(true));
    this.canvas.addEventListener('pointerleave', () => {
      this.setHoverIncident(null, 0, 0);
      this.setHover(null, 0, 0);
    });
  }

  /** Releases the observer, any queued frame and the root. React's development mode mounts effects twice, so a view that cannot be torn down leaves an orphan behind. */
  destroy(): void {
    this.observer.disconnect();
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    if (this.resizeFrame !== 0) cancelAnimationFrame(this.resizeFrame);
    if (this.fxFrame !== 0) cancelAnimationFrame(this.fxFrame);
    this.fxFrame = 0;
    this.frame = 0;
    this.resizeFrame = 0;
    this.pending++;
    this.root.remove();
  }

  private build(graph: Graph): void {
    const camerasBySite = new Map<string, Camera[]>();
    for (const camera of graph.cameras) {
      // An unplaced camera has no site to belong to, so it contributes no label here.
      if (camera.site === null) continue;
      const bucket = camerasBySite.get(camera.site);
      if (bucket) bucket.push(camera);
      else camerasBySite.set(camera.site, [camera]);
    }

    const sitesByRegion = new Map<string, Site[]>();
    for (const site of graph.sites) {
      const key = regionOf(site.id);
      const bucket = sitesByRegion.get(key);
      if (bucket) bucket.push(site);
      else sitesByRegion.set(key, [site]);
    }

    for (const [key, sites] of sitesByRegion) {
      const lat0 = sites.reduce((a, s) => a + s.lat, 0) / Math.max(1, sites.length);
      const kx = Math.cos((lat0 * Math.PI) / 180);
      const layer: RegionLayer = {
        key,
        kx,
        sites: [],
        edges: new Map(),
        incident: new Map(),
        roads: new Map(),
        links: new Map(),
        siteOf: new Map(),
        roadsLoaded: false,
        bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        siteBounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        view: null,
      };
      for (const site of sites) {
        const x = site.lon * kx;
        const y = -site.lat;
        const label = camerasBySite.get(site.id)?.[0]?.location ?? site.id;
        layer.sites.push({ site, x, y, label, live: [] });
        for (const camera of site.cameras) layer.siteOf.set(camera, site.id);
        grow(layer.bounds, x, y);
        grow(layer.siteBounds, x, y);
      }
      this.layers.set(key, layer);
    }

    for (const edge of graph.edges) {
      if (edge.geometry.length < 2) continue;
      const key = regionOf(edge.src);
      if (key !== regionOf(edge.dst)) continue;
      const layer = this.layers.get(key);
      if (!layer) continue;
      const path = layer.edges.get(edge.kind) ?? new Path2D();
      appendWay(path, edge.geometry, layer.kx, layer.bounds);
      layer.edges.set(edge.kind, path);
      const incident: IncidentEdge = { kind: edge.kind, points: edge.geometry };
      pushInto(layer.incident, edge.src, incident);
      pushInto(layer.incident, edge.dst, incident);
      pushInto(layer.links, edge.src, { to: edge.dst, points: edge.geometry });
      pushInto(layer.links, edge.dst, { to: edge.src, points: [...edge.geometry].reverse() });
    }
  }

  /** Switches to a region, fetching its road geometry the first time it is shown. Roads are requested one region at a time because all of them together run to megabytes. */
  async show(key: string): Promise<void> {
    const layer = this.layers.get(key);
    if (!layer || this.current === layer) return;
    this.current = layer;
    if (layer.view === null) this.fit();
    this.invalidate();
    if (layer.roadsLoaded) return;

    this.note.textContent = 'loading roads';
    const token = ++this.pending;
    const res = await getRoads(key);
    if (token !== this.pending) return;
    if (!res) {
      this.note.textContent = 'road geometry unavailable';
      return;
    }
    const roads = res.regions[key]?.roads ?? {};
    let ways = 0;
    for (const cls of ROAD_CLASSES) {
      const list = roads[cls];
      if (!list || list.length === 0) continue;
      const path = new Path2D();
      for (const way of list) appendWay(path, way, layer.kx, layer.bounds);
      layer.roads.set(cls, path);
      ways += list.length;
    }
    layer.roadsLoaded = true;
    this.credit.textContent = res.attribution;
    this.note.textContent = `${ways.toLocaleString()} ways`;
    window.setTimeout(() => {
      if (this.note.textContent === `${ways.toLocaleString()} ways`) this.note.textContent = '';
    }, 4000);
    this.invalidate();
  }

  get region(): string | null {
    return this.current?.key ?? null;
  }

  setStates(states: Map<number, CameraState>): void {
    this.states = states;
    for (const layer of this.layers.values()) {
      for (const entry of layer.sites) {
        entry.live = entry.site.cameras.filter((id) => states.has(id));
      }
    }
    this.invalidate();
  }

  setIncidents(incidents: Incident[]): void {
    this.incidents = incidents;
    this.invalidate();
  }

  setActiveIncident(id: string | null): void {
    this.activeIncident = id;
    this.invalidate();
  }

  setActive(siteId: string | null): void {
    this.activeSite = siteId;
    this.activeEdges = null;
    if (siteId !== null) {
      void this.show(regionOf(siteId));
      const layer = this.layers.get(regionOf(siteId));
      const incident = layer?.incident.get(siteId);
      if (layer && incident) {
        // Restroking only the selected site's edges on top of the bulk paths is what makes a selection read as "this node and what it connects to".
        const paths = new Map<EdgeKind, Path2D>();
        for (const edge of incident) {
          const path = paths.get(edge.kind) ?? new Path2D();
          appendWay(path, edge.points, layer.kx, layer.bounds);
          paths.set(edge.kind, path);
        }
        this.activeEdges = paths;
      }
    }
    this.invalidate();
  }

  /** Called when the map becomes visible: a canvas sized while its container was display:none comes back as zero by zero. */
  resize(): void {
    const rect = this.host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.fx.width = this.canvas.width;
    this.fx.height = this.canvas.height;
    // A map that was hidden while flows arrived starts moving again once it has a size.
    this.animate();
    if (this.current?.view?.fitted) this.fit(true);
    else if (this.current && this.current.view === null) this.fit();
    this.invalidate();
  }

  /** Frames the whole region. `hard` re-fits a region that already has a view, which is what a double-click asks for. */
  private fit(hard = false): void {
    const layer = this.current;
    if (!layer || this.width === 0) return;
    if (layer.view !== null && !hard) return;
    const { minX, minY, maxX, maxY } = layer.siteBounds;
    const w = Math.max(1e-6, maxX - minX);
    const h = Math.max(1e-6, maxY - minY);
    const scale = Math.min(this.width / w, this.height / h) * 0.92;
    layer.view = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale, bearing: 0, pitch: 0, fitted: true };
    this.invalidate();
  }

  private fitScale(layer: RegionLayer): number {
    const w = Math.max(1e-6, layer.siteBounds.maxX - layer.siteBounds.minX);
    const h = Math.max(1e-6, layer.siteBounds.maxY - layer.siteBounds.minY);
    return Math.min(this.width / w, this.height / h) * 0.92;
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const layer = this.current;
    if (!layer?.view) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const view = layer.view;
    const base = this.fitScale(layer);
    const next = clamp(view.scale * Math.exp(-event.deltaY * 0.0016), base, base * MAX_ZOOM_FACTOR);
    if (next === view.scale) return;
    // Hold the point under the cursor still while the scale changes, through the full inverse because a rotated map's screen axes are not the world axes.
    const [wx, wy] = this.toWorld(view, px, py);
    view.scale = next;
    const [ax, ay] = this.toWorld(view, px, py);
    view.cx += wx - ax;
    view.cy += wy - ay;
    view.fitted = false;
    this.clampView(layer);
    this.invalidate();
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.dragging = true;
    this.orbiting = event.ctrlKey || event.metaKey;
    this.dragMoved = false;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    capture(this.canvas, event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    const layer = this.current;
    if (!layer?.view) return;
    if (!this.dragging) {
      const incident = this.hitIncident(event);
      const over = incident ? null : this.hit(event);
      this.canvas.style.cursor = incident || over ? 'pointer' : 'grab';
      this.setHoverIncident(incident, event.clientX, event.clientY);
      this.setHover(over, event.clientX, event.clientY);
      return;
    }
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    const view = layer.view;

    if (this.orbiting) {
      // Sideways spins the map, up and down tilts it. Pitch stops short of the horizon, where a flat map drawn in perspective degenerates into a line.
      // Both axes follow the map, not the cursor: dragging down lays it back and dragging left turns it left.
      view.bearing = (view.bearing - dx * ORBIT_RADIANS_PER_PX) % (Math.PI * 2);
      view.pitch = clamp(view.pitch - dy * ORBIT_RADIANS_PER_PX, 0, MAX_PITCH);
      view.fitted = false;
      this.canvas.style.cursor = 'grabbing';
      this.invalidate();
      return;
    }

    // Panning is a screen-space drag, so the movement is taken back through the inverse; with the map rotated, moving the mouse right is not moving the world east.
    const [wx, wy] = this.toWorld(view, 0, 0);
    const [ax, ay] = this.toWorld(view, dx, dy);
    view.cx -= ax - wx;
    view.cy -= ay - wy;
    view.fitted = false;
    this.clampView(layer);
    this.canvas.style.cursor = 'grabbing';
    this.invalidate();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    release(this.canvas, event.pointerId);
    this.canvas.style.cursor = 'grab';
    this.setHover(this.hit(event), event.clientX, event.clientY);
    // A drag that moved is a pan, not a click on whatever happened to be under the finger when it stopped.
    if (this.dragMoved) return;
    const incident = this.hitIncident(event);
    if (incident) {
      this.onIncident(incident.id);
      return;
    }
    const target = this.hit(event);
    const cameraId = target?.live[0];
    if (target && cameraId !== undefined) this.onSelect(target.site.id, cameraId);
  }

  /** Hovering an incident names it. */
  private setHoverIncident(incident: Incident | null, clientX: number, clientY: number): void {
    if (incident) {
      const rect = this.host.getBoundingClientRect();
      this.tip.textContent = `${incident.type} · ${incident.location}`;
      this.tip.hidden = false;
      this.tip.style.left = `${Math.min(clientX - rect.left + 14, rect.width - this.tip.offsetWidth - 10)}px`;
      this.tip.style.top = `${Math.max(8, clientY - rect.top - this.tip.offsetHeight - 12)}px`;
    }
    if (incident?.id === this.hoveredIncident?.id) return;
    this.hoveredIncident = incident;
    this.invalidate();
  }

  /** Hovering a node names it, which is the difference between a dot and something you know you can click. */
  private setHover(entry: MapSite | null, clientX: number, clientY: number): void {
    // An incident under the pointer owns the tip; clearing it here would erase what the incident hover just wrote.
    if (!entry && this.hoveredIncident) {
      if (entry !== this.hovered) {
        this.hovered = entry;
        this.invalidate();
      }
      return;
    }
    if (entry) {
      const rect = this.host.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      this.tip.textContent = entry.label;
      this.tip.hidden = false;
      // Flip the label over the cursor near the right edge so it never runs off the pane.
      this.tip.style.left = `${Math.min(x + 14, rect.width - this.tip.offsetWidth - 10)}px`;
      this.tip.style.top = `${Math.max(8, y - this.tip.offsetHeight - 12)}px`;
    } else if (!this.tip.hidden) {
      this.tip.hidden = true;
    }
    if (entry === this.hovered) return;
    this.hovered = entry;
    this.invalidate();
  }

  /** The nearest selectable site within a finger's width, in screen pixels. */
  /** The incident under the pointer, if any. Checked before camera nodes: the marker is drawn over them, so it has to answer for the pixels it covers. */
  private hitIncident(event: { clientX: number; clientY: number }): Incident | null {
    const layer = this.current;
    if (!layer?.view || this.incidents.length === 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best: Incident | null = null;
    let bestDist = INCIDENT_HIT_PX;
    for (const incident of this.incidents) {
      const [sx, sy] = this.toScreen(layer.view, incident.lon * layer.kx, -incident.lat);
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestDist) {
        bestDist = d;
        best = incident;
      }
    }
    return best;
  }

  private hit(event: { clientX: number; clientY: number }): MapSite | null {
    const layer = this.current;
    if (!layer?.view) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best: MapSite | null = null;
    let bestDist = HIT_RADIUS_PX;
    for (const entry of layer.sites) {
      if (entry.live.length === 0) continue;
      const [sx, sy] = this.toScreen(layer.view, entry.x, entry.y);
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestDist) {
        bestDist = d;
        best = entry;
      }
    }
    return best;
  }

  /** World to screen as the six numbers a canvas transform takes. Rotation turns the world about the view center; pitch squashes it vertically afterwards, so a tilted map keeps its horizon horizontal. */
  private matrix(view: View): [number, number, number, number, number, number] {
    const cos = Math.cos(view.bearing);
    const sin = Math.sin(view.bearing);
    const k = Math.cos(view.pitch);
    const a = view.scale * cos;
    const b = view.scale * k * sin;
    const c = -view.scale * sin;
    const d = view.scale * k * cos;
    return [a, b, c, d, this.width / 2 - (a * view.cx + c * view.cy), this.height / 2 - (b * view.cx + d * view.cy)];
  }

  private toScreen(view: View, x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.matrix(view);
    return [a * x + c * y + e, b * x + d * y + f];
  }

  /** The inverse of the same matrix, for panning and zooming about the cursor. */
  private toWorld(view: View, px: number, py: number): [number, number] {
    const [a, b, c, d, e, f] = this.matrix(view);
    const det = a * d - c * b;
    if (det === 0) return [view.cx, view.cy];
    const x = px - e;
    const y = py - f;
    return [(d * x - c * y) / det, (a * y - b * x) / det];
  }

  /** Keeps the region on screen: the center may not leave its bounding box, so panning can never lose the map. */
  private clampView(layer: RegionLayer): void {
    const view = layer.view;
    if (!view) return;
    view.cx = clamp(view.cx, layer.bounds.minX, layer.bounds.maxX);
    view.cy = clamp(view.cy, layer.bounds.minY, layer.bounds.maxY);
  }

  private invalidate(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const layer = this.current;
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!layer?.view || this.width === 0) return;
    const view = layer.view;

    // Drawing in world units and scaling the line widths back keeps every path cached as a Path2D, so a pan restrokes eleven paths instead of rebuilding thousands.
    const [ma, mb, mc, md, me, mf] = this.matrix(view);
    ctx.setTransform(dpr * ma, dpr * mb, dpr * mc, dpr * md, dpr * me, dpr * mf);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Roads thicken a little as the view goes in, so a zoomed map reads like a street map rather than a field of hairlines.
    const zoomK = Math.max(1, view.scale / this.fitScale(layer));
    const weight = 1 + Math.log2(zoomK) * 0.34;

    for (const cls of ROAD_CLASSES) {
      const path = layer.roads.get(cls);
      if (!path) continue;
      const style = ROAD_STYLE[cls];
      ctx.strokeStyle = style.color;
      ctx.lineWidth = (style.width * weight) / view.scale;
      ctx.stroke(path);
    }

    // With a node selected the rest of the graph steps back, only slightly, because a camera is open most of the time in this view and a hard dim would dull the map exactly when it is being used.
    const dim = this.activeEdges === null ? 1 : 0.72;
    for (const kind of EDGE_KINDS) {
      const path = layer.edges.get(kind);
      if (!path) continue;
      this.strokeEdges(ctx, path, kind, view.scale, weight, dim);
    }
    if (this.activeEdges) {
      for (const kind of EDGE_KINDS) {
        const path = this.activeEdges.get(kind);
        if (!path) continue;
        this.strokeEdges(ctx, path, kind, view.scale, weight * 1.7, 1);
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawNodes(ctx, layer, view);
    this.drawIncidents(ctx, layer, view);
    // Without motion the flows are drawn still, and redrawn with the map so they follow a pan.
    if (this.still) this.drawFlows(0);
  }

  /** The attention spreading between cameras right now, each flow resolved once to the road between its two cameras. A flow whose cameras are not joined by road within a few hops is left out. */
  setFlows(flows: AttentionFlow[]): void {
    const drawn: typeof this.flows = [];
    for (const flow of flows) {
      for (const layer of this.layers.values()) {
        const from = layer.siteOf.get(flow.from);
        const to = layer.siteOf.get(flow.to);
        if (!from || !to) continue;
        const points = roadPath(layer.links, from, to);
        if (points) drawn.push({ layer: layer.key, points, reason: flow.reason, strength: flow.strength });
        break;
      }
    }
    this.flows = drawn;
    this.flowNote.hidden = drawn.length === 0;
    if (this.still) this.drawFlows(0);
    else this.animate();
  }

  /** Runs the frame loop while there is a flow to show on a map that is on screen, and lets it stop otherwise, so an idle or hidden map costs nothing. */
  private animate(): void {
    if (this.still || this.fxFrame !== 0) return;
    const step = (t: number): void => {
      this.fxFrame = 0;
      const shown = this.flows.length > 0 && this.width > 0 && this.root.isConnected && this.root.offsetParent !== null && document.visibilityState === 'visible';
      this.drawFlows(shown ? t : -1);
      if (shown) this.fxFrame = requestAnimationFrame(step);
    };
    this.fxFrame = requestAnimationFrame(step);
  }

  /** Pulses traveling from the camera the attention comes from to the one it reaches, over a faint trace of the road, with a ring opening at the far end. `t` below zero only clears. */
  private drawFlows(t: number): void {
    const ctx = this.fxCtx;
    const dpr = this.fx.width / Math.max(1, this.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.fx.width, this.fx.height);
    const layer = this.current;
    if (t < 0 || !layer?.view || this.flows.length === 0) return;
    const view = layer.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const seconds = t / 1000;
    for (const flow of this.flows) {
      if (flow.layer !== layer.key) continue;
      const line = measure(flow.points.map((point) => this.toScreen(view, lonOf(point) * layer.kx, -latOf(point))));
      if (line.length < 4) continue;
      const color = FLOW_COLOR[flow.reason];
      const bright = 0.55 + 0.45 * Math.min(1, Math.max(0, flow.strength));
      ctx.strokeStyle = `rgba(${color}, ${0.14 * bright})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      line.xs.forEach((x, i) => (i === 0 ? ctx.moveTo(x, line.ys[i]!) : ctx.lineTo(x, line.ys[i]!)));
      ctx.stroke();
      const pulses = this.still ? 1 : 3;
      for (let k = 0; k < pulses; k++) {
        // Pulses keep a steady speed on screen, so a long road takes longer to cross than a short one, the way a queue would.
        const traveled = this.still ? line.length * 0.6 : ((seconds * FLOW_SPEED_PX) / line.length + k / pulses) % 1;
        const distance = this.still ? traveled : traveled * line.length;
        // A comet: a halo and a white-hot core at the head, with a shrinking tail behind it.
        for (let tail = 6; tail >= 1; tail--) {
          const [x, y] = pointAt(line, distance - tail * 4);
          ctx.fillStyle = `rgba(${color}, ${bright * 0.5 * (1 - tail / 7)})`;
          ctx.beginPath();
          ctx.arc(x, y, 2.6 - tail * 0.3, 0, Math.PI * 2);
          ctx.fill();
        }
        const [hx, hy] = pointAt(line, distance);
        const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, 10);
        halo.addColorStop(0, `rgba(${color}, ${0.75 * bright})`);
        halo.addColorStop(1, `rgba(${color}, 0)`);
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(hx, hy, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255, 240, 210, ${bright})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      // A ring opening where the attention lands, once every couple of seconds.
      const [ex, ey] = pointAt(line, line.length);
      const phase = this.still ? 0.35 : (seconds / 1.8 + line.length / 997) % 1;
      ctx.strokeStyle = `rgba(${color}, ${bright * (1 - phase)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ex, ey, 7 + phase * 16, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Incidents as a ring with a cross, in a color nothing else on this map uses, so an incident is never mistaken for a busy camera. */
  private drawIncidents(ctx: CanvasRenderingContext2D, layer: RegionLayer, view: View): void {
    for (const incident of this.incidents) {
      const [sx, sy] = this.toScreen(view, incident.lon * layer.kx, -incident.lat);
      if (sx < -30 || sy < -30 || sx > this.width + 30 || sy > this.height + 30) continue;
      const active = incident.id === this.activeIncident;
      const hovered = this.hoveredIncident?.id === incident.id;
      const radius = active || hovered ? 9 : 7;

      ctx.beginPath();
      ctx.arc(sx, sy, radius + 3, 0, Math.PI * 2);
      ctx.fillStyle = MAP_BG;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = INCIDENT_COLOR;
      ctx.lineWidth = active ? 2.4 : 1.8;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(sx - radius * 0.45, sy);
      ctx.lineTo(sx + radius * 0.45, sy);
      ctx.moveTo(sx, sy - radius * 0.45);
      ctx.lineTo(sx, sy + radius * 0.45);
      ctx.strokeStyle = INCIDENT_COLOR;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      if (!active) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, radius + 7, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 84, 60, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  /** Nodes are batched by color, one path for every halo and one per fill color, instead of three or four path operations per site, which on every frame of a pan is most of the node cost. */
  private drawNodes(ctx: CanvasRenderingContext2D, layer: RegionLayer, view: View): void {
    const halos = new Path2D();
    const fills = new Map<string, { path: Path2D; stroke: string }>();
    const decorate: { entry: MapSite; sx: number; sy: number; radius: number }[] = [];

    const add = (color: string, stroke: string, sx: number, sy: number, radius: number): void => {
      let group = fills.get(color);
      if (!group) {
        group = { path: new Path2D(), stroke };
        fills.set(color, group);
      }
      group.path.moveTo(sx + radius, sy);
      group.path.arc(sx, sy, radius, 0, Math.PI * 2);
    };

    for (const entry of layer.sites) {
      const [sx, sy] = this.toScreen(view, entry.x, entry.y);
      if (sx < -24 || sy < -24 || sx > this.width + 24 || sy > this.height + 24) continue;

      const kindRgb = entry.site.is_freeway ? NODE_FREEWAY : NODE_STREET;
      const cams = entry.site.cameras.length;

      // A site the poller does not serve still belongs to the graph, so it is drawn in its kind's color but smaller and dimmer, because it is not clickable and must not look like it is.
      if (entry.live.length === 0) {
        const radius = 2.4 + 0.9 * Math.sqrt(cams);
        halos.moveTo(sx + radius + 1.6, sy);
        halos.arc(sx, sy, radius + 1.6, 0, Math.PI * 2);
        add(`rgba(${kindRgb[0]}, ${kindRgb[1]}, ${kindRgb[2]}, 0.46)`, '', sx, sy, radius);
        continue;
      }

      const state = entry.live.map((id) => this.states.get(id)).find((s) => s !== undefined);
      const activity = state?.activity ?? null;
      const hasFrames = (state?.frames ?? 0) > 0;
      const heat = activity ?? 0;
      // Only the genuinely busy end of the scale warms towards amber: interpolating blue to amber across the whole range runs through gray and makes a middling camera look dead.
      const warm = heat <= HOT_FROM ? 0 : (heat - HOT_FROM) / (1 - HOT_FROM);
      // Quantized so that a wall of cameras collapses into a handful of fill colors rather than one per node.
      const rgb = kindRgb.map((c, i) => Math.round((c + ((NODE_HOT[i] as number) - c) * warm) / 8) * 8);
      const hovered = this.hovered === entry;
      const active = entry.site.id === this.activeSite;
      const radius = (3.4 + 1.7 * Math.sqrt(cams) + heat * 3.2) * (hovered || active ? 1.25 : 1);

      halos.moveTo(sx + radius + 2.2, sy);
      halos.arc(sx, sy, radius + 2.2, 0, Math.PI * 2);
      add(
        `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${hasFrames ? 0.92 : 0.34})`,
        `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${hasFrames ? 1 : 0.5})`,
        sx,
        sy,
        radius,
      );
      if (hovered || active) decorate.push({ entry, sx, sy, radius });
    }

    // The halo is the background color: it is what lifts a node off the edge running under it.
    ctx.fillStyle = MAP_BG;
    ctx.globalAlpha = 0.82;
    ctx.fill(halos);
    ctx.globalAlpha = 1;

    ctx.lineWidth = 1.4;
    for (const [color, group] of fills) {
      ctx.fillStyle = color;
      ctx.fill(group.path);
      if (!group.stroke) continue;
      ctx.strokeStyle = group.stroke;
      ctx.stroke(group.path);
    }

    for (const { entry, sx, sy, radius } of decorate) this.decorateSite(ctx, entry, sx, sy, radius);
  }

  /** Hover and selection are drawn per node, because there are at most two of them. */
  private decorateSite(ctx: CanvasRenderingContext2D, entry: MapSite, sx: number, sy: number, radius: number): void {
    const active = entry.site.id === this.activeSite;
    if (!active) {
      ctx.beginPath();
      ctx.arc(sx, sy, radius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 226, 170, 0.8)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      return;
    }
    // The selected node gets two rings of the accent, which nothing else on the map wears.
    for (const [r, w, alpha] of [
      [radius + 4.5, 2, 1],
      [radius + 9, 1.2, 0.55],
    ] as [number, number, number][]) {
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 180, 60, ${alpha})`;
      ctx.lineWidth = w;
      ctx.stroke();
    }
  }

  private strokeEdges(ctx: CanvasRenderingContext2D, path: Path2D, kind: EdgeKind, scale: number, weight: number, dim: number): void {
    const style = EDGE_STYLE[kind];
    ctx.strokeStyle = style.color;
    ctx.globalAlpha = style.alpha * dim;
    ctx.lineWidth = (style.width * weight) / scale;
    if (style.dash) ctx.setLineDash(style.dash.map((d) => d / scale));
    ctx.stroke(path);
    if (style.dash) ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

}

function appendWay(path: Path2D, points: LatLon[], kx: number, bounds: Bounds): void {
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    const x = lonOf(point) * kx;
    const y = -latOf(point);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
    grow(bounds, x, y);
  }
}

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function grow(bounds: Bounds, x: number, y: number): void {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
