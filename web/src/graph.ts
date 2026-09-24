import type { Camera, Edge, EdgeKind, Graph, Site } from './api';

const FLOW: EdgeKind[] = ['freeway', 'ramp', 'street'];

/** Adjacency over the site graph, plus the camera lookups the hero and the tour need. Nearby edges are undirected and carry no length, so they are kept apart from the flow edges. */
export class Topology {
  readonly sites = new Map<string, Site>();
  readonly cameras = new Map<number, Camera>();
  private readonly out = new Map<string, Edge[]>();
  private readonly into = new Map<string, Edge[]>();

  constructor(readonly graph: Graph) {
    for (const site of graph.sites) this.sites.set(site.id, site);
    for (const camera of graph.cameras) this.cameras.set(camera.id, camera);
    for (const edge of graph.edges) {
      push(this.out, edge.src, edge);
      push(this.into, edge.dst, edge);
      if (edge.kind === 'nearby') {
        push(this.out, edge.dst, edge);
        push(this.into, edge.src, edge);
      }
    }
  }

  /** The first camera at a site, preferring one that can actually serve video. */
  cameraAt(siteId: string): Camera | null {
    const site = this.sites.get(siteId);
    if (!site) return null;
    const cams = site.cameras.map((id) => this.cameras.get(id)).filter((c): c is Camera => c !== undefined);
    return cams.find((c) => c.has_video) ?? cams[0] ?? null;
  }

  /** The flow edge leaving a site, preferring to stay on the same kind of road so a corridor tour does not wander onto a ramp at the first opportunity. */
  private step(siteId: string, direction: 'down' | 'up', preferred?: EdgeKind): Edge | null {
    const candidates = (direction === 'down' ? this.out.get(siteId) : this.into.get(siteId)) ?? [];
    const flow = candidates.filter((e) => FLOW.includes(e.kind) && (direction === 'down' ? e.src === siteId : e.dst === siteId));
    if (flow.length === 0) return null;
    return flow.find((e) => e.kind === preferred) ?? flow[0] ?? null;
  }

  /** Moves one hop along traffic flow from a camera, returning the next camera and the edge that got there. A camera the builder could not place has no site, so there is nothing to step along. */
  hop(cameraId: number, direction: 'down' | 'up'): { camera: Camera; edge: Edge } | null {
    const camera = this.cameras.get(cameraId);
    if (!camera || camera.site === null) return null;
    const site = this.sites.get(camera.site);
    const preferred: EdgeKind | undefined = site?.is_freeway ? 'freeway' : 'street';
    const edge = this.step(camera.site, direction, preferred);
    if (!edge) return null;
    const nextSite = direction === 'down' ? edge.dst : edge.src;
    const next = this.cameraAt(nextSite);
    return next ? { camera: next, edge } : null;
  }

  /** Freeway sites ordered by mile marker, used to seed the corridor tour. */
  freewayStarts(): Site[] {
    return this.graph.sites
      .filter((s) => s.is_freeway && this.step(s.id, 'down', 'freeway') !== null)
      .sort((a, b) => (a.mile_marker ?? 0) - (b.mile_marker ?? 0));
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
