/** The wire contract between the rt511 server and the wall.
 *
 * Both sides import these, which is the point of the port: the shapes are declared once rather than described in Python and re-declared in TypeScript. Coordinate order is part of the contract and is carried in the type, because `[lat, lon]` and `[lon, lat]` are both pairs of numbers and a swap renders a plausible rotated map instead of failing. */

export type { LatLon, LonLat } from './coords.js';
export { asLatLon, asLonLat, latLon, lonLat, latOf, lonOf, latOfLonLat, lonOfLonLat, toLatLon, toLonLat } from './coords.js';
export { solarElevation } from './sun.js';
export { SCORE } from './score.js';

import type { LatLon, LonLat } from './coords.js';

/** South, west, north, east, as every bbox in this project is ordered. */
export type BBox = [number, number, number, number];

export interface Region {
  key: string;
  name: string;
  source: string;
  source_name: string;
  site_url: string;
  states: string[];
  attribution: string;
  /** The terms the agency publishes these cameras under, in words, and where they are written down. */
  license: string;
  terms_url: string;
  /** Text the agency requires to be repeated wherever its cameras are credited. Empty when none is required. */
  notice: string;
  bbox: BBox;
  cameras: number;
}

export interface RegionsResponse {
  active: string;
  regions: Region[];
  /** Shown wherever cameras are shown: not affiliated with any agency, imagery belongs to them, no warranty, nothing stored. */
  disclaimer: string;
}

export interface Site {
  id: string;
  lat: number;
  lon: number;
  is_freeway: boolean;
  roadway: string;
  mile_marker: number | null;
  bearing: number | null;
  cameras: number[];
  /** Where each of this site's cameras was snapped onto the road network, in the same order as `cameras`, sometimes with one extra entry for the opposite carriageway. Written by the graph builder; absent only on a graph built before it was. */
  snaps?: Snap[] | undefined;
}

/** One camera's placement on the road network. */
export interface Snap {
  lat: number;
  lon: number;
  /** The OpenStreetMap highway class of the way the camera was placed on, such as `motorway` or `tertiary`. */
  highway: string;
  name: string | null;
  ref: string | null;
  two_way: boolean;
  lanes?: number | null;
  lanes_forward?: number | null;
  lanes_backward?: number | null;
  maxspeed_kmh?: number;
  maxspeed_source?: 'tag' | 'default';
  bearing: number | null;
  distance_m: number;
}

export interface Camera {
  id: number;
  region?: string | undefined;
  source?: string | undefined;
  roadway: string;
  /** Null wherever a site publishes no direction code, which several of them do not. */
  direction: string | null;
  location: string;
  lat: number;
  lon: number;
  is_freeway: boolean;
  /** Null for a camera the graph builder could not place on a road, such as a rest-area view. */
  site: string | null;
  has_video: boolean;
  mile_marker?: number | null | undefined;
}

export type EdgeKind = 'freeway' | 'ramp' | 'street' | 'nearby';

export interface Edge {
  src: string;
  dst: string;
  kind: EdgeKind;
  length_m: number;
  tt_s: number;
  geometry: LatLon[];
}

export interface RegionMeta {
  region: string;
  region_name?: string | undefined;
  source?: string | undefined;
  source_name?: string | undefined;
  site_url?: string | undefined;
  states?: string[] | undefined;
  attribution?: string | undefined;
  license?: string | undefined;
  terms_url?: string | undefined;
  notice?: string | undefined;
  /** Credit for the published traffic counts joined to this region, where there are any. */
  counts_attribution?: string | undefined;
  counts_terms_url?: string | undefined;
  /** The IANA time zone the city keeps, for a camera's own local time. */
  time_zone?: string | null | undefined;
  bbox?: BBox | undefined;
}

export interface GraphMeta extends RegionMeta {
  sites?: number | undefined;
  cameras?: number | undefined;
  edges?: number | undefined;
  regions?: RegionMeta[] | undefined;
  report?: { edge_kinds?: Record<string, number> } | undefined;
}

export interface Graph {
  meta: GraphMeta;
  sites: Site[];
  cameras: Camera[];
  edges: Edge[];
}

export interface CameraState {
  id: number;
  region?: string | undefined;
  /** How often this camera is actually being polled right now, in seconds, which is not the source default: a camera on screen runs at its source's period, one in a watched city that nobody can see runs slowly, and a camera with nothing happening in front of it is stretched further still. Staleness is judged against this number, so it has to be the effective one or perfectly good tiles grey out. */
  period_s: number;
  frames: number;
  polls: number;
  unchanged: number;
  unavailable: number;
  errors: number;
  last_error?: string | null;
  last_ts: number | null;
  last_modified?: string | null;
  brightness: number | null;
  diff: number | null;
  /** 0..1 against this camera's own recent behaviour, or null before it has enough history and its region has none to lend. */
  activity: number | null;
  /** What the scorer thinks this camera is worth looking at, 0..1, or null while nothing is known about it yet. `activity` above is untouched by it and still means exactly what it always did. */
  attention: number | null;
  /** The parts `attention` was made of, for the wall to explain itself and for the decision log to be checked against. Null alongside a null `attention`. */
  axes: AttentionAxes | null;
}

/** Where a scale prior came from. `aadt` is a published traffic count joined to this camera, `class` is the road class the camera was snapped to, and `default` is a camera the graph could not place on a road at all. */
export type ScalePriorSource = 'aadt' | 'capacity' | 'class' | 'default';

export interface AttentionAxes {
  /** How far the current frame difference is from what this camera does at this hour of the week. Identical to `activity` until the hourly profile has samples. */
  anomaly: number | null;
  /** The movement term the spectacle axis contributes, on its own. The scale prior is no longer folded in here; it is reported as `scale_amplifier` and applied once to the weighted sum of both axes. */
  spectacle: number | null;
  /** The floor a nearby dispatch incident puts under this camera, already decayed by the incident's age and adjusted by the arbiter where it had something to say. Zero when there is none. */
  incident_floor: number;
  queue_floor: number;
  queue: { source: 'incident' | 'standstill'; incident: string; anchor: number; length_m: number; reach: number; jev_chosen: boolean } | null;
  /** The same floor before the arbiter touched it. Equal to `incident_floor` whenever Jev is absent, silent, or gated out, which is the ordinary case. */
  incident_floor_base: number;
  /** The incident that set the floor, as `type at location`, or null when nothing did. */
  incident: string | null;
  /** 0..1 standing for how much traffic this camera sees at all, before anything moves. */
  scale_prior: number;
  scale_prior_source: ScalePriorSource;
  /** What the weighted sum of anomaly and spectacle was multiplied by, which is the scale prior mapped onto the amplifier range. One means the prior changed nothing. */
  scale_amplifier: number;
  /** The shrinkage blend of this hour's cell mean and the rolling median, which `anomaly` is measured against. */
  baseline: number | null;
  /** How many earlier polls this hour-of-week cell holds, not counting the one being scored. Zero means the baseline is exactly the rolling median, which is the number `activity` uses. */
  baseline_n: number;
  /** Sample standard deviation of the hour cell before the newest frame, with at least two earlier frames required. */
  baseline_sd: number | null;
  /** The frame changed by almost nothing although this hour usually shows movement, which is either stopped traffic, an empty road or a frozen camera. Recorded on every poll; acted on only through `gate` below, and only when the arbiter says which of the three it is. */
  ambiguous_zero: boolean;
  /** What the arbiter said about an ambiguous zero on this camera, and the floor that answer put under it. Null whenever the gate has not fired, nothing was asked, or the answer was too weak to act on. */
  gate: GateInfluence | null;
  /** What the arbiter said about the incident that set this camera's floor, or null when nothing was asked or nothing came back. Model output about public data: it is shown and logged, never obeyed. */
  jev: JevInfluence | null;
}

/** One incident's arbitration, as it reached one camera. The probabilities are the model's; the multiplier is this project's arithmetic over them. */
/** The arbiter's reading of one still picture on a camera whose hour usually moves.
 *
 * Both answers are Noul probabilities, which carry no confidence of their own, so the threshold applied to them is the whole of the gating. `floor` is what the reading put under the camera, which is zero whenever neither answer cleared its threshold. */
export interface GateInfluence {
  /** Probability that the stillness is stopped traffic rather than an empty road. */
  standstill: number;
  /** Probability that the picture is not updating at all, which is a fault in the feed rather than anything on the road. */
  frozen: number;
  /** The floor this reading put under the camera, after the threshold and the hold window. */
  floor: number;
  /** The questions whose answers were not acted on, because they fell below their gate. */
  gated: string[];
  model: string;
}

/** One answer, reduced to what a reader watching the arbitration needs. The full call is in the log; this is the shape that goes over the wire many times a minute, so it carries numbers rather than prose. */
export interface VerdictPoint {
  at: number;
  score: number;
  score_confidence: number;
  score_levels: number;
  cleared: number;
  supported: number;
  chosen: number | null;
  chosen_confidence: number;
  /** What this answer did to the floor, recomputed from the answer alone so that the series can be read without the incidents beside it. */
  multiplier: number;
  gated: string[];
}

export interface GatePoint {
  at: number;
  standstill: number;
  frozen: number;
  floor: number;
}

/** Everything the arbitration pane shows, assembled on request. */
export interface JevSnapshot {
  gates: {
    noul_threshold: number;
    act_confidence: number;
    score_swing: number;
    cleared_residue: number;
    supported_lift: number;
    chosen_gain: number;
    chosen_others: number;
  };
  enabled: boolean;
  calls: number;
  errors: number;
  throttled: number;
  held_on_evidence: number;
  input_tokens: number;
  output_tokens: number;
  reask_after_s: number;
  /** How many regions are being polled. Zero means the viewer is at the country level, where nothing is watched, no dispatch feed is read, and so nothing can be arbitrated. */
  watching_regions: number;
  /** How many dispatch feeds have been read at least once. Zero with a region watched means the first read has not come back yet. */
  feeds_read: number;
  /** How many cameras are on the fast period right now, whether because they are on screen or because this pane asked for them. */
  prioritised_cameras: number;
  /** Why the pane is empty, when it is. Each count is a narrower subset of the one above it, so the first that reads zero is the answer. */
  live_incidents: number;
  /** Records naming at least one camera this server serves. */
  linked_incidents: number;
  /** Of those, the ones whose code is about the road at all. */
  relevant_incidents: number;
  /** Of those, the ones naming at least one camera this server actually polls. Records are matched against every camera the source publishes, so a server running a single city sees many records whose cameras it does not hold, and those can never become askable here. */
  servable_incidents: number;
  /** Of those, the ones with at least one camera holding a picture, which is the last condition before a record is asked about. */
  ready_incidents: number;
  incidents: {
    id: string;
    code: string;
    label: string | null;
    location: string;
    cameras: number[];
    latest: VerdictPoint | null;
    history: VerdictPoint[];
  }[];
  cameras: { uid: number; latest: GatePoint | null; history: GatePoint[] }[];
}

export interface JevInfluence {
  /** Where the incident sits on the screen-worthiness rubric, between zero and the top level. */
  score: number;
  score_confidence: number;
  /** Probability that the incident has already cleared, and that the cameras support the report. Noul answers carry no confidence of their own. */
  cleared: number;
  supported: number;
  /** The camera the model would put on screen for this incident, which is not always one the record named. */
  chosen: number | null;
  chosen_confidence: number;
  /** What the floor was multiplied by, all gates applied. */
  multiplier: number;
  /** The questions whose answers were not acted on, because they fell below their gate. */
  gated: string[];
  model: string;
}

export interface CamerasResponse {
  /** The shortest poll period among the served sources. Kept for the status line; judge a single camera's staleness by its own `period_s`, because a wall serving Wisconsin at 30 s and Florida at 60 s would otherwise call every Florida tile stale twice as early as it should. */
  interval_s: number;
  started_at: number;
  cameras: CameraState[];
  /** How often the AMBIGUOUS_ZERO flag fires, over every poll since this process started. Nothing acts on the flag, so this is here to answer whether it is worth acting on. */
  ambiguous_zero: AmbiguousZeroStats;
}

export interface AmbiguousZeroStats {
  /** Frames that could be judged, which is every fresh frame with a difference against the one before it. A poll that returned identical bytes is not one. */
  polls: number;
  flagged: number;
  /** Flagged over polls for each hour of the day in local time, 0..23, or null for an hour nothing has been seen in. */
  by_hour: (number | null)[];
}

export interface Frame {
  k: number;
  ts: number;
  brightness: number | null;
  diff: number | null;
}

export interface FramesResponse {
  id: number;
  frames: Frame[];
}

export const ROAD_CLASSES = [
  'unclassified',
  'tertiary_link',
  'tertiary',
  'secondary_link',
  'secondary',
  'primary_link',
  'primary',
  'trunk_link',
  'trunk',
  'motorway_link',
  'motorway',
] as const;

export type RoadClass = (typeof ROAD_CLASSES)[number];

export interface RoadRegion {
  bbox: BBox;
  roads: Partial<Record<RoadClass, LatLon[][]>>;
}

export interface RoadsResponse {
  attribution: string;
  regions: Record<string, RoadRegion>;
}

/** State outlines arrive in GeoJSON order, unlike everything else here. */
export interface NationalState {
  name: string;
  polygons: LonLat[][];
}

export interface NationalSource {
  name: string;
  site_url: string;
  states: string[];
  has_video: boolean;
  attribution: string;
  license?: string | undefined;
  terms_url?: string | undefined;
  /** How often the wall fetches a camera on screen, and, where the agency refreshes faster, how often the one camera open in the panel is fetched. */
  poll_period_s?: number | undefined;
  focus_period_s?: number | null | undefined;
  cameras: { ids: number[]; lat: number[]; lon: number[] };
}

export interface NationalRegion {
  key: string;
  name: string;
  source: string;
  center: [number, number] | null;
  bbox: BBox | null;
  radius_km: number | null;
  built: boolean;
  served: boolean;
  cameras: number;
  catalogued?: number | undefined;
}

export interface NationalResponse {
  attribution: string;
  states: Record<string, NationalState>;
  covered_states: string[];
  sources: Record<string, NationalSource>;
  regions: NationalRegion[];
}

/** One computer-aided dispatch record. The type is the agency's own signal code, carried through exactly as published: the codes are not documented anywhere we have, so the wall shows the code rather than a label somebody guessed. */
export interface Incident {
  id: string;
  type: string;
  location: string;
  city: string | null;
  county: string | null;
  lat: number;
  lon: number;
  /** When the dispatch record was created, in seconds since the epoch, or null when the feed's date could not be read. */
  reported_at: number | null;
  remarks: string | null;
  /** Global ids of cameras within about 1.5 km, nearest first. Empty when there is none that close, which is most residential streets. */
  cameras: number[];
  /** What the agency's code means, when a code table is configured for that feed. Null when it is not, in which case show the raw code. */
  label: string | null;
  /** Whether this code describes something happening to a road rather than ordinary police business. This project's judgement, not the agency's. */
  road_relevant: boolean;
  /** Whether the code itself implies the road is blocked. Also this project's judgement. */
  implies_closure: boolean;
}

/** Three of these four are ordinary: `unconfigured` means this city's state has no dispatch feed, `idle` means it has one that nobody has asked for yet because the city is not being watched, and `ok` means the list is current. Only `unavailable` is a fault, and even then the rest of the wall carries on without it. */
export type IncidentStatus = 'ok' | 'unconfigured' | 'idle' | 'unavailable';

export interface IncidentsResponse {
  region: string;
  status: IncidentStatus;
  /** When the feed was last read, in seconds since the epoch, or null if it never has been. */
  fetched_at: number | null;
  /** Seconds between fetches, as the feed itself asks for. */
  period_s: number | null;
  attribution: string;
  source_name: string | null;
  incidents: Incident[];
}

export interface StreamResponse {
  id: number;
  url: string;
  direct: boolean;
}

/** FastAPI's error body, which the wall reads to tell an unpolled camera from one that publishes no stream. The port keeps the shape so the two servers are interchangeable. */
export interface ErrorResponse {
  detail: string;
}

export type ScoreDriver = 'movement' | 'incident' | 'queue' | 'still';

export interface ScoreTuning {
  anomaly_at_baseline: number;
  weight_anomaly: number;
  weight_spectacle: number;
  scale_amplifier_min: number;
  scale_amplifier_max: number;
}

export interface ScoreCamera {
  id: number;
  region: string;
  location: string;
  roadway: string;
  attention: number;
  diff: number | null;
  axes: AttentionAxes;
  driver: ScoreDriver;
}

export interface ScoreRegion {
  key: string;
  name: string;
  scored: number;
  top: { id: number; location: string; attention: number } | null;
  top5_mean: number;
  incident_floored: number;
  still: number;
}

export interface GraphPromotion {
  uid: number;
  because: number;
  reason: 'incident' | 'still' | 'movement';
}

export interface ScoresResponse {
  graph_promoted: GraphPromotion[];
  tuning: ScoreTuning;
  regions: ScoreRegion[];
  cameras: ScoreCamera[];
}

/** Board entries include the existing frame state so wall tiles can read cached snapshots without claiming visibility or viewer demand. */
export interface BoardCamera extends CameraState {
  region: string;
  region_name: string;
  state: string;
  location: string;
  roadway: string;
  attention: number;
  axes: AttentionAxes;
  driver: ScoreDriver;
  radar: boolean;
}

export interface BoardResponse {
  cameras: BoardCamera[];
  states: string[];
  regions: { key: string; name: string; state: string }[];
}

export type HighlightKind = 'incident' | 'stopped' | 'movement';

/** Event times are seconds since the epoch, matching camera frames and dispatch records. */
export interface Highlight {
  kind: HighlightKind;
  brief: string;
  camera: number;
  region: string;
  attention: number;
  at: number;
}

export interface HighlightsResponse {
  highlights: Highlight[];
}

/** One city's sky as its cameras see it. Brightness and contrast are medians over the cameras that returned a picture recently, so a single camera pointed at a floodlight does not speak for the city. */
export interface SkyRegion {
  key: string;
  name: string;
  lat: number;
  lon: number;
  /** Degrees above the horizon at the city's centre, right now. */
  sun_elevation: number;
  /** Median mean luma, 0..1, or null when no camera there has a recent picture. */
  brightness: number | null;
  /** Cameras with a recent picture. */
  cameras: number;
  /** Of those, how many have enough history to say what their usual contrast is, and how many are well below it. */
  contrast_known: number;
  contrast_low: number;
  /** How many of those cameras have turned white against their own recent pictures. */
  snow_known: number;
  snow_white: number;
  /** Set when enough of a city's cameras flattened together in daylight to suggest rain, fog or low cloud, or turned white together to suggest snow. Snow wins when both hold. A hint from pixels, never a forecast. */
  weather: 'murky' | 'snow' | null;
}

export interface SkyResponse {
  regions: SkyRegion[];
}

export type DiaryKind = HighlightKind | 'murky' | 'clear' | 'snow' | 'sunset' | 'sunrise';

/** One line in the day's diary. Text and numbers only: no picture is ever kept, because the imagery belongs to the state that published it. */
export interface DiaryEntry {
  ts: number;
  kind: DiaryKind;
  region: string;
  camera: number | null;
  brief: string;
  attention: number | null;
}

export interface DiaryResponse {
  /** The local day shown, as YYYY-MM-DD. */
  day: string;
  /** Every day that has a diary, newest first. */
  days: string[];
  entries: DiaryEntry[];
}

/** One minute of a city's pulse: the median frame difference across its cameras with a recent picture, and how many there were. */
export interface PulsePoint {
  ts: number;
  diff: number;
  n: number;
}

export interface PulseResponse {
  /** The local day the points belong to, as YYYY-MM-DD. */
  day: string;
  regions: Record<string, PulsePoint[]>;
}

/** What the optional vehicle detector counted in one camera's newest frame, for display. `off` when no detector is running, `pending` while a count is on its way, `none` when this frame could not be counted. */
export interface CountResponse {
  status: 'off' | 'pending' | 'none' | 'counted';
  vehicles?: number;
  by_class?: Record<string, number>;
  frame_ts?: number;
}

/** The camera open in the panel: how often its source refreshes the picture when that is faster than the wall's poll, and when the newest picture was taken. `period_s` is null for a source with no focus period. `poll_s` is how often the wall itself is fetching this camera right now, which is what a snapshot camera without a focus period is refreshed at. */
export interface LiveResponse {
  id: number;
  period_s: number | null;
  poll_s: number;
  ts: number | null;
}
