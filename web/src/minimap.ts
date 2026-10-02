import type { Graph, Site, Edge } from './api';

const NS = 'http://www.w3.org/2000/svg';

/** Site ids are namespaced by region, as in `<region>:S008`, so the prefix is the region a site belongs to. A single-region graph still works: everything lands in one group. */
const regionOf = (siteId: string): string => {
  const cut = siteId.indexOf(':');
  return cut === -1 ? '' : siteId.slice(0, cut);
};

interface RegionLayer {
  group: SVGGElement;
  viewBox: string;
  sites: number;
  edges: number;
}

/** An inline SVG of the site graph in an equirectangular projection. No tiles, no basemap, no external requests.
 *
 * One region is drawn at a time, because a viewBox spanning regions far apart shrinks each to a speck, so the map follows whichever region the hero is in. */
export class Minimap {
  readonly root: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly legend: HTMLElement;
  private readonly dots = new Map<string, SVGCircleElement>();
  private readonly layers = new Map<string, RegionLayer>();
  private readonly marker: SVGCircleElement;
  private activeSite: string | null = null;
  private shown: string | null = null;

  constructor(graph: Graph) {
    this.root = document.createElement('aside');
    this.root.className = 'minimap';

    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.setAttribute('aria-hidden', 'true');

    this.marker = document.createElementNS(NS, 'circle');
    this.marker.setAttribute('r', '0.0028');
    this.marker.setAttribute('class', 'minimap-marker');
    this.marker.setAttribute('visibility', 'hidden');

    const sitesByRegion = new Map<string, Site[]>();
    for (const site of graph.sites) {
      const key = regionOf(site.id);
      const bucket = sitesByRegion.get(key);
      if (bucket) bucket.push(site);
      else sitesByRegion.set(key, [site]);
    }
    const edgesByRegion = new Map<string, Edge[]>();
    for (const edge of graph.edges) {
      if (edge.kind === 'nearby') continue;
      const key = regionOf(edge.src);
      if (key !== regionOf(edge.dst)) continue;
      const bucket = edgesByRegion.get(key);
      if (bucket) bucket.push(edge);
      else edgesByRegion.set(key, [edge]);
    }

    for (const [key, sites] of sitesByRegion) {
      const edges = edgesByRegion.get(key) ?? [];
      this.layers.set(key, this.buildLayer(key, sites, edges));
    }

    this.legend = document.createElement('div');
    this.legend.className = 'minimap-legend';

    this.svg.appendChild(this.marker);
    this.root.append(this.svg, this.legend);
    this.show(this.layers.keys().next().value ?? null);
  }

  private buildLayer(key: string, sites: Site[], edges: Edge[]): RegionLayer {
    const lat0 = sites.reduce((a, s) => a + s.lat, 0) / Math.max(1, sites.length);
    const kx = Math.cos((lat0 * Math.PI) / 180);
    const project = (lat: number, lon: number): [number, number] => [lon * kx, -lat];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const seen = (x: number, y: number): void => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };

    const group = document.createElementNS(NS, 'g');
    group.setAttribute('data-region', key);

    const edgeLayer = document.createElementNS(NS, 'g');
    edgeLayer.setAttribute('class', 'minimap-edges');
    for (const edge of edges) {
      const points = (edge.geometry.length > 1 ? edge.geometry : []).map(([lat, lon]) => project(lat, lon));
      if (points.length < 2) continue;
      for (const [x, y] of points) seen(x, y);
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', points.map(([x, y]) => `${x},${y}`).join(' '));
      line.setAttribute('class', `edge edge-${edge.kind}`);
      edgeLayer.appendChild(line);
    }

    const siteLayer = document.createElementNS(NS, 'g');
    siteLayer.setAttribute('class', 'minimap-sites');
    for (const site of sites) {
      const [x, y] = project(site.lat, site.lon);
      seen(x, y);
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.setAttribute('r', '0.0009');
      dot.setAttribute('class', site.is_freeway ? 'site site-freeway' : 'site');
      siteLayer.appendChild(dot);
      this.dots.set(site.id, dot);
    }

    group.append(edgeLayer, siteLayer);
    const pad = Math.max(maxX - minX, maxY - minY) * 0.05 || 0.01;
    return {
      group,
      viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
      sites: sites.length,
      edges: edges.length,
    };
  }

  private show(key: string | null): void {
    if (key === null || key === this.shown) return;
    const layer = this.layers.get(key);
    if (!layer) return;
    for (const other of this.layers.values()) other.group.remove();
    this.svg.insertBefore(layer.group, this.marker);
    this.svg.setAttribute('viewBox', layer.viewBox);
    const label = this.layers.size > 1 ? `${key} · ` : '';
    this.legend.textContent = `${label}${layer.sites} sites · ${layer.edges} edges`;
    this.shown = key;
  }

  destroy(): void {
    this.root.remove();
  }

  /** Follows the region being viewed even when no camera is open, rather than whichever region happened to be drawn first. */
  showRegion(key: string | null): void {
    if (key === null) return;
    this.show(key);
  }

  setActive(siteId: string | null): void {
    if (this.activeSite) this.dots.get(this.activeSite)?.classList.remove('is-active');
    this.activeSite = siteId;
    if (siteId !== null) this.show(regionOf(siteId));
    const dot = siteId === null ? undefined : this.dots.get(siteId);
    if (!dot) {
      this.marker.setAttribute('visibility', 'hidden');
      return;
    }
    dot.classList.add('is-active');
    this.marker.setAttribute('cx', dot.getAttribute('cx') ?? '0');
    this.marker.setAttribute('cy', dot.getAttribute('cy') ?? '0');
    this.marker.setAttribute('visibility', 'visible');
  }
}
