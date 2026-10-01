/** Incident feeds: what an agency is responding to right now, configured in `data/cad_sources.json`.
 *
 * One feed per state rather than one per city, fetched only while some city in that state is being watched, at the interval the feed itself asks for. Ohio's OHGO incidents are the one feed configured today. A feed is added only for a state whose cameras the wall shows, because an incident with no camera to put it on is information without a picture, and each format has a parser registered in PARSERS. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Incident } from '../../shared/src/index.js';
import { DataError } from './config.js';

/** How close a camera has to be to be worth offering as a view of an incident. Beyond this it is a different street. */
export const CAMERA_RADIUS_KM = 1.5;
const MAX_CAMERAS = 6;
const TIMEOUT_MS = 20_000;

export interface CadSource {
  key: string;
  name: string;
  url: string;
  format: string;
  attribution: string;
  poll_period_s: number;
  notes: string;
  /** Code table this feed's type codes belong to, loaded from data/codes/<codes>.json. Null when the agency publishes none. */
  codes: CodeTable | null;
  /** What to do with a record the feed publishes no report time for. `null` leaves it undated, so it gets no floor at all. `first_seen` dates it by when this server first saw it, which the config has to ask for explicitly because it restarts the decay whenever the server does. */
  undated: 'first_seen' | null;
  /** The environment variable holding the user's own key for this feed, and how to send it. Null when the feed needs none. */
  auth: { env: string; header: string; format: string } | null;
}

/** An agency's own incident codes, plus this project's judgment about which of them describe something happening to a road. The labels are the agency's; the two sets are ours. */
export interface CodeTable {
  agency: string;
  signal: Record<string, string>;
  roadRelevant: Set<string>;
  impliesClosure: Set<string>;
}

function loadCodeTable(root: string, name: string): CodeTable {
  const path = join(root, 'data', 'codes', `${name}.json`);
  if (!existsSync(path)) throw new DataError(`${path}: referenced by cad_sources.json but missing`);
  const d = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const signal = d.signal;
  if (typeof signal !== 'object' || signal === null) throw new DataError(`${path}.signal: expected an object`);
  const list = (field: string): Set<string> => new Set(Array.isArray(d[field]) ? (d[field] as string[]) : []);
  return {
    agency: typeof d.agency === 'string' ? d.agency : name,
    signal: signal as Record<string, string>,
    roadRelevant: list('road_relevant'),
    impliesClosure: list('implies_closure'),
  };
}

export function loadCadSources(root: string): Record<string, CadSource> {
  const path = join(root, 'data', 'cad_sources.json');
  if (!existsSync(path)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new DataError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root_ = data as { sources?: Record<string, Record<string, unknown>> };
  const table = root_.sources;
  if (typeof table !== 'object' || table === null) throw new DataError('cad_sources.json.sources: expected an object');
  const out: Record<string, CadSource> = {};
  for (const [key, value] of Object.entries(table)) {
    const where = `cad_sources.json.sources.${key}`;
    const entry = value as Record<string, unknown>;

    // Every source is listed, including those with no feed found yet, so this file doubles as the worklist. An empty feeds list is an ordinary state.
    const feeds = Array.isArray(entry.feeds) ? (entry.feeds as Record<string, unknown>[]) : [];
    const incidents = feeds.find((f) => f.kind === 'incidents');
    if (!incidents) continue;

    const str = (field: string): string => {
      const v = incidents[field];
      if (typeof v !== 'string') throw new DataError(`${where}.feeds[incidents].${field}: expected a string`);
      return v;
    };
    const period = incidents.poll_period_s;
    if (typeof period !== 'number' || !Number.isFinite(period) || period <= 0) {
      throw new DataError(`${where}.feeds[incidents].poll_period_s: expected a positive number`);
    }
    out[key] = {
      key,
      name: str('name'),
      url: str('url'),
      format: str('format'),
      attribution: str('attribution'),
      poll_period_s: period,
      notes: typeof incidents.notes === 'string' ? incidents.notes : '',
      codes: typeof entry.codes === 'string' ? loadCodeTable(root, entry.codes) : null,
      undated: incidents.undated === 'first_seen' ? 'first_seen' : null,
      auth: readAuth(incidents.auth, `${where}.feeds[incidents].auth`),
    };
  }
  return out;
}

function readAuth(value: unknown, where: string): CadSource['auth'] {
  if (value === undefined || value === null) return null;
  const rec = value as Record<string, unknown>;
  for (const field of ['env', 'header', 'format']) if (typeof rec[field] !== 'string') throw new DataError(`${where}.${field}: expected a string`);
  return { env: rec.env as string, header: rec.header as string, format: rec.format as string };
}

/** A parsed dispatch record before its cameras are attached. */
export interface RawIncident {
  id: string;
  type: string;
  location: string;
  city: string | null;
  county: string | null;
  lat: number;
  lon: number;
  reported_at: number | null;
  remarks: string | null;
  /** Set by feeds that say in each record what it is and whether the road is closed, rather than through a code table. */
  label?: string | null;
  road_relevant?: boolean;
  implies_closure?: boolean;
}

/** ODOT categories that describe planned work on the road rather than something that has happened to it. Matched as words, so ODOT's own "Repairs/Maintenance", which is most of the feed on an ordinary day, and any construction or work-zone category it adds are caught alike. */
const PLANNED_WORK = /\b(repairs?|maintenance|construction|road ?work|work ?zone)\b/i;

/** Whether an OHGO category is planned work. */
export function isPlannedWork(category: string | null): boolean {
  return category !== null && PLANNED_WORK.test(category);
}

/** Parses OHGO's incidents. A record is road-relevant, and a closed road in the record implies closure, unless it is planned work. Planned work earns no floor, closed or not: it is scheduled, it stays listed for hours or days, and the wall is for unplanned change. Measured on a live Columbus wall, two routine maintenance records otherwise held every one of the top eight places, since the lexicographic bands rank any floor above all movement. The record is still listed and labeled. The category is ODOT's own word for the event and is shown as it stands. OHGO publishes no report time, so records come back undated. */
export function parseOhgoIncidents(body: string): RawIncident[] {
  const data = JSON.parse(body) as { results?: Record<string, unknown>[] };
  const out: RawIncident[] = [];
  for (const rec of data.results ?? []) {
    const lat = Number(rec.latitude);
    const lon = Number(rec.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const text = (field: string): string | null => (typeof rec[field] === 'string' && (rec[field] as string).trim() ? (rec[field] as string).trim() : null);
    const status = (text('roadStatus') ?? '').toLowerCase();
    const category = text('category');
    out.push({
      id: text('id') ?? `${lat},${lon}`,
      type: category ?? 'Incident',
      location: [text('routeName'), text('direction'), text('location')].filter(Boolean).join(' ') || 'Ohio',
      city: null,
      county: null,
      lat,
      lon,
      reported_at: null,
      remarks: text('description'),
      label: category,
      road_relevant: !isPlannedWork(category),
      implies_closure: !isPlannedWork(category) && status === 'closed',
    });
  }
  return out;
}

/** Turns one feed's body into records, keyed by the `format` named in `data/cad_sources.json`. */
const PARSERS: Record<string, (body: string) => RawIncident[]> = { 'ohgo-json': parseOhgoIncidents };

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = p2 - p1;
  const dl = toRad(lon2 - lon1);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

export interface CameraPositions {
  /** Global ids, in the same order as the coordinates. */
  ids: number[];
  lat: number[];
  lon: number[];
}

/** The cameras close enough to show an incident, nearest first. Nothing within the radius means an empty list: offering the nearest camera eight kilometers away would be worse than offering none. */
export function camerasNear(incident: RawIncident, cameras: CameraPositions): number[] {
  // A degree of latitude is about 111 km everywhere, so this box is a cheap filter before the real distance.
  const pad = CAMERA_RADIUS_KM / 111;
  const near: { id: number; km: number }[] = [];
  for (let i = 0; i < cameras.ids.length; i++) {
    const lat = cameras.lat[i] as number;
    const lon = cameras.lon[i] as number;
    if (Math.abs(lat - incident.lat) > pad || Math.abs(lon - incident.lon) > pad / Math.max(0.2, Math.cos((incident.lat * Math.PI) / 180))) continue;
    const km = distanceKm(incident.lat, incident.lon, lat, lon);
    if (km <= CAMERA_RADIUS_KM) near.push({ id: cameras.ids[i] as number, km });
  }
  near.sort((a, b) => a.km - b.km);
  return near.slice(0, MAX_CAMERAS).map((entry) => entry.id);
}

/** One state's feed: fetched on demand, never more often than the feed asks for, and never at all while nobody is watching a city in that state. */
export class CadFeed {
  private incidents: Incident[] = [];
  private fetchedAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private failing = false;
  /** When this server first saw each record, for feeds configured to date undated records that way. Entries for records that have left the feed are dropped on every read. */
  private readonly firstSeen = new Map<string, number>();
  /** Counted for the politeness report, the same way the camera client counts its own. */
  requests = 0;

  constructor(
    readonly source: CadSource,
    private readonly userAgent: string,
    private readonly cameras: CameraPositions,
  ) {}

  get lastFetch(): number | null {
    return this.fetchedAt;
  }

  get healthy(): boolean {
    return !this.failing;
  }

  /** Everything this feed is holding, however far away it is. The scorer wants the incidents by the camera they name rather than by a city's box, and it must never trigger a fetch of its own. */
  current(): Incident[] {
    return this.incidents;
  }

  /** Incidents inside a box, which is how a city asks for the ones that concern it. */
  within(south: number, west: number, north: number, east: number): Incident[] {
    return this.incidents.filter((i) => i.lat >= south && i.lat <= north && i.lon >= west && i.lon <= east);
  }

  /** Reads the feed if the interval has elapsed. Safe to call on every request: it is a no-op while the copy in hand is younger than the feed's own refresh interval, and concurrent callers share one fetch. */
  async refresh(): Promise<void> {
    const now = Date.now() / 1000;
    if (this.fetchedAt !== null && now - this.fetchedAt < this.source.poll_period_s) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetch(): Promise<void> {
    try {
      const headers: Record<string, string> = { 'User-Agent': this.userAgent, Accept: this.source.format.endsWith('json') ? 'application/json' : 'application/rss+xml, application/xml, text/xml' };
      const auth = this.source.auth;
      if (auth) {
        // The user's own key, registered under the agency's terms. Without it the feed is simply not read.
        const key = process.env[auth.env]?.trim();
        if (!key) throw new Error(`needs your own key in ${auth.env}`);
        headers[auth.header] = auth.format.replace('{key}', key);
      }
      this.requests++;
      const res = await fetch(this.source.url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${res.status}`);
      const parse = PARSERS[this.source.format];
      if (!parse) throw new Error(`no parser for format ${this.source.format}`);
      const raw = parse(await res.text());
      const codes = this.source.codes;
      const now = Date.now() / 1000;
      if (this.source.undated === 'first_seen') {
        const live = new Set(raw.map((incident) => incident.id));
        for (const id of this.firstSeen.keys()) if (!live.has(id)) this.firstSeen.delete(id);
        for (const incident of raw) if (!this.firstSeen.has(incident.id)) this.firstSeen.set(incident.id, now);
      }
      this.incidents = raw.map((incident) => ({
        ...incident,
        reported_at: incident.reported_at ?? (this.source.undated === 'first_seen' ? (this.firstSeen.get(incident.id) ?? now) : null),
        cameras: camerasNear(incident, this.cameras),
        // The agency's own meaning for its code, where we have been given the table or the record says itself. Never invented: an unknown code shows as itself.
        label: incident.label ?? codes?.signal[incident.type] ?? null,
        road_relevant: incident.road_relevant ?? (codes ? codes.roadRelevant.has(incident.type) : true),
        implies_closure: incident.implies_closure ?? (codes ? codes.impliesClosure.has(incident.type) : false),
      }));
      this.fetchedAt = Date.now() / 1000;
      if (this.failing) console.log(`${this.source.key} incidents recovered`);
      this.failing = false;
    } catch (error) {
      // A feed that cannot be read must not take anything else with it: the wall keeps its cameras, its map and its video, and simply shows no incidents.
      if (!this.failing) console.warn(`${this.source.key} incidents unavailable: ${error instanceof Error ? error.message : String(error)}`);
      this.failing = true;
    }
  }
}
