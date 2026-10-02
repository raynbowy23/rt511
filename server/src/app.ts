/** The service: region and camera state endpoints, snapshot ring buffer access, and the built wall.
 *
 * Every source publishes open, CORS-enabled HLS, so the browser plays each agency's stream itself and the API only says where it is. Nothing here fetches video. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphPromotion, CamerasResponse, ScoreCamera, ScoresResponse, Graph, Incident, IncidentsResponse, NationalResponse, RegionsResponse, RoadsResponse, Highlight, SkyRegion, SkyResponse, DiaryResponse, PulseResponse, CountResponse, LiveResponse } from '../../shared/src/index.js';
import { AttentionEngine, buildScalePriors, driver, summarizeRegions, TUNING } from './attention.js';
import { CORRIDOR, buildQueueIndex, promotionTrigger, selectPromotions, type HeldTrigger } from './corridor.js';
import { CadFeed, loadCadSources, type CameraPositions } from './cad.js';
import { Client } from './client.js';
import {
  catalogPath,
  sourceBlocks,
  round,
  centroid,
  graphPath,
  loadAadt,
  loadCatalog,
  loadGraph,
  loadNationalIndex,
  loadRegions,
  loadSources,
  loadStates,
  roadBackground,
  type CatalogCamera,
  type RegionRecord,
} from './config.js';
import { HttpError, Router, send } from './http.js';
import { DETECTOR, Detector, createDetect } from './detector.js';
import { Focus } from './focus.js';
import { Diary, DIARY } from './diary.js';
import { readSky } from './sky.js';
import { Pulse } from './pulse.js';
import { localDay } from './jsonlog.js';
import { JEV, JevArbiter, createAsk, createGateAsk, createReviewAsk, type CameraTelemetry, type GateCandidate, type Neighbor, type ReviewCandidate } from './jev.js';
import { Poller } from './poller.js';
import { RADAR, selectRadarAnchors } from './radar.js';
import { buildBoard } from './board.js';
import { selectHighlights } from './highlights.js';

/** Each source gets its own block of ids, far larger than any source's camera count. */
const UID_BLOCK = 10_000_000;

/** How many of a record's cameras the arbitration pane keeps awake, and how many it may keep awake in total.
 *
 * One camera with a picture is all a record needs to become askable, and two gives it a second chance when the first is a frozen feed. The overall cap keeps an open pane at well under one request a second however many records the feed lists. */
const JEV_WATCH_PER_INCIDENT = 2;
const JEV_WATCH_MAX = 24;
/** How far outside a city's own box an incident still counts as that city's, in degrees: about five kilometers. */
const INCIDENT_MARGIN = 0.05;

export interface AppOptions {
  root: string;
  /** Cities to serve. Empty means every city that has been built. */
  regionKeys: string[];
  /** Load every city with sparse national radar sampling until a viewer opens one and enables its normal tiers. */
  pollOnDemand?: boolean;
  cameras: string;
  concurrency: number;
  ring: number;
}

export interface App {
  router: Router;
  poller: Poller;
  clients: Map<string, Client>;
  /** Exposed for the report line and for tests; the wall never sees it. */
  jev: JevArbiter;
  stop: () => void;
}

function selectCameras(cams: CatalogCamera[], graph: Graph, spec: string): CatalogCamera[] {
  if (spec === 'all') return cams;
  if (spec === 'freeway') {
    const freeway = new Set(graph.cameras.filter((c) => c.is_freeway).map((c) => c.id));
    return cams.filter((c) => freeway.has(c.id));
  }
  const wanted = new Set(spec.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)));
  const chosen = cams.filter((c) => wanted.has(c.id));
  const missing = [...wanted].filter((id) => !chosen.some((c) => c.id === id));
  if (missing.length > 0) throw new Error(`cameras not in the selected regions: ${missing.sort((a, b) => a - b).join(', ')}`);
  return chosen;
}

export function createApp(options: AppOptions): App {
  const { root, regionKeys, cameras: spec, concurrency, ring } = options;
  const { userAgent, sources, disclaimer } = loadSources(root);
  const configured = loadRegions(root);

  const built = (region: RegionRecord): boolean => existsSync(graphPath(root, region.key));
  const regions: RegionRecord[] =
    regionKeys.length > 0
      ? regionKeys.map((key) => {
          const region = configured.get(key);
          if (!region) throw new Error(`unknown region ${key}. Known: ${[...configured.keys()].sort().join(', ')}`);
          return region;
        })
      : [...configured.values()].filter(built);
  if (regions.length === 0) {
    throw new Error('no cities have been built yet. Run `make setup` to build the cities listed in data/regions.json, or `make add-city CITY="Des Moines, IA"` for a new one.');
  }

  const graphs = new Map<string, Graph>();
  let selected: CatalogCamera[] = [];
  for (const region of regions) {
    const path = graphPath(root, region.key);
    if (!existsSync(path)) throw new Error(`no graph for ${region.key}, run \`rt511 build --region ${region.key}\` first`);
    const graph = loadGraph(path);
    const source = sources[region.source];
    if (!source) throw new Error(`unknown source ${region.source}`);
    // Every view points back to the official source, and published traffic counts carry a license of their own whose credit must be visible, so the count attribution travels with the camera attribution.
    const counts = loadAadt(root, region.key);
    Object.assign(graph.meta, { source: region.source, source_name: source.name, site_url: source.base_url, states: [...source.states], attribution: source.attribution, license: source.license, terms_url: source.terms_url, notice: source.notice, counts_attribution: counts?.attribution ?? '', counts_terms_url: counts?.terms_url ?? '', time_zone: region.time_zone ?? source.time_zone });
    graphs.set(region.key, graph);
    selected = selected.concat(selectCameras(loadCatalog(catalogPath(root, region.key)), graph, spec));
  }

  // Camera ids are unique only within one source, so each source gets a disjoint block of global ids, stable across runs.
  const ordinal = sourceBlocks(sources);
  const byId = new Map<number, CatalogCamera>();
  for (const camera of selected) {
    const block = ordinal.get(camera.source);
    if (block === undefined) throw new Error(`camera ${camera.id} names unknown source ${camera.source}`);
    byId.set(block * UID_BLOCK + camera.id, camera);
  }
  for (const graph of graphs.values()) renumber(graph, ordinal);

  const active = regions[0]?.key ?? '';
  const clients = new Map<string, Client>();
  for (const region of regions) {
    if (clients.has(region.source)) continue;
    const source = sources[region.source];
    if (!source) throw new Error(`unknown source ${region.source}`);
    clients.set(region.source, new Client(source, userAgent, concurrency));
  }
  const poller = new Poller(clients, byId, ring);
  const focus = new Focus((camera) => clients.get(camera.source));

  // What is worth looking at, scored from the cameras' own history, the traffic they carry and nearby incidents. Nothing the poller does depends on it.
  const attention = new AttentionEngine(buildScalePriors({ regions: regions.map((r) => r.key), graphs, root, uidBlock: UID_BLOCK }), join(root, 'out'));
  poller.onPoll = (slot, result) => {
    if (result === 'fresh') attention.observe(slot, result);
  };

  // The arbiter. With no key it is inert and every floor is exactly the deterministic one. The key is read here and passed once; nothing else in the process sees it.
  const jevKey = process.env.JEV_API?.trim();
  const jev = new JevArbiter(jevKey ? createAsk(jevKey) : null, join(root, 'out'), jevKey ? createGateAsk(jevKey) : null, jevKey ? createReviewAsk(jevKey) : null);
  attention.chosenQueue = (incident, uid, floor) => jev.chosenQueue(incident, uid, floor);
  attention.modulate = (incident, uid, deterministic) => jev.modulate(incident, uid, deterministic);
  attention.gate = (uid, now) => jev.gateFloor(uid, now);
  attention.review = (uid, now) => jev.reviewFactor(uid, now);
  // Which cameras the graphs place on a freeway, for the review's description of each one.
  const onFreeway = new Set<number>();
  for (const graph of graphs.values()) for (const camera of graph.cameras) if (camera.is_freeway) onFreeway.add(camera.id);
  console.log(jev.enabled ? 'jev arbitration on, incidents and still cameras will be asked about once each, and the leading cameras of each open city looked at again every few minutes' : 'no JEV_API, incidents keep their deterministic floor and still cameras keep none');

  // The vehicle detector the gate hands its still frames to. Optional and out of process, and looked for again once a minute so it can be started after the server.
  const detectorUrl = process.env.RT511_DETECTOR_URL?.trim() || DETECTOR.URL;
  const binding = createDetect(detectorUrl);
  const detector = new Detector(binding.detect, join(root, 'out'), binding.probe);
  detector.look();
  console.log(`looking for a vehicle detector on ${detectorUrl}; start one with \`uv run rt511 detect\``);
  const corridor = buildCorridor(regions.map((r) => r.key), graphs, byId);
  const promotionCorridor = buildCorridor(regions.map((r) => r.key), graphs, byId, true);
  const lastTriggered = new Map<number, HeldTrigger>();
  let graphPromoted: GraphPromotion[] = [];
  let graphRestatedAt = 0;

  const merged = mergeGraphs(regions.map((r) => graphs.get(r.key) as Graph));

  // The road background for the in-app map, loaded once at startup because the extracts are several megabytes of JSON.
  const roads = new Map<string, Record<string, unknown>>();
  for (const region of regions) {
    const background = roadBackground(join(root, 'data', `osm_${region.key}.json`));
    roads.set(region.key, background);
    if (Object.keys(background).length === 0) {
      console.warn(`no road extract for ${region.key}, the map will show only the camera graph`);
    }
  }

  // Dispatch feeds, one per state, fetched only while a city in that state is being watched. A state with no entry simply has no incidents.
  const cadSources = loadCadSources(root);
  const feeds = new Map<string, CadFeed>();
  const national = loadNationalIndex(root);
  const states = loadStates(root);
  if (Object.keys(national.sources).length === 0) console.warn('no national index, run `rt511 index` for the country map');

  // Incidents carry global camera ids, so the positions they are matched against are numbered the same way.
  for (const [key, source] of Object.entries(cadSources)) {
    const block = ordinal.get(key);
    const index = national.sources[key];
    const positions: CameraPositions =
      block === undefined || !index
        ? { ids: [], lat: [], lon: [] }
        : { ids: index.ids.map((id) => block * UID_BLOCK + id), lat: index.lat, lon: index.lon };
    if (positions.ids.length === 0) console.warn(`no camera positions for ${key}, incidents will carry no camera links`);
    feeds.set(key, new CadFeed(source, userAgent, positions));
  }

  const router = new Router();

  router.get('/api/regions', (): RegionsResponse => ({
    active,
    regions: regions.map((r) => {
      const source = sources[r.source];
      return {
        key: r.key,
        name: r.name,
        source: r.source,
        source_name: source?.name ?? r.source,
        site_url: source?.base_url ?? '',
        states: [...(source?.states ?? [])],
        attribution: source?.attribution ?? '',
        license: source?.license ?? '',
        terms_url: source?.terms_url ?? '',
        notice: source?.notice ?? '',
        bbox: [...r.bbox],
        cameras: selected.filter((c) => c.region === r.key).length,
      };
    }),
    disclaimer,
  }));

  /** Every served region at once by default. Site ids are region-prefixed so the union is safe. */
  router.get('/api/graph', ({ query }) => {
    const region = query.get('region');
    if (region === null) return merged;
    const graph = graphs.get(region);
    if (!graph) throw new HttpError(404, 'region not served');
    return graph;
  });

  /** Everything the country-level map needs in one call: state outlines, every camera position, and which regions exist, have been built, and are being polled right now. */
  router.get('/api/national', (): NationalResponse => {
    const served = new Set(regions.map((r) => r.key));
    const covered = new Set<string>();
    for (const source of Object.values(sources)) for (const state of source.states) covered.add(state);
    const sourceOut: NationalResponse['sources'] = {};
    for (const [key, source] of Object.entries(sources)) {
      sourceOut[key] = {
        name: source.name,
        site_url: source.base_url,
        states: [...source.states],
        has_video: source.has_video,
        attribution: source.attribution,
        license: source.license,
        terms_url: source.terms_url,
        poll_period_s: source.poll_period_s,
        focus_period_s: source.focus_period_s,
        cameras: national.sources[key] ?? { ids: [], lat: [], lon: [] },
      };
    }
    return {
      attribution: states.attribution,
      states: states.states,
      covered_states: [...covered].sort(),
      sources: sourceOut,
      regions: [...configured.values()].map((r) => ({
        key: r.key,
        name: r.name,
        source: r.source,
        center: centroid(r),
        bbox: [...r.bbox],
        radius_km: r.radius_km,
        built: existsSync(graphPath(root, r.key)),
        served: served.has(r.key),
        cataloged: cataloged(root, r.key),
        cameras: selected.filter((c) => c.region === r.key).length,
      })),
    };
  });

  /** Road polylines per highway class for the map view, from the cached OpenStreetMap extract, keyed by region. */
  router.get('/api/roads', ({ query }) => {
    const region = query.get('region');
    if (region !== null && !roads.has(region)) throw new HttpError(404, 'region not served');
    const keys = region !== null ? [region] : [...roads.keys()];
    const out: RoadsResponse['regions'] = {};
    for (const key of keys) {
      const bbox = regions.find((r) => r.key === key)?.bbox;
      out[key] = { bbox: [...(bbox as [number, number, number, number])], roads: roads.get(key) as never };
    }
    return { attribution: 'Road data © OpenStreetMap contributors (ODbL)', regions: out };
  });

  // Opening a city is what starts its cameras. A city nobody has asked about for IDLE_STOP_MS stops again and drops its frames.
  const IDLE_STOP_MS = 150_000;
  const lastAsked = new Map<string, number>();

  const followViewer = (asked: string | null): void => {
    const now = Date.now();
    if (asked !== null && graphs.has(asked)) {
      lastAsked.set(asked, now);
      poller.watch(asked);
    }
    if (!options.pollOnDemand) return;
    for (const key of poller.watchedRegions()) {
      if (now - (lastAsked.get(key) ?? 0) > IDLE_STOP_MS) poller.unwatch(key);
    }
  };

  /** Incidents near one city: its own box with a small margin rather than the whole state. */
  router.get('/api/incidents', async ({ query }) => {
    const key = query.get('region');
    if (key === null) throw new HttpError(400, 'region is required');
    const region = regions.find((r) => r.key === key);
    if (!region) throw new HttpError(404, 'region not served');
    const feed = feeds.get(region.source);
    const empty: IncidentsResponse = {
      region: key,
      status: 'unconfigured',
      fetched_at: null,
      period_s: null,
      attribution: '',
      source_name: null,
      incidents: [],
    };
    if (!feed) return empty;
    // Only fetch while this city is actually being watched: an idle server asks the state for nothing.
    const watching = poller.isWatching(key);
    if (watching) await feed.refresh();
    const [south, west, north, east] = region.bbox;
    return {
      region: key,
      status: feed.lastFetch === null ? (watching ? 'unavailable' : 'idle') : feed.healthy ? 'ok' : 'unavailable',
      fetched_at: feed.lastFetch,
      period_s: feed.source.poll_period_s,
      attribution: feed.source.attribution,
      source_name: feed.source.name,
      incidents: feed.within(south - INCIDENT_MARGIN, west - INCIDENT_MARGIN, north + INCIDENT_MARGIN, east + INCIDENT_MARGIN),
    } satisfies IncidentsResponse;
  });

  /** What the arbiter has been saying, for the pane that shows it. Reports answers already formed, so opening the pane causes no call to the model. */
  router.get('/api/jev', ({ query }) => {
    const live: Incident[] = [];
    for (const feed of feeds.values()) for (const incident of feed.current()) live.push(incident);
    // With the pane open, keep a bounded set of incident cameras on the fast period so that records actually become askable, since a camera nobody can see polls slowly.
    if (query.get('watch') === '1') {
      const wanted: number[] = [];
      for (const incident of live) {
        if (!incident.road_relevant && !incident.implies_closure) continue;
        // Filter before taking the nearest few, never after, because a record's closest cameras are often ones this server has not loaded.
        const servable = incident.cameras.filter((uid) => {
          const slot = poller.cameras.get(uid);
          return slot !== undefined && poller.isWatching(slot.camera.region);
        });
        for (const uid of servable.slice(0, JEV_WATCH_PER_INCIDENT)) {
          if (!wanted.includes(uid)) wanted.push(uid);
        }
        if (wanted.length >= JEV_WATCH_MAX) break;
      }
      poller.setPriority('pane', wanted.slice(0, JEV_WATCH_MAX));
    } else if (query.get('watch') === '0') {
      poller.setPriority('pane', []);
    }
    // A record is only asked about once one of its cameras has something to show, so the pane is told how many get that far.
    let feedsRead = 0;
    for (const feed of feeds.values()) if (feed.lastFetch !== null) feedsRead++;
    return jev.snapshot(
      live,
      (uid) => (poller.cameras.get(uid)?.latest?.diff ?? null) !== null,
      {
        watching: poller.watchedRegions().length,
        feedsRead,
        prioritized: poller.tierCounts().fast,
      },
      // Whether this server could ever see the record at all, since records are matched against every camera the source publishes.
      (uid) => {
        const slot = poller.cameras.get(uid);
        return slot !== undefined && poller.isWatching(slot.camera.region);
      },
    );
  });

  const scoredCameras = () => {
    // Incidents already in hand, indexed by the cameras they name. Never a fetch: asking for camera state must not make the server ask an agency for anything.
    const byCamera = new Map<number, Incident[]>();
    for (const feed of feeds.values()) {
      for (const incident of feed.current()) {
        for (const id of incident.cameras) {
          const list = byCamera.get(id);
          if (list) list.push(incident);
          else byCamera.set(id, [incident]);
        }
      }
    }
    const queue = buildQueueIndex(new Set([...byCamera.values()].flat()), corridor, byId, attention.gate);
    const cameras = poller.summaries(attention.scorer((id) => byCamera.get(id) ?? [], Date.now() / 1000, queue));
    return { byCamera, cameras };
  };

  const currentHighlights = (region: string | null): Highlight[] => {
    const { cameras, byCamera } = scoredCameras();
    const live = [...new Set([...byCamera.values()].flat())];
    const now = Date.now() / 1000;
    const verdicts = new Map(live.flatMap((incident) => {
      const verdict = jev.verdictFor(incident);
      return verdict ? [[incident.id, verdict] as const] : [];
    }));
    const gateTimes = new Map(cameras.flatMap((camera) => {
      const gate = jev.gateFloor(camera.id, now);
      return gate && gate.value > 0 ? [[camera.id, gate.at] as const] : [];
    }));
    return selectHighlights(cameras, byId, live, verdicts, gateTimes, now, region, corridor);
  };

  router.get('/api/highlights', ({ query }) => {
    const region = query.get('region');
    if (region !== null && !graphs.has(region)) throw new HttpError(404, 'region not served');
    return { highlights: currentHighlights(region) };
  });

  // The sky over every served city, from frames the poller already holds.
  const skyRegions = regions.map((region) => {
    const [lat, lon] = centroid(region);
    return { key: region.key, name: region.name, lat, lon };
  });
  const currentSky = (now = Date.now() / 1000): SkyRegion[] =>
    readSky(
      skyRegions,
      [...poller.cameras.values()].map((slot) => ({ region: slot.camera.region, lastTs: slot.latest?.ts ?? null, brightness: slot.latest?.brightness ?? null, contrast: slot.contrast, contrasts: slot.contrasts, white: slot.white, whites: slot.whites })),
      now,
    );
  router.get('/api/sky', (): SkyResponse => ({ regions: currentSky() }));

  // The diary and each city's pulse are recorded once a minute, from state the server already holds.
  const diary = new Diary(join(root, 'out'));
  const pulse = new Pulse(join(root, 'out'));
  const diaryTimer = setInterval(() => {
    const now = Date.now() / 1000;
    diary.note(currentHighlights(null), currentSky(now), now);
    pulse.record([...poller.cameras.values()].map((slot) => ({ region: slot.camera.region, lastTs: slot.latest?.ts ?? null, diff: slot.latest?.diff ?? null })), now);
  }, DIARY.EVERY_S * 1000);
  // The detector counts the one camera a viewer has open, for display only; the count never enters the attention score.
  router.get('/api/count/:id', ({ params }): CountResponse => {
    const slot = poller.cameras.get(Number(params.id));
    if (!slot) throw new HttpError(404, 'camera not polled');
    if (!detector.enabled) {
      detector.look();
      return { status: 'off' };
    }
    const evidence = detector.evidence(slot.uid, slot.latest);
    if (evidence === 'pending') return { status: 'pending' };
    if (!evidence) return { status: 'none' };
    return { status: 'counted', vehicles: evidence.count.vehicles, by_class: evidence.count.by_class, frame_ts: evidence.frameTs };
  });

  router.get('/api/pulse', (): PulseResponse => ({ day: localDay(Date.now() / 1000), regions: pulse.today() }));
  diaryTimer.unref();
  router.get('/api/diary', ({ query }): DiaryResponse => {
    const days = diary.days();
    const day = query.get('day') ?? days[0] ?? localDay(Date.now() / 1000);
    return { day, days, entries: diary.read(day) };
  });

  const restatePromotions = (now: number): void => {
    for (const [uid, trigger] of lastTriggered) if (now - trigger.at >= CORRIDOR.PROMOTE_HOLD_S) lastTriggered.delete(uid);
    graphPromoted = selectPromotions(lastTriggered, promotionCorridor, now).filter(({ uid }) => {
      const camera = byId.get(uid);
      return camera !== undefined;
    });
    graphRestatedAt = now;
    poller.setPriority('graph', graphPromoted.map(({ uid }) => uid), CORRIDOR.PROMOTE_HOLD_S);
  };

  const boardRegions = regions.map((region) => ({
    key: region.key,
    name: region.name,
    // Region keys carry the metro's state, which is more specific than a multi-state source's coverage list.
    state: region.key.split('-').at(-1)!.toUpperCase(),
  }));
  router.get('/api/board', ({ query }) => buildBoard(scoredCameras().cameras, byId, boardRegions, (uid) => poller.isRadar(uid), query.get('state'), query.get('region')));

  /** Radar runs without HTTP traffic. Its triggers share the global graph cap so viewer requests and national sampling cannot double the promotion budget. */
  const radarTick = (): void => {
    const now = Date.now() / 1000;
    if (options.pollOnDemand) {
      for (const key of poller.watchedRegions()) {
        if (Date.now() - (lastAsked.get(key) ?? 0) > IDLE_STOP_MS) poller.unwatch(key);
      }
    }
    const anchors = selectRadarAnchors(byId, new Set(poller.watchedRegions()), (uid) => attention.scalePrior(uid).prior, now - poller.started_at);
    poller.setRadar(anchors);
    const wanted = new Set(anchors);
    for (const state of scoredCameras().cameras) {
      if (!wanted.has(state.id)) continue;
      const trigger = promotionTrigger(state);
      if (trigger) lastTriggered.set(state.id, { ...trigger, at: now });
    }
    restatePromotions(now);
  };
  const radarTimer = setInterval(radarTick, RADAR.RADAR_TICK_S * 1000);
  radarTimer.unref();

  router.get('/api/scores', () => {
    const watched = poller.watchedRegions();
    const { cameras } = scoredCameras();
    const scored: ScoreCamera[] = cameras.flatMap((state) => {
      const camera = byId.get(state.id);
      if (!camera || !watched.includes(camera.region) || state.attention === null || state.axes === null) return [];
      return [{ id: state.id, region: camera.region, location: camera.location, roadway: camera.roadway, attention: state.attention, diff: state.diff, axes: state.axes, driver: driver(state.axes) }];
    });
    return {
      graph_promoted: Date.now() / 1000 - graphRestatedAt < CORRIDOR.PROMOTE_HOLD_S ? graphPromoted : [],
      tuning: {
        anomaly_at_baseline: TUNING.ANOMALY_AT_BASELINE,
        weight_anomaly: TUNING.WEIGHT_ANOMALY,
        weight_spectacle: TUNING.WEIGHT_SPECTACLE,
        scale_amplifier_min: TUNING.SCALE_AMPLIFIER_MIN,
        scale_amplifier_max: TUNING.SCALE_AMPLIFIER_MAX,
      },
      regions: summarizeRegions(watched.map((key) => ({ key, name: configured.get(key)?.name ?? key })), scored),
      cameras: watched.flatMap((key) => scored.filter((camera) => camera.region === key).sort((a, b) => b.attention - a.attention).slice(0, 15)),
    } satisfies ScoresResponse;
  });

  router.get('/api/cameras', ({ query }) => {
    const region = query.get('region');
    followViewer(options.pollOnDemand ? (region ?? null) : null);
    // Which cameras the viewer can actually see. Absent leaves the previous list alone; present, even empty, is a positive statement.
    const visible = query.get('visible');
    if (region !== null && visible !== null) {
      poller.setVisible(
        region,
        visible
          .split(',')
          .map((id) => Number(id.trim()))
          .filter((id) => Number.isFinite(id)),
      );
    }
    const { byCamera, cameras } = scoredCameras();
    const now = Date.now() / 1000;
    for (const state of cameras) {
      if (!state.region || !poller.isWatching(state.region)) continue;
      const trigger = promotionTrigger(state);
      if (trigger) lastTriggered.set(state.id, { ...trigger, at: now });
    }
    restatePromotions(now);
    attention.logRanking(cameras);
    // Asked about after the ranking, never before it: a verdict lands for the next poll rather than holding this response open.
    if (jev.enabled && byCamera.size > 0) {
      const telemetry = new Map<number, CameraTelemetry>();
      for (const state of cameras) {
        const camera = byId.get(state.id);
        if (!camera) continue;
        telemetry.set(state.id, {
          uid: state.id,
          roadway: camera.roadway,
          location: camera.location,
          lat: camera.lat,
          lon: camera.lon,
          diff: state.diff,
          activity: state.activity,
          baseline: state.axes?.baseline ?? null,
          baselineN: state.axes?.baseline_n ?? 0,
          ambiguousZero: state.axes?.ambiguous_zero ?? false,
          lastTs: state.last_ts,
        });
      }
      const seen = new Set<Incident>();
      for (const list of byCamera.values()) for (const incident of list) seen.add(incident);
      jev.consider([...seen], (id) => telemetry.get(id) ?? null, (id) => corridor.get(id) ?? []);
    }
    // Still cameras are asked about whether or not any incident names them. The detector counts them even without an arbiter, so the counts are logged for calibration.
    const candidates: GateCandidate[] = [];
    for (const state of cameras) {
      if (state.axes?.ambiguous_zero !== true) continue;
      const camera = byId.get(state.id);
      if (!camera) continue;
      const evidence = detector.evidence(state.id, poller.cameras.get(state.id)?.latest ?? null, now);
      // A count is on its way for this frame, so the arbiter waits a pass for it.
      if (evidence === 'pending' || !jev.enabled) continue;
      candidates.push({
        camera: {
          uid: state.id,
          roadway: camera.roadway,
          location: camera.location,
          lat: camera.lat,
          lon: camera.lon,
          diff: state.diff,
          activity: state.activity,
          baseline: state.axes.baseline,
          baselineN: state.axes.baseline_n,
          ambiguousZero: true,
          lastTs: state.last_ts,
        },
        neighbors: (corridor.get(state.id) ?? []).slice(0, JEV.MAX_NEIGHBORS),
        incidentNearby: byCamera.has(state.id),
        vehicles: evidence?.count ?? null,
      });
    }
    if (candidates.length > 0) jev.considerGate(candidates, now);
    // The review of the city the viewer has open, its leading cameras looked at together. Only cameras with a recent picture are offered.
    if (jev.enabled && region !== null && poller.isWatching(region)) {
      const leaders: ReviewCandidate[] = [];
      // Leaders by the fixed equation, not by the score the look has already moved, so the look never chooses its own shortlist.
      const equationOf = (item: (typeof cameras)[number]): number => item.axes?.equation ?? (item.attention as number);
      for (const state of [...cameras].filter((item) => item.region === region && item.attention !== null && item.diff !== null).sort((a, b) => equationOf(b) - equationOf(a))) {
        if (leaders.length >= JEV.REVIEW_TOP_K) break;
        const camera = byId.get(state.id);
        if (!camera || !state.axes || state.last_ts === null || now - state.last_ts > 3 * state.period_s) continue;
        leaders.push({
          camera: {
            uid: state.id,
            roadway: camera.roadway,
            location: camera.location,
            lat: camera.lat,
            lon: camera.lon,
            diff: state.diff,
            activity: state.activity,
            baseline: state.axes.baseline,
            baselineN: state.axes.baseline_n,
            ambiguousZero: state.axes.ambiguous_zero,
            lastTs: state.last_ts,
          },
          freeway: onFreeway.has(state.id),
          roadSize: state.axes.scale_prior,
          incident: state.axes.incident_floor > 0 ? state.axes.incident : null,
          queue: state.axes.queue_floor > 0,
          stoppedTraffic: (state.axes.gate?.floor ?? 0) > 0,
          equation: state.axes.equation ?? (state.attention as number),
        });
      }
      jev.considerReview(region, configured.get(region)?.name ?? region, leaders, now);
    }
    return { interval_s: poller.interval_s, started_at: poller.started_at, cameras, ambiguous_zero: attention.ambiguousZeroStats() } satisfies CamerasResponse;
  });

  const slotFor = (id: string) => {
    const slot = poller.cameras.get(Number(id));
    if (!slot) throw new HttpError(404, 'camera not polled');
    return slot;
  };

  router.get('/api/frames/:id', ({ params }) => {
    const slot = slotFor(params.id as string);
    return {
      id: Number(params.id),
      frames: slot.frames.map((frame, i) => ({
        k: i,
        ts: frame.ts,
        brightness: round(frame.brightness, 3),
        diff: frame.diff === null ? null : round(frame.diff, 4),
      })),
    };
  });

  /** The camera open in the panel. Asking keeps it on its source's focus period for another half minute, and the answer says how often a new picture can be expected and when the newest was taken, so the panel reloads only when there is something new. */
  router.get('/api/live/:id', ({ params }): LiveResponse => {
    const uid = Number(params.id);
    const slot = slotFor(params.id as string);
    // The camera in the panel is held on its source's own period. One claim per camera, so two viewers with different panels open do not cancel each other.
    poller.setPriority(`panel:${String(uid)}`, [uid]);
    const period = focus.claim(uid, slot.camera);
    const held = focus.frame(uid);
    const newest = slot.frames[slot.frames.length - 1] ?? null;
    // Whichever picture is newer, since the ordinary poll carries on beside the focus fetch and either may have the latest.
    const ts = Math.max(held?.ts ?? 0, newest?.ts ?? 0);
    return { id: uid, period_s: period, poll_s: round(poller.periodFor(slot), 0), ts: ts > 0 ? ts : null };
  });

  /** Frame k of the ring buffer. Negative k counts from the newest, so the default is the latest frame. `k=live` is the newest picture from either the focus fetch or the ring. */
  router.get('/api/snap/:id', ({ params, query, res }) => {
    const slot = slotFor(params.id as string);
    if (query.get('k') === 'live') {
      const held = focus.frame(slot.uid);
      const newest = slot.frames[slot.frames.length - 1];
      const frame = held && (!newest || held.ts >= newest.ts) ? held : newest;
      if (!frame) throw new HttpError(404, 'no frame yet');
      send(res, 200, frame.data, frame.content_type, { 'cache-control': 'no-store', 'x-frame-ts': String(frame.ts) });
      return;
    }
    if (slot.frames.length === 0) throw new HttpError(404, 'no frame yet');
    const raw = query.get('k');
    const asked = raw === null ? -1 : Number(raw);
    if (!Number.isInteger(asked)) throw new HttpError(404, 'frame index out of range');
    const index = asked < 0 ? slot.frames.length + asked : asked;
    const frame = slot.frames[index];
    if (!frame) throw new HttpError(404, 'frame index out of range');
    send(res, 200, frame.data, frame.content_type, { 'cache-control': 'no-store', 'x-frame-ts': String(frame.ts) });
  });

  /** Tells a camera this run is not polling apart from one with no published stream, because the caller handles them differently. */
  const cameraFor = (id: number): CatalogCamera => {
    const camera = byId.get(id);
    if (!camera) {
      let known = false;
      for (const graph of graphs.values()) if (graph.cameras.some((c) => c.id === id)) known = true;
      throw new HttpError(404, known ? 'camera is not being polled in this run' : 'unknown camera');
    }
    if (!camera.video_url) throw new HttpError(404, 'camera publishes no stream');
    return camera;
  };

  // The browser loads each open stream itself, so this only says where it is. Nothing is proxied.
  router.get('/api/stream/:id', ({ params }) => {
    const id = Number(params.id);
    const camera = cameraFor(id);
    return { id, url: camera.video_url, direct: true };
  });

  const dist = join(root, 'web', 'dist');
  if (existsSync(join(dist, 'index.html'))) {
    router.serveStatic(dist);
    console.log(`serving the wall from ${dist}`);
  } else {
    router.onMissingStatic(() => ({
      status: 503,
      type: 'text/plain; charset=utf-8',
      body:
        'The wall has not been built.\n\n    cd web && npm install && npm run build\n\n' +
        'The API is already up: try /api/national or /api/cameras.\n',
    }));
    console.warn('web/dist not built; the API is up but there is no interface. Run `npm install && npm run build` in web/.');
  }

  // What this run costs the agencies it reads, printed once a minute.
  const LOAD_EVERY_MS = 60_000;
  let lastRequests = 0;
  let lastBytes = 0;
  let lastAt = Date.now();
  const loadTimer = setInterval(() => {
    let requests = 0;
    let bytes = 0;
    for (const client of clients.values()) {
      requests += client.requests;
      bytes += client.bytes;
    }
    for (const feed of feeds.values()) requests += feed.requests;
    const seconds = (Date.now() - lastAt) / 1000;
    const tiers = poller.tierCounts();
    console.log(
      `load: ${((requests - lastRequests) / seconds).toFixed(2)} req/s, ` +
        `${(((bytes - lastBytes) / seconds) * 3600) / 1e6 | 0} MB/h, ` +
        `tiers fast ${tiers.fast} slow ${tiers.slow} radar ${tiers.radar} idle ${tiers.idle}`,
    );
    lastRequests = requests;
    lastBytes = bytes;
    lastAt = Date.now();
  }, LOAD_EVERY_MS);
  loadTimer.unref();

  poller.onStop = () => {
    clearInterval(radarTimer);
    clearInterval(loadTimer);
  };

  return {
    router,
    poller,
    clients,
    jev,
    stop: () => {
      clearInterval(loadTimer);
      clearInterval(diaryTimer);
      poller.stop();
      focus.stop();
    },
  };
}

/** The corridor around every camera, as the directed graph gives it rather than as a radius would.
 *
 * Upstream is the direction a queue grows, so the walk follows incoming edges backwards for up to CORRIDOR.MAX_UPSTREAM_HOPS and CORRIDOR.MAX_UPSTREAM_M of road distance; both bounds are needed because hops alone can run far through a ramp-dense interchange. Downstream and `nearby` are taken one hop only, because neither is a place a queue tail can be.
 *
 * Road distance is the point of doing this on the graph, since cameras close in a straight line may be on opposite carriageways or a crossing street.
 *
 * A `nearby` edge carries no traffic direction. The separate promotion lookup walks two hops on every side to request pictures without expanding queue inference or the candidates offered to Jev. */
export function buildCorridor(keys: string[], graphs: Map<string, Graph>, byId: Map<number, CatalogCamera>, promotion = false): Map<number, Neighbor[]> {
  const out = new Map<number, Neighbor[]>();
  const waveMs = (CORRIDOR.WAVE_SPEED_KMH * 1000) / 3600;
  for (const key of keys) {
    const graph = graphs.get(key);
    if (!graph) continue;
    const sites = new Map(graph.sites.map((site) => [site.id, site]));
    type Step = { id: string; length_m: number; tt_s: number };
    const upstream = new Map<string, Step[]>();
    const downstream = new Map<string, Step[]>();
    const beside = new Map<string, Step[]>();
    const link = (into: Map<string, Step[]>, from: string, step: Step): void => {
      const list = into.get(from);
      if (list) list.push(step);
      else into.set(from, [step]);
    };
    for (const edge of graph.edges) {
      if (!sites.has(edge.src) || !sites.has(edge.dst)) continue;
      const forward = { id: edge.dst, length_m: edge.length_m, tt_s: edge.tt_s };
      const backward = { id: edge.src, length_m: edge.length_m, tt_s: edge.tt_s };
      if (edge.kind === 'nearby') {
        link(beside, edge.dst, backward);
        link(beside, edge.src, forward);
        continue;
      }
      link(upstream, edge.dst, backward);
      link(downstream, edge.src, forward);
    }
    /** Breadth-first along one direction, keeping the shortest road distance to each site reached and never revisiting the site it started from. */
    const walk = (from: string, adjacency: Map<string, Step[]>, maxHops: number, maxMeters: number): Map<string, { hops: number; length_m: number; tt_s: number }> => {
      const reached = new Map<string, { hops: number; length_m: number; tt_s: number }>();
      let frontier = [{ id: from, hops: 0, length_m: 0, tt_s: 0 }];
      for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
        const next: typeof frontier = [];
        for (const at of frontier) {
          for (const step of adjacency.get(at.id) ?? []) {
            if (step.id === from) continue;
            const total = { hops: at.hops + 1, length_m: at.length_m + step.length_m, tt_s: at.tt_s + step.tt_s };
            if (total.length_m > maxMeters) continue;
            const held = reached.get(step.id);
            if (held && held.length_m <= total.length_m) continue;
            reached.set(step.id, total);
            next.push({ id: step.id, ...total });
          }
        }
        frontier = next;
      }
      return reached;
    };
    for (const site of graph.sites) {
      if (site.cameras.length === 0) continue;
      const found: Neighbor[] = [];
      for (const [adjacency, side, maxHops, maxMeters] of [
        [upstream, 'upstream', promotion ? CORRIDOR.PROMOTE_HOPS : CORRIDOR.MAX_UPSTREAM_HOPS, CORRIDOR.MAX_UPSTREAM_M],
        [downstream, 'downstream', promotion ? CORRIDOR.PROMOTE_HOPS : 1, Infinity],
        [beside, 'nearby', promotion ? CORRIDOR.PROMOTE_HOPS : 1, Infinity],
      ] as const) {
        for (const [id, reach] of walk(site.id, adjacency, maxHops, maxMeters)) {
          const other = sites.get(id);
          if (!other) continue;
          for (const uid of other.cameras) {
            const camera = byId.get(uid);
            if (!camera) continue;
            found.push({
              uid,
              roadway: camera.roadway,
              location: camera.location,
              side,
              length_m: reach.length_m,
              tt_s: reach.tt_s,
              hops: reach.hops,
              wave_s: side === 'upstream' ? reach.length_m / waveMs : null,
            });
          }
        }
      }
      for (const uid of site.cameras) out.set(uid, found.filter((neighbor) => neighbor.uid !== uid));
    }
  }
  return out;
}

/** Rewrites a region graph's camera ids into the global id space, so a client that fetches several regions at once never sees two different cameras wearing the same number. */
function renumber(graph: Graph, ordinal: Map<string, number>): void {
  const remap = new Map<number, number>();
  for (const camera of graph.cameras) {
    const block = ordinal.get(camera.source ?? '');
    if (block === undefined) continue;
    const next = block * UID_BLOCK + camera.id;
    remap.set(camera.id, next);
    camera.id = next;
  }
  for (const site of graph.sites) site.cameras = site.cameras.map((id) => remap.get(id) ?? id);
}

/** How many cameras this region's catalog holds, for a region that exists but is not being polled in this run. */
function cataloged(root: string, key: string): number {
  const path = catalogPath(root, key);
  if (!existsSync(path)) return 0;
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

function mergeGraphs(graphs: Graph[]): Graph {
  const first = graphs[0];
  if (!first) throw new Error('no regions selected');
  if (graphs.length === 1) return first;
  const unique = (values: (string | undefined)[]): string[] => [...new Set(values.filter((v): v is string => v !== undefined))].sort();
  return {
    meta: {
      region: graphs.map((g) => g.meta.region).join(','),
      region_name: graphs.map((g) => g.meta.region_name ?? '').join(' + '),
      source: unique(graphs.map((g) => g.meta.source)).join(','),
      source_name: unique(graphs.map((g) => g.meta.source_name)).join(' + '),
      site_url: unique(graphs.map((g) => g.meta.site_url)).length === 1 ? first.meta.site_url : undefined,
      states: unique(graphs.flatMap((g) => g.meta.states ?? [])),
      attribution: unique(graphs.map((g) => g.meta.attribution)).join(' · '),
      regions: graphs.map((g) => ({
        region: g.meta.region,
        region_name: g.meta.region_name,
        source: g.meta.source,
        source_name: g.meta.source_name,
        site_url: g.meta.site_url,
        states: g.meta.states,
        attribution: g.meta.attribution,
        license: g.meta.license,
        terms_url: g.meta.terms_url,
        notice: g.meta.notice,
        counts_attribution: g.meta.counts_attribution,
        counts_terms_url: g.meta.counts_terms_url,
        time_zone: g.meta.time_zone,
        bbox: g.meta.bbox,
      })),
      sites: graphs.reduce((total, g) => total + (g.meta.sites ?? 0), 0),
      cameras: graphs.reduce((total, g) => total + (g.meta.cameras ?? 0), 0),
      edges: graphs.reduce((total, g) => total + (g.meta.edges ?? 0), 0),
      report: { edge_kinds: sumKinds(graphs) },
    },
    sites: graphs.flatMap((g) => g.sites),
    cameras: graphs.flatMap((g) => g.cameras),
    edges: graphs.flatMap((g) => g.edges),
  };
}

function sumKinds(graphs: Graph[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const graph of graphs) {
    for (const [kind, count] of Object.entries(graph.meta.report?.edge_kinds ?? {})) out[kind] = (out[kind] ?? 0) + count;
  }
  return out;
}

