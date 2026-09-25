import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  getCameras,
  getGraph,
  getIncidents,
  getNational,
  getRegions,
  type CameraState,
  type Graph,
  type NationalResponse,
  type Incident,
  type IncidentsResponse,
  type RegionMeta,
} from './api';
import { ScoresPane } from './components/ScoresPane';
import { CameraPanel } from './components/CameraPanel';
import { CitySwitcher, type City } from './components/CitySwitcher';
import { Footer, type Credits } from './components/Footer';
import { IncidentCard } from './components/IncidentCard';
import { MinimapPane, NationalPane, RegionMapPane } from './components/Panes';
import { Landing } from './components/Landing';
import { DOCK_DEFAULT, Splitter } from './components/Splitter';
import { TopBar, type Crumb } from './components/TopBar';
import { Board } from './components/Board';
import { Wall } from './components/Wall';
import { Highlights } from './components/Highlights';
import { Diary } from './components/Diary';
import { RelayHud, RoadTripPicker, TripHud } from './components/RoadTrip';
import { planTrips, RoadTrip, type Trip } from './roadtrip';
import { pickRelay, type RelayCity, type RelayPick } from './sunrelay';
import { Topology } from './graph';
import { useTour } from './hooks/useTour';
import { useWallRanking } from './hooks/useWallRanking';

/** Three levels: the country, one region's map or wall, and a camera inside it. */
type Level = 'home' | 'national' | 'map' | 'wall' | 'board';

const POLL_MS = 10_000;
/** The dispatch feed refreshes every two minutes and the server caches it, so asking once a minute is as fresh as it can be without being pointless. */
const INCIDENT_POLL_MS = 60_000;
const RERANK_MS = 20_000;
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 30_000;
const DOCK_KEY = 'rt511.dock-width';

interface Boot {
  graph: Graph;
  national: NationalResponse | null;
  regions: RegionMeta[];
  attribution: string;
  disclaimer: string;
}

interface Poll {
  states: CameraState[];
  intervalS: number;
  ok: boolean;
  tick: number;
}

export function App(): ReactElement {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [poll, setPoll] = useState<Poll>({ states: [], intervalS: 60, ok: false, tick: 0 });
  const [level, setLevel] = useState<Level>(() => {
    const view = new URLSearchParams(window.location.hash.slice(1)).get('view');
    return view === 'board' ? 'board' : view === 'national' ? 'national' : 'home';
  });
  const [region, setRegion] = useState<string | null>(null);
  const [cameraId, setCameraId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dockWidth, setDockWidth] = useState(() => readDockWidth());
  /** The cameras the wall can actually see, restated on every poll. A ref rather than state: it changes on every scroll and nothing renders from it. */
  const visibleCameras = useRef<number[]>([]);
  /** The stage, so a change of view can restart its fade-in. */
  const stageRef = useRef<HTMLDivElement>(null);
  const [incidents, setIncidents] = useState<IncidentsResponse | null>(null);
  const [openIncident, setOpenIncident] = useState<string | null>(null);
  const [arbiterOpen, setArbiterOpen] = useState(() => readArbiterOpen());

  // Loads the graph, the national index and the region list, retrying with a widening gap so an unattended screen recovers from a backend restart on its own. The cancel flag is what keeps React's doubled development mount from running two retry chains.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const attempt = async (retryMs: number): Promise<void> => {
      const [regions, graph, national] = await Promise.all([getRegions(), getGraph(), getNational()]);
      if (cancelled) return;
      if (!graph) {
        setPoll((current) => ({ ...current, ok: false }));
        timer = window.setTimeout(() => void attempt(Math.min(RETRY_MAX_MS, retryMs * 2)), retryMs);
        return;
      }
      const fallback = regions?.regions.find((r) => r.key === regions.active) ?? regions?.regions[0];
      const meta: RegionMeta[] =
        graph.meta.regions ?? regions?.regions.map((r) => ({ region: r.key, region_name: r.name, source: r.source, source_name: r.source_name, site_url: r.site_url, states: r.states, attribution: r.attribution, license: r.license, terms_url: r.terms_url, notice: r.notice })) ?? [graph.meta];
      const credits = [graph.meta.attribution ?? fallback?.attribution, national?.attribution].filter(Boolean).join(' · ');
      setBoot({ graph, national, regions: meta, attribution: credits, disclaimer: regions?.disclaimer ?? DISCLAIMER_FALLBACK });
    };
    void attempt(RETRY_MS);
    return () => {
      cancelled = true;
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, []);

  const topology = useMemo(() => (boot ? new Topology(boot.graph) : null), [boot]);

  const statesById = useMemo(() => new Map(poll.states.map((state) => [state.id, state])), [poll.states]);
  const camera = cameraId === null ? null : topology?.cameras.get(cameraId) ?? null;
  const activeSite = camera?.site ?? null;

  const promote = useCallback(
    (id: number, fromTour = false) => {
      setCameraId((current) => (current === id ? current : id));
      if (!fromTour) tourRef.current?.follow(id);
    },
    [],
  );

  const tour = useTour(topology, (next) => promote(next.id, true));
  const tourRef = useRef(tour);
  tourRef.current = tour;

  // Road trips: every numbered route in the current city, driven camera by camera in order. The runner is a timer like the tour, so it lives outside React and reports each stop back through state.
  const trips = useMemo(() => (topology && region ? planTrips(topology, region) : []), [topology, region]);
  const tripsRef = useRef(trips);
  tripsRef.current = trips;
  const [trip, setTrip] = useState<{ trip: Trip; index: number } | null>(null);
  const [tripPicker, setTripPicker] = useState(false);
  const roadTrip = useMemo(
    () =>
      new RoadTrip(
        (current, index) => {
          setTrip({ trip: current, index });
          promote(current.stops[index]!.camera.id, true);
        },
        // At the end of the road, drive the same route back if it runs the other way.
        (ended) => tripsRef.current.find((other) => other.route === ended.route && other.id !== ended.id) ?? null,
      ),
    [promote],
  );
  useEffect(() => () => roadTrip.stop(), [roadTrip]);
  const stopTrip = useCallback(() => {
    roadTrip.stop();
    setTrip(null);
  }, [roadTrip]);
  const startTrip = useCallback(
    (next: Trip) => {
      tour.stop();
      setTripPicker(false);
      setLevel((current) => (current === 'home' || current === 'national' || current === 'board' ? 'wall' : current));
      // The trip is watched in the camera panel at the top of the page, so the page goes there rather than following the tiles.
      window.scrollTo({ top: 0, behavior: 'smooth' });
      roadTrip.start(next);
    },
    [roadTrip, tour],
  );
  // A trip belongs to the city it was planned in.
  useEffect(() => {
    stopTrip();
    setTripPicker(false);
  }, [region, stopTrip]);

  // The sun relay: whichever city the sun is setting over, handing off westward through the evening. It chooses the city itself, so anything the viewer chooses by hand ends it.
  const [relay, setRelay] = useState<RelayPick | null>(null);
  const [relayNow, setRelayNow] = useState(() => Date.now() / 1000);
  const relayCities: RelayCity[] = useMemo(
    () =>
      (boot?.regions ?? []).flatMap((meta) => {
        const box = meta.bbox;
        return box ? [{ key: meta.region, name: meta.region_name ?? meta.region, lat: (box[0] + box[2]) / 2, lon: (box[1] + box[3]) / 2 }] : [];
      }),
    [boot],
  );
  const stopRelay = useCallback(() => setRelay(null), []);
  const startRelay = useCallback(() => {
    tour.stop();
    roadTrip.stop();
    setTrip(null);
    setTripPicker(false);
    const now = Date.now() / 1000;
    setRelayNow(now);
    setRelay(pickRelay(relayCities, now));
  }, [tour, roadTrip, relayCities]);

  const openCamera = useCallback(
    (id: number) => {
      tour.stop();
      stopTrip();
      stopRelay();
      promote(id);
    },
    [promote, tour, stopTrip, stopRelay],
  );

  const closeCamera = useCallback(() => {
    tour.stop();
    stopTrip();
    stopRelay();
    setCameraId(null);
    setExpanded(false);
  }, [tour, stopTrip, stopRelay]);

  const openRegion = useCallback((key: string) => {
    setRelay(null);
    setRegion(key);
    setLevel('map');
  }, []);

  // Every half minute the relay asks where the sun is and moves to that city's wall when the answer changes.
  const relayOn = relay !== null;
  useEffect(() => {
    if (!relayOn) return;
    const tick = (): void => {
      const now = Date.now() / 1000;
      setRelayNow(now);
      setRelay(pickRelay(relayCities, now));
    };
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [relayOn, relayCities]);
  const relayCity = relay?.city.key ?? null;
  useEffect(() => {
    if (!relayCity) return;
    setRegion(relayCity);
    setLevel('wall');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [relayCity]);
  // Within the city, the camera panel steps through its five most interesting cameras, so the relay shows the sunset rather than one fixed view of it.
  const statesRef = useRef(poll.states);
  statesRef.current = poll.states;
  useEffect(() => {
    if (!relayCity) return;
    let turn = 0;
    const show = (): void => {
      const best = statesRef.current
        .filter((state) => state.region === relayCity && state.frames > 0)
        .sort((a, b) => (b.attention ?? 0) - (a.attention ?? 0))
        .slice(0, 5);
      const pick = best[turn % Math.max(1, best.length)];
      if (pick) promote(pick.id, true);
      turn++;
    };
    const first = window.setTimeout(show, 4000);
    const timer = window.setInterval(show, 20_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [relayCity, promote]);

  const [diaryOpen, setDiaryOpen] = useState(false);
  const closeDiary = useCallback(() => setDiaryOpen(false), []);

  const goNational = useCallback(() => {
    setRelay(null);
    setCameraId(null);
    setExpanded(false);
    setLevel('national');
  }, []);

  // Polls the camera state and hands the same snapshot to every view that needs it.
  useEffect(() => {
    if (!boot || level === 'board' || level === 'home') return;
    let cancelled = false;
    const run = async (): Promise<void> => {
      // Naming the city keeps its cameras polled on a server that was started without one. At the country level nothing is named, so nothing is polled.
      // The cameras on screen go with the poll: the server polls those at the source's own rate and lets the rest of the city tick over slowly. At the country level nothing is named and nothing is polled.
      const state = await getCameras(level === 'national' ? null : region, level === 'wall' ? visibleCameras.current : []);
      if (cancelled) return;
      if (!state) {
        setPoll((current) => ({ ...current, ok: false }));
        return;
      }
      setPoll((current) => ({ states: state.cameras, intervalS: state.interval_s, ok: true, tick: current.tick + 1 }));
    };
    void run();
    const timer = window.setInterval(() => void run(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [boot, level, region]);

  useEffect(() => {
    if (!boot || level === 'home' || level === 'national' || level === 'board' || !region) {
      setIncidents(null);
      return;
    }
    let cancelled = false;
    let retry = 0;
    const run = async (): Promise<void> => {
      const next = await getIncidents(region);
      if (cancelled) return;
      setIncidents(next);
      // `idle` means the server has not read the feed because this city was not being watched yet, which is the ordinary state for the first second or two after opening one. Ask again shortly rather than leaving the map blank for a minute.
      if (next?.status === 'idle') retry = window.setTimeout(() => void run(), 5000);
    };
    void run();
    const timer = window.setInterval(() => void run(), INCIDENT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (retry !== 0) window.clearTimeout(retry);
    };
  }, [boot, level, region]);

  // An incident card belongs to the city it was opened in.
  useEffect(() => {
    setOpenIncident(null);
  }, [region, level]);

  // The fragment is read once, after the data is in, so a named camera or region can be resolved against it.
  const applied = useRef(false);
  const pendingTrip = useRef<string | null>(null);
  const pendingRelay = useRef(false);
  useEffect(() => {
    if (!pendingRelay.current || relayCities.length === 0) return;
    pendingRelay.current = false;
    startRelay();
  }, [relayCities, startRelay]);
  useEffect(() => {
    if (!pendingTrip.current || trips.length === 0) return;
    const named = trips.find((candidate) => candidate.id === pendingTrip.current);
    pendingTrip.current = null;
    if (named) startTrip(named);
  }, [trips, startTrip]);
  useEffect(() => {
    if (!boot || !topology || applied.current) return;
    applied.current = true;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const asked = hash.get('region');
    const startRegion = asked && boot.regions.some((r) => r.region === asked) ? asked : null;
    const startCamera = Number(hash.get('cam'));
    const hasCamera = Number.isFinite(startCamera) && topology.cameras.has(startCamera);
    if (hasCamera) setCameraId(startCamera);
    // One decision, not two: the fragment's region, else the region the named camera belongs to, else the first one served. A separate effect filling in the default would race this one and win, because neither sees the other's state until the next render.
    const site = hasCamera ? topology.cameras.get(startCamera)?.site ?? null : null;
    const owner = site ? site.slice(0, site.indexOf(':')) : null;
    setRegion(startRegion ?? owner ?? boot.regions[0]?.region ?? null);
    if (hash.has('tour')) tour.start(hasCamera ? startCamera : undefined);
    // A trip named in the fragment resumes once the city's trips are planned, which happens on the render after the region is set.
    const askedTrip = hash.get('trip');
    if (askedTrip) pendingTrip.current = askedTrip;
    if (hash.has('relay')) pendingRelay.current = true;
    const view = hash.get('view');
    // A camera or a region named in the fragment implies the region level even when no view is given.
    setLevel(view === 'board' ? 'board' : view === 'wall' ? 'wall' : view === 'map' ? 'map' : view === 'national' ? 'national' : view === 'home' ? 'home' : startRegion || hasCamera ? 'map' : 'home');
  }, [boot, topology, tour]);

  /** Keeps the fragment pointed at the current level so a screen can be restored to it. replaceState rather than a hash assignment, which would otherwise pile up history entries as the tour walks a corridor. */
  useEffect(() => {
    if (!boot) return;
    const shown: Level = boot.national ? level : level === 'national' || level === 'home' ? 'map' : level;
    const params: string[] = [`view=${shown}`];
    if (shown !== 'home' && shown !== 'national' && shown !== 'board' && region) params.push(`region=${region}`);
    if (cameraId !== null) params.push(`cam=${cameraId}`);
    if (tour.running) params.push('tour');
    if (trip) params.push(`trip=${encodeURIComponent(trip.trip.id)}`);
    if (relay) params.push('relay');
    history.replaceState(null, '', `#${params.join('&')}`);
    document.body.dataset.view = shown;
    document.body.classList.toggle('is-touring', tour.running);
  }, [boot, level, region, cameraId, tour.running, trip, relay]);

  const step = useCallback(
    (direction: 'down' | 'up') => {
      if (cameraId === null || !topology) return;
      const next = topology.hop(cameraId, direction);
      if (next) promote(next.camera.id);
    },
    [cameraId, topology, promote],
  );

  // One listener for the whole application, reading the current state through a ref so it is bound once rather than on every render.
  const keyState = useRef({ level, cameraId, expanded, tour, region, boot, step, openRegion, goNational, closeCamera, stopTrip, stopRelay });
  keyState.current = { level, cameraId, expanded, tour, region, boot, step, openRegion, goNational, closeCamera, stopTrip, stopRelay };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // The replay slider owns the arrow keys while it has focus, otherwise scrubbing and stepping along the graph fight each other.
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return;
      // Space and Enter belong to whatever is focused: a button, a link, or the city menu's summary. Claiming Space globally meant that opening the menu from the keyboard started the corridor tour instead.
      if ((event.key === ' ' || event.key === 'Enter') && target?.closest('button, summary, a[href], select, textarea')) return;
      const current = keyState.current;
      switch (event.key) {
        case ' ':
          event.preventDefault();
          current.stopTrip();
          current.stopRelay();
          current.tour.toggle(current.cameraId ?? undefined);
          break;
        case 'Escape':
          // Escape steps up one level at a time: out of expanded, then out of the camera, then out of the region.
          if (current.expanded) setExpanded(false);
          else if (current.cameraId !== null) current.closeCamera();
          else if (current.level !== 'national' && current.level !== 'home') current.goNational();
          break;
        case 'f':
        case 'F':
          if (current.cameraId !== null) setExpanded((value) => !value);
          break;
        case 'm':
        case 'M':
          // At the country level there is no wall to toggle, so M steps down into the first region this run is polling.
          if (current.level === 'national' || current.level === 'home') {
            const first = current.region ?? current.boot?.regions[0]?.region;
            if (first) current.openRegion(first);
          } else {
            setLevel((value) => (value === 'wall' ? 'map' : 'wall'));
          }
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          current.step('down');
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          current.step('up');
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const wallCameras = useMemo(() => {
    if (!topology) return [];
    // Tiles come from the poll state rather than the graph: the backend serves frames for the cameras it is polling and 404s for the rest, and a wall of permanently blank tiles would look broken rather than calm.
    const out = [];
    for (const state of poll.states) {
      const item = topology.cameras.get(state.id);
      if (!item) continue;
      if (region !== null && item.region !== undefined && item.region !== region) continue;
      out.push(item);
    }
    return out;
  }, [topology, poll.states, region]);

  const ranks = useWallRanking(wallCameras, statesById, RERANK_MS);

  const scope = level === 'home' || level === 'national' || level === 'board' || region === null ? poll.states : poll.states.filter((state) => state.region === region);
  const withFrames = scope.filter((state) => state.frames > 0).length;
  const status = poll.ok ? `${withFrames} of ${scope.length} cameras live · ${Math.round(poll.intervalS)}s snapshots` : 'backend unreachable, retrying';

  // The strip lists the cities this server can show, with the centre the national index carries so "nearest" is a computation.
  const cities: City[] = useMemo(() => {
    if (!boot) return [];
    const centres = new Map((boot.national?.regions ?? []).map((r) => [r.key, r.center]));
    return boot.regions.map((meta) => ({
      key: meta.region,
      name: meta.region_name ?? meta.region,
      center: centres.get(meta.region) ?? null,
      served: true,
    }));
  }, [boot]);

  const credits: Credits = useMemo(
    () => ({
      // One line per agency whose cameras are being served, deduplicated: eighteen cities run on seven agencies.
      cameras: [...new Map((boot?.regions ?? []).filter((r) => Boolean(r.attribution)).map((r) => [r.attribution as string, { attribution: r.attribution as string, license: r.license ?? '', terms_url: r.terms_url ?? '', notice: r.notice ?? '' }])).values()].sort((a, b) => a.attribution.localeCompare(b.attribution)),
      counts: [...new Map((boot?.regions ?? []).filter((r) => Boolean(r.counts_attribution)).map((r) => [r.counts_attribution as string, { attribution: r.counts_attribution as string, terms_url: r.counts_terms_url ?? '' }])).values()],
      states: boot?.national?.attribution ?? '',
      services: Object.values(boot?.national?.sources ?? {}).flatMap((source) =>
        source.states.map((code) => ({ name: boot?.national?.states[code]?.name ?? code, site_url: source.site_url })),
      ).sort((a, b) => a.name.localeCompare(b.name)),
    }),
    [boot],
  );

  const citySource = level === 'home' || level === 'national' || level === 'board' ? undefined : boot?.regions.find((r) => r.region === region);
  const cameraSource = boot?.regions.find((r) => r.region === camera?.region || (camera?.source !== undefined && r.source === camera.source));
  const regionName = boot?.regions.find((r) => r.region === region)?.region_name ?? region ?? 'region';
  const crumbs: Crumb[] = [];
  if (level === 'home') crumbs.push({ label: 'Welcome' });
  else if (boot?.national) crumbs.push({ label: 'United States', go: level === 'national' ? undefined : goNational });
  else crumbs.push({ label: boot?.graph.meta.region_name ?? 'rt511' });
  if (level === 'board') crumbs.push({ label: 'National board' });
  if (level !== 'home' && level !== 'national' && level !== 'board') {
    crumbs.push({ label: regionName, go: camera ? closeCamera : undefined });
    if (camera) crumbs.push({ label: camera.location });
  }

  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const liveIncidents: Incident[] = incidents?.status === 'ok' ? incidents.incidents : [];
  const shownIncident = liveIncidents.find((item) => item.id === openIncident) ?? null;
  /** The incidents within a kilometre and a half of the camera being watched, which is the same radius the server used to attach cameras to incidents. */
  const nearbyIncidents = cameraId === null ? [] : liveIncidents.filter((item) => item.cameras.includes(cameraId));

  const footerContext =
    level === 'home' ? `${plural(cities.length, 'city', 'cities')} ready to watch` : level === 'board' ? 'National top 30' : level === 'national'
      ? `${plural(cities.length, 'city', 'cities')} · ${plural(poll.states.length, 'camera', 'cameras')} polled`
      : [
          regionName,
          `${plural(scope.length, 'camera', 'cameras')} polled`,
          // Only when there are any: a city with a quiet night, or one whose state publishes no dispatch feed, says nothing at all rather than "0 incidents".
          liveIncidents.length > 0 ? `${plural(liveIncidents.length, 'live incident', 'live incidents')}` : null,
          `${plural(cities.length, 'city', 'cities')} available`,
        ]
          .filter(Boolean)
          .join(' · ');

  const commitDock = useCallback((width: number) => {
    setDockWidth(width);
    try {
      window.localStorage.setItem(DOCK_KEY, String(width));
    } catch {
      // Private windows and blocked site data both throw here; the layout still works, it just will not be remembered.
    }
  }, []);

  // A change of view fades the new one in. Restarted by hand, because the class is already on the element after the first change and a class that does not change does not replay its animation.
  const previousLevel = useRef(level);
  useEffect(() => {
    const element = stageRef.current;
    const from = previousLevel.current;
    previousLevel.current = level;
    if (!element) return;
    element.classList.remove('is-entering', 'is-arriving');
    void element.offsetWidth;
    // Coming into a city from the country map carries on that map's zoom rather than just fading.
    if (from === 'national' && (level === 'map' || level === 'wall')) element.classList.add('is-arriving');
    element.classList.add('is-entering');
  }, [level]);

  if (!boot) {
    return (
      <>
        <TopBar crumbs={[{ label: 'rt511' }]} status={status} ok={poll.ok} level="national" touring={false} onView={(next) => setLevel(next)} onToggleTour={() => undefined} />
        <div className="booting">waiting for the backend</div>
      </>
    );
  }

  // A backend without the national index has no country level to show, so the landing level falls back to the region rather than leaving an empty stage.
  const effectiveLevel: Level = boot.national ? level : level === 'national' || level === 'home' ? 'map' : level;
  const cameraOpen = camera !== null;

  return (
    <>
      <TopBar
        crumbs={crumbs}
        status={status}
        ok={poll.ok}
        level={effectiveLevel}
        touring={tour.running}
        onHome={() => {
          tour.stop();
          setCameraId(null);
          setLevel('home');
        }}
        onView={(next) => {
          // Leaving for the board stops whatever was walking the wall, since the board is the whole country and has no wall to walk.
          if (next === 'board') {
            tour.stop();
            setCameraId(null);
          }
          if (next === 'national') setCameraId(null);
          setLevel(next);
        }}
        onToggleTour={() => {
          stopTrip();
          stopRelay();
          tour.toggle(cameraId ?? undefined);
        }}
        relayOn={relay !== null}
        onRelay={() => (relay ? stopRelay() : startRelay())}
        tripOn={trip !== null || tripPicker}
        onRoadTrip={() => {
          stopRelay();
          if (trip) stopTrip();
          else setTripPicker((open) => !open);
        }}
        diaryOpen={diaryOpen}
        onDiary={() => setDiaryOpen((open) => !open)}
      />
      {tripPicker && <RoadTripPicker trips={trips} onPick={startTrip} onClose={() => setTripPicker(false)} />}
      {diaryOpen && (
        <Diary
          regionName={(key) => boot.regions.find((meta) => meta.region === key)?.region_name ?? key}
          onCamera={(id, key) => { openRegion(key); openCamera(id); }}
          onRegion={openRegion}
          onClose={closeDiary}
        />
      )}
      <div
        ref={stageRef}
        className={`stage${cameraOpen ? ' has-camera' : ''}${arbiterOpen ? ' has-arbiter' : ''}`}
        data-level={effectiveLevel}
        style={{ '--dock-w': `${dockWidth}px` } as React.CSSProperties}
      >
        {boot.national && effectiveLevel === 'home' && (
          <Landing
            national={boot.national}
            disclaimer={boot.disclaimer}
            onMap={goNational}
            onBoard={() => setLevel('board')}
            onRelay={startRelay}
          />
        )}
        {boot.national && (
          <NationalPane data={boot.national} visible={effectiveLevel === 'national'} states={poll.states} onRegion={openRegion} />
        )}
        <RegionMapPane
          graph={boot.graph}
          visible={effectiveLevel === 'map'}
          region={region}
          states={statesById}
          activeSite={activeSite}
          incidents={liveIncidents}
          activeIncident={openIncident}
          onCamera={openCamera}
          onIncident={setOpenIncident}
        >
          <CitySwitcher cities={cities} current={region} onSelect={openRegion} />
          {shownIncident && (
            <IncidentCard
              incident={shownIncident}
              cameras={topology?.cameras ?? new Map()}
              attribution={incidents?.attribution ?? ''}
              onCamera={(id) => {
                setOpenIncident(null);
                openCamera(id);
              }}
              onClose={() => setOpenIncident(null)}
            />
          )}
        </RegionMapPane>
        <Splitter width={dockWidth} onWidth={setDockWidth} onCommit={commitDock} hidden={effectiveLevel !== 'map' || !cameraOpen} />
        {/* One panel, in one place in the tree, positioned by the layout rather than moved between parents: that is what guarantees a single video element and an uninterrupted stream across a view switch. */}
        <CameraPanel
          camera={camera}
          source={cameraSource}
          axes={camera ? statesById.get(camera.id)?.axes ?? null : null}
          docked={effectiveLevel === 'map'}
          expanded={expanded}
          pollTick={poll.tick}
          incidents={nearbyIncidents}
          visible={cameraOpen}
          onClose={closeCamera}
          onExpanded={setExpanded}
          overlay={trip ? <TripHud trip={trip.trip} index={trip.index} onStop={stopTrip} /> : relay ? <RelayHud pick={relay} now={relayNow} onStop={stopRelay} /> : null}
        />
        {effectiveLevel === 'board' && topology && <Board cameras={topology.cameras} activeId={cameraId} onSelect={openCamera} onData={(states, ok) => setPoll((current) => ({ states, ok, intervalS: 600, tick: current.tick + 1 }))} />}
        <Wall
          highlights={effectiveLevel === 'wall' ? <Highlights key={region} region={region ?? undefined} onSelect={openCamera} /> : null}
          cameras={wallCameras}
          states={statesById}
          ranks={ranks}
          activeId={cameraId}
          intervalS={poll.intervalS}
          visible={effectiveLevel === 'wall'}
          followActive={trip === null && relay === null}
          onSelect={openCamera}
          onVisibleCameras={(ids) => {
            visibleCameras.current = ids;
          }}
        />
      </div>
      <ScoresPane
        region={level === 'home' || level === 'national' || level === 'board' ? null : region}
        onRegion={openRegion}
        onCamera={(id, key) => { openRegion(key); openCamera(id); }}
        open={arbiterOpen}
        onOpen={(next) => {
          setArbiterOpen(next);
          try {
            window.localStorage.setItem(ARBITER_KEY, next ? '1' : '0');
          } catch {
            // A browser refusing storage is not a reason to refuse the pane.
          }
        }}
      />
      <MinimapPane graph={boot.graph} visible={effectiveLevel === 'wall'} region={region} activeSite={activeSite} onOpen={() => setLevel('map')} />
      <Footer context={footerContext} credits={credits} source={citySource} disclaimer={boot.disclaimer} />
    </>
  );
}

/** Used only when the server's own wording cannot be read, so that the wall never shows a camera without a disclaimer. The canonical text lives in data/sources.json. */
const DISCLAIMER_FALLBACK = 'rt511 is an independent project, not affiliated with or endorsed by any transportation agency. Camera images belong to the agencies credited and are shown as published, without warranty. Do not use while driving.';

const ARBITER_KEY = 'rt511.arbiter';

function readArbiterOpen(): boolean {
  try {
    return window.localStorage.getItem(ARBITER_KEY) === '1';
  } catch {
    return false;
  }
}

function readDockWidth(): number {
  try {
    const raw = window.localStorage.getItem(DOCK_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : DOCK_DEFAULT;
  } catch {
    return DOCK_DEFAULT;
  }
}
