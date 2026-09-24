// Thin typed wrapper over the rt511 server. Every call resolves to null rather than throwing: the wall is meant to be left running on a TV, so a server restart, or a response whose shape has drifted, should make it go quiet and recover rather than fill the console with unhandled rejections or crash a render.
//
// The response types come from `@rt511/shared`, which the server imports too, so the contract is declared once rather than described in one language and re-declared in another.

import type {
  HighlightsResponse,
  BoardResponse,
  ScoresResponse,
  CamerasResponse,
  IncidentsResponse,
  FramesResponse,
  JevSnapshot,
  Graph,
  NationalResponse,
  RegionsResponse,
  RoadsResponse,
  StreamResponse,
  SkyResponse,
  DiaryResponse,
  PulseResponse,
  CountResponse,
  LiveResponse,
} from '@rt511/shared';
import { arr, field, latLonLine, latLonRings, lonLatRings, num, obj, ShapeError, str } from './validate';

export type {
  BBox,
  GatePoint,
  Incident,
  IncidentStatus,
  IncidentsResponse,
  JevSnapshot,
  VerdictPoint,
  Camera,
  CameraState,
  CamerasResponse,
  Edge,
  EdgeKind,
  Frame,
  FramesResponse,
  Graph,
  GraphMeta,
  NationalRegion,
  NationalResponse,
  NationalSource,
  NationalState,
  Region,
  RegionMeta,
  RegionsResponse,
  RoadClass,
  RoadRegion,
  RoadsResponse,
  Site,
  StreamResponse,
} from '@rt511/shared';
export { ROAD_CLASSES } from '@rt511/shared';

// Failures are announced once per path and then muted until that same path succeeds, so a wall left running against a dead backend, or against a camera this run does not serve, does not fill the console overnight. Muting per path rather than globally matters: the ten-second poll succeeds constantly, and clearing everything on any success would let a permanent 404 re-announce itself forever.
const muted = new Set<string>();

/** Fetches, then checks the shape before anything downstream sees it. Returns null on a transport failure, a bad status, or a response that does not match, logging a given path's failure once until that path succeeds again. */
async function getJson<T>(path: string, parse: (body: unknown) => T): Promise<T | null> {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) {
      note(path, `${path} -> ${res.status}`);
      return null;
    }
    const body = parse(await res.json());
    muted.delete(path);
    return body;
  } catch (error) {
    if (error instanceof ShapeError) {
      // Loud and specific: the message names the field path that did not match, which is the only thing that makes a backend rename debuggable from the browser.
      note(path, `${path} does not match the expected shape — ${error.message}`);
    } else {
      note(path, `${path} unreachable`);
    }
    return null;
  }
}

function note(path: string, message: string): void {
  if (muted.has(path)) return;
  muted.add(path);
  console.warn(`rt511: ${message}`);
}

/** One shallow check per endpoint. Each one answers "is this a response from the rt511 server", not "is every field of every record the right type": the server owns the contract and validates the pipeline files it reads, and repeating that walk over a three megabyte graph on every load buys nothing. */
function parseSource(source: Record<string, unknown>, where: string): void {
  str(source.site_url, `${where}.site_url`);
  str(source.source_name ?? source.name, `${where}.name`);
  arr(source.states, `${where}.states`).forEach((state, i) => str(state, `${where}.states[${i}]`));
}

const parseRegions = (body: unknown): RegionsResponse => {
  const root = obj(body, 'regions');
  str(root.active, 'regions.active');
  for (const [i, value] of arr(root.regions, 'regions.regions').entries()) {
    const region = obj(value, `regions.regions[${i}]`);
    parseSource(region, `regions.regions[${i}]`);
  }
  return root as unknown as RegionsResponse;
};

const parseGraph = (body: unknown): Graph => {
  const root = obj(body, 'graph');
  const meta = obj(root.meta, 'graph.meta');
  if (meta.source_name !== undefined && meta.regions === undefined) parseSource(meta, 'graph.meta');
  if (meta.regions !== undefined) {
    for (const [i, value] of arr(meta.regions, 'graph.meta.regions').entries()) {
      parseSource(obj(value, `graph.meta.regions[${i}]`), `graph.meta.regions[${i}]`);
    }
  }
  arr(root.sites, 'graph.sites');
  arr(root.cameras, 'graph.cameras');
  const edges = arr(root.edges, 'graph.edges');
  // The one field worth reaching into: edge geometry is where the [lat, lon] brand is applied, and a swapped order draws a plausible rotated map rather than failing.
  for (const [i, value] of edges.entries()) {
    const edge = obj(value, `graph.edges[${i}]`);
    edge.geometry = latLonLine(edge.geometry, `graph.edges[${i}].geometry`);
    if (i === 0) str(edge.kind, 'graph.edges[0].kind');
  }
  return root as unknown as Graph;
};

const parseCameras = (body: unknown): CamerasResponse => {
  const root = obj(body, 'cameras');
  num(root.interval_s, 'cameras.interval_s');
  num(root.started_at, 'cameras.started_at');
  const cameras = arr(root.cameras, 'cameras.cameras');
  const first = cameras[0];
  if (first !== undefined) {
    const state = obj(first, 'cameras.cameras[0]');
    num(state.id, 'cameras.cameras[0].id');
    num(state.frames, 'cameras.cameras[0].frames');
  }
  return root as unknown as CamerasResponse;
};

const parseJev = (body: unknown): JevSnapshot => {
  const root = obj(body, 'jev');
  arr(root.incidents, 'jev.incidents');
  arr(root.cameras, 'jev.cameras');
  num(root.calls, 'jev.calls');
  num(root.reask_after_s, 'jev.reask_after_s');
  const gates = obj(root.gates, 'jev.gates');
  for (const key of ['noul_threshold', 'act_confidence', 'score_swing', 'cleared_residue', 'supported_lift', 'chosen_gain', 'chosen_others']) num(gates[key], `jev.gates.${key}`);
  return root as unknown as JevSnapshot;
};

const parseFrames = (body: unknown): FramesResponse => {
  const root = obj(body, 'frames');
  num(root.id, 'frames.id');
  arr(root.frames, 'frames.frames');
  return root as unknown as FramesResponse;
};

const parseStream = (body: unknown): StreamResponse => {
  const root = obj(body, 'stream');
  num(root.id, 'stream.id');
  str(root.url, 'stream.url');
  return root as unknown as StreamResponse;
};

const parseRoads = (body: unknown): RoadsResponse => {
  const root = obj(body, 'roads');
  str(root.attribution, 'roads.attribution');
  const regions = obj(root.regions, 'roads.regions');
  for (const [key, value] of Object.entries(regions)) {
    const region = obj(value, `roads.regions.${key}`);
    const roads = obj(region.roads, `roads.regions.${key}.roads`);
    for (const [cls, ways] of Object.entries(roads)) roads[cls] = latLonRings(ways, `roads.regions.${key}.roads.${cls}`);
  }
  return root as unknown as RoadsResponse;
};

const parseIncidents = (body: unknown): IncidentsResponse => {
  const root = obj(body, 'incidents');
  str(root.region, 'incidents.region');
  str(root.status, 'incidents.status');
  arr(root.incidents, 'incidents.incidents');
  return root as unknown as IncidentsResponse;
};

const parseNational = (body: unknown): NationalResponse => {
  const root = obj(body, 'national');
  str(root.attribution, 'national.attribution');
  arr(root.covered_states, 'national.covered_states');
  arr(root.regions, 'national.regions');
  const states = obj(root.states, 'national.states');
  for (const [code, value] of Object.entries(states)) {
    const state = obj(value, `national.states.${code}`);
    str(state.name, `national.states.${code}.name`);
    state.polygons = lonLatRings(state.polygons, `national.states.${code}.polygons`);
  }
  const sources = obj(root.sources, 'national.sources');
  for (const [key, value] of Object.entries(sources)) {
    const source = obj(value, `national.sources.${key}`);
    parseSource(source, `national.sources.${key}`);
    field(obj(source.cameras, `national.sources.${key}.cameras`), 'ids', `national.sources.${key}.cameras`, arr);
  }
  return root as unknown as NationalResponse;
};

export const getRegions = (): Promise<RegionsResponse | null> => getJson('/api/regions', parseRegions);
export const getGraph = (): Promise<Graph | null> => getJson('/api/graph', parseGraph);
/** Naming the city being shown is what tells a server started without one which cameras to poll. It is idle until somebody looks. */
/** `visible` names the cameras the viewer can actually see, which is what keeps the server from polling a whole city to fill thirty-five tiles. Null omits the parameter, which leaves the server's idea of visibility alone; an empty array states that nothing is on screen, which is true in the map view. */
export const getCameras = (region?: string | null, visible?: number[] | null): Promise<CamerasResponse | null> => {
  if (!region) return getJson('/api/cameras', parseCameras);
  const params = new URLSearchParams({ region });
  if (visible) params.set('visible', visible.join(','));
  return getJson(`/api/cameras?${params.toString()}`, parseCameras);
};
export const getFrames = (id: number): Promise<FramesResponse | null> => getJson(`/api/frames/${id}`, parseFrames);
export const getNational = (): Promise<NationalResponse | null> => getJson('/api/national', parseNational);
/** `watch` asks the server to keep a bounded set of incident cameras on the fast poll period, which is what makes records become askable on a view other than the wall. Sent true while the pane is open and false once on closing, so the promotion stops promptly rather than waiting out its own expiry. */
export const getJev = (watch: boolean): Promise<JevSnapshot | null> => getJson(`/api/jev?watch=${watch ? '1' : '0'}`, parseJev);

/** What the state patrol is responding to near one city. A city whose state has no dispatch feed answers with an empty list and a status saying so, which is a normal state rather than a failure. */
export const getIncidents = (region: string): Promise<IncidentsResponse | null> =>
  getJson(`/api/incidents?region=${encodeURIComponent(region)}`, parseIncidents);

/** Road geometry for one region. Asking for every region at once is megabytes, so the region is never optional here. */
export const getRoads = (region: string): Promise<RoadsResponse | null> =>
  getJson(`/api/roads?region=${encodeURIComponent(region)}`, parseRoads);

/** The stream lookup keeps the backend's reason for a refusal, which distinguishes a camera that publishes no video from one this run is simply not polling. They look identical otherwise and mean very different things to a viewer. */
export interface StreamLookup {
  stream: StreamResponse | null;
  reason: string | null;
}

export async function getStream(id: number): Promise<StreamLookup> {
  const path = `/api/stream/${id}`;
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (res.ok) {
      const stream = parseStream(await res.json());
      muted.delete(path);
      return { stream, reason: null };
    }
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    return { stream: null, reason: body?.detail ?? `stream unavailable (${res.status})` };
  } catch (error) {
    if (error instanceof ShapeError) {
      note(path, `${path} does not match the expected shape — ${error.message}`);
      return { stream: null, reason: 'stream response did not match' };
    }
    note(path, `${path} unreachable`);
    return { stream: null, reason: 'backend unreachable' };
  }
}

/** Snapshot URL for a ring-buffer index. `bust` should be the frame's `last_ts`, which is the only thing that tells us the bytes changed. */
/** The newest picture of the camera open in the panel, from the focus fetch or the ring, whichever is newer. The timestamp only makes each new picture a distinct URL. */
export function liveUrl(id: number, ts: number): string {
  return `/api/snap/${id}?k=live&t=${Math.floor(ts * 10)}`;
}

export function snapUrl(id: number, k: number, bust?: number): string {
  const t = bust === undefined ? '' : `&t=${Math.floor(bust)}`;
  return `/api/snap/${id}?k=${k}${t}`;
}

export const getScores = (): Promise<ScoresResponse | null> => getJson('/api/scores', (body) => {
  const value = obj(body, 'scores');
  arr(value.regions, 'scores.regions');
  arr(value.cameras, 'scores.cameras');
  obj(value.tuning, 'scores.tuning');
  return body as ScoresResponse;
});

export type { BoardCamera, BoardResponse } from '@rt511/shared';

export const getBoard = (state = '', region = ''): Promise<BoardResponse | null> => {
  const query = new URLSearchParams();
  if (state) query.set('state', state);
  if (region) query.set('region', region);
  return getJson(`/api/board?${query}`, (body) => {
    const root = obj(body, 'board');
    for (const value of arr(root.cameras, 'board.cameras')) {
      const camera = obj(value, 'board.camera');
      num(camera.id, 'board.camera.id');
      num(camera.attention, 'board.camera.attention');
      num(camera.period_s, 'board.camera.period_s');
      num(camera.frames, 'board.camera.frames');
      for (const key of ['region', 'region_name', 'state', 'location', 'roadway', 'driver']) str(camera[key], `board.camera.${key}`);
      obj(camera.axes, 'board.camera.axes');
      if (typeof camera.radar !== 'boolean') throw new ShapeError('board.camera.radar', 'a boolean', camera.radar);
    }
    for (const state of arr(root.states, 'board.states')) str(state, 'board.state');
    for (const value of arr(root.regions, 'board.regions')) {
      const region = obj(value, 'board.region');
      for (const key of ['key', 'name', 'state']) str(region[key], `board.region.${key}`);
    }
    return root as unknown as BoardResponse;
  });
};

export type { Highlight, HighlightsResponse } from '@rt511/shared';

export const getHighlights = (region?: string): Promise<HighlightsResponse | null> => getJson(`/api/highlights${region ? `?region=${encodeURIComponent(region)}` : ''}`, (body) => {
  const root = obj(body, 'highlights');
  for (const value of arr(root.highlights, 'highlights.highlights')) {
    const item = obj(value, 'highlight');
    for (const key of ['brief', 'region']) str(item[key], `highlight.${key}`);
    for (const key of ['camera', 'attention', 'at']) num(item[key], `highlight.${key}`);
    if (!['incident', 'stopped', 'movement'].includes(str(item.kind, 'highlight.kind'))) throw new ShapeError('highlight.kind', 'a highlight kind', item.kind);
  }
  return root as unknown as HighlightsResponse;
});

export type { CountResponse, LiveResponse } from '@rt511/shared';
export type { DiaryEntry, DiaryKind, DiaryResponse, PulsePoint, PulseResponse, SkyRegion, SkyResponse } from '@rt511/shared';

export const getSky = (): Promise<SkyResponse | null> => getJson('/api/sky', (body) => {
  const root = obj(body, 'sky');
  for (const value of arr(root.regions, 'sky.regions')) {
    const region = obj(value, 'sky.region');
    for (const key of ['key', 'name']) str(region[key], `sky.region.${key}`);
    for (const key of ['lat', 'lon', 'sun_elevation', 'cameras', 'contrast_known', 'contrast_low']) num(region[key], `sky.region.${key}`);
    if (region.brightness !== null) num(region.brightness, 'sky.region.brightness');
  }
  return root as unknown as SkyResponse;
});

export const getDiary = (day?: string): Promise<DiaryResponse | null> => getJson(`/api/diary${day ? `?day=${encodeURIComponent(day)}` : ''}`, (body) => {
  const root = obj(body, 'diary');
  str(root.day, 'diary.day');
  for (const day of arr(root.days, 'diary.days')) str(day, 'diary.days[]');
  for (const value of arr(root.entries, 'diary.entries')) {
    const entry = obj(value, 'diary.entry');
    num(entry.ts, 'diary.entry.ts');
    for (const key of ['kind', 'region', 'brief']) str(entry[key], `diary.entry.${key}`);
    if (entry.camera !== null) num(entry.camera, 'diary.entry.camera');
  }
  return root as unknown as DiaryResponse;
});

export const getPulse = (): Promise<PulseResponse | null> => getJson('/api/pulse', (body) => {
  const root = obj(body, 'pulse');
  str(root.day, 'pulse.day');
  const regions = obj(root.regions, 'pulse.regions');
  for (const [key, points] of Object.entries(regions)) {
    for (const value of arr(points, `pulse.regions.${key}`)) {
      const point = obj(value, `pulse.regions.${key}[]`);
      num(point.ts, 'pulse.point.ts');
      num(point.diff, 'pulse.point.diff');
    }
  }
  return root as unknown as PulseResponse;
});

/** The detector's count for one camera's newest frame, for the night shift. Null when the server cannot be reached, which is shown the same as no detector. */
export const getCount = (id: number): Promise<CountResponse | null> => getJson(`/api/count/${String(id)}`, (body) => {
  const root = obj(body, 'count');
  str(root.status, 'count.status');
  if (root.status === 'counted') {
    num(root.vehicles, 'count.vehicles');
    num(root.frame_ts, 'count.frame_ts');
    obj(root.by_class, 'count.by_class');
  }
  return root as unknown as CountResponse;
});

/** Keeps the open camera on its agency's own refresh rate and says when its newest picture was taken. Null when the server cannot be reached. */
export const getLive = (id: number): Promise<LiveResponse | null> => getJson(`/api/live/${String(id)}`, (body) => {
  const root = obj(body, 'live');
  num(root.id, 'live.id');
  if (root.period_s !== null) num(root.period_s, 'live.period_s');
  if (root.ts !== null) num(root.ts, 'live.ts');
  return root as unknown as LiveResponse;
});
