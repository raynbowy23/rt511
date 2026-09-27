import type { Camera, Site } from './api';
import type { Topology } from './graph';

/** Seconds a stop stays up, before the drive to the next one is added. Long enough to read a picture, short enough that a trip keeps moving. */
const MIN_DWELL_S = 6;
const MAX_DWELL_S = 14;
/** A camera with live video is worth lingering on. */
const VIDEO_BONUS_S = 5;
/** Free-flow drive time between two cameras is a minute or more, far too slow to watch, so it is divided down while keeping longer gaps longer. */
const PACE_DIVISOR = 8;
/** A trip needs at least this many cameras to be worth driving. */
const MIN_STOPS = 3;

/** Every state's two-letter postal code, which is also its state-route prefix on signs and in feeds ("IA 5", "OH-161"). A fact about the country rather than about this project's sources, so a newly added state's routes are read without touching this file. */
const STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
/** Interstate, US and generic state routes, in any case. */
const NATIONAL_RE = /\b(I|US|SR)[\s-]*(\d+)/i;
/** State-prefixed routes in capitals only, as feeds and signs write them, so ordinary words such as "in", "or" and "ok" are never read as Indiana, Oregon or Oklahoma. */
const STATE_RE = new RegExp(`\\b(${STATES})[\\s-]*(\\d+)`);

/** The route a road name names, as a label: "I 35", "I-35/80" and "IA 5 @ MM 3" become "I-35" and "IA-5". State routes keep their state's prefix so the label reads the way the signs do. Null for a street with no route number. */
export function routeOf(text: string | null | undefined): string | null {
  // Whichever route comes first in the name, as a single pattern would find it.
  const found = [NATIONAL_RE.exec(text ?? ''), STATE_RE.exec(text ?? '')].filter((match): match is RegExpExecArray => match !== null).sort((a, b) => a.index - b.index)[0];
  return found ? `${found[1]!.toUpperCase()}-${Number(found[2])}` : null;
}

export interface TripStop {
  camera: Camera;
  site: Site;
  /** Road distance from the start of the trip to this stop. */
  distance_m: number;
  /** Road distance and free-flow drive time from the previous stop. Zero for the first. */
  leg_m: number;
  leg_s: number;
}

export interface Trip {
  id: string;
  route: string;
  heading: string;
  region: string;
  stops: TripStop[];
  length_m: number;
}

const HEADINGS = ['northbound', 'eastbound', 'southbound', 'westbound'];

function bearing(a: Site, b: Site): number {
  const dy = b.lat - a.lat;
  const dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

function headingOf(degrees: number): string {
  return HEADINGS[Math.round(degrees / 90) % 4]!;
}

/** Degrees between two bearings, 0 to 180. */
function apart(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

interface Step {
  site: Site;
  length_m: number;
  tt_s: number;
}

/** The next site along traffic that is on the same route, directly or through one site that is not: cameras on a route are sometimes separated by a camera on a crossing road, and a trip should drive past it rather than end there. */
function nextOnRoute(topo: Topology, from: Site, route: string, region: string, seen: Set<string>): Step | null {
  const candidates: Step[] = [];
  for (const edge of topo.flowOut(from.id)) {
    const mid = topo.sites.get(edge.dst);
    if (!mid || !mid.id.startsWith(`${region}:`) || seen.has(mid.id)) continue;
    if (routeOf(mid.roadway) === route) {
      candidates.push({ site: mid, length_m: edge.length_m, tt_s: edge.tt_s });
      continue;
    }
    for (const second of topo.flowOut(mid.id)) {
      const end = topo.sites.get(second.dst);
      if (end && end.id !== from.id && !seen.has(end.id) && routeOf(end.roadway) === route) {
        candidates.push({ site: end, length_m: edge.length_m + second.length_m, tt_s: edge.tt_s + second.tt_s });
      }
    }
  }
  candidates.sort((a, b) => a.length_m - b.length_m);
  return candidates[0] ?? null;
}

/** Every drivable trip in a city: for each numbered route, the longest chain of cameras in each direction of travel, in driving order. */
export function planTrips(topo: Topology, region: string): Trip[] {
  const byRoute = new Map<string, Site[]>();
  for (const site of topo.sites.values()) {
    if (!site.id.startsWith(`${region}:`) || !topo.cameraAt(site.id)) continue;
    const route = routeOf(site.roadway);
    if (!route) continue;
    const list = byRoute.get(route) ?? [];
    list.push(site);
    byRoute.set(route, list);
  }
  const trips: Trip[] = [];
  for (const [route, sites] of byRoute) {
    if (sites.length < MIN_STOPS) continue;
    // A site that some other site on the route leads to is not a start. What is left are the places a trip can begin.
    const reached = new Set<string>();
    for (const site of sites) {
      const next = nextOnRoute(topo, site, route, region, new Set([site.id]));
      if (next) reached.add(next.site.id);
    }
    const chains: TripStop[][] = [];
    for (const start of sites.filter((s) => !reached.has(s.id))) {
      const seen = new Set([start.id]);
      const stops: TripStop[] = [{ camera: topo.cameraAt(start.id)!, site: start, distance_m: 0, leg_m: 0, leg_s: 0 }];
      let at = start;
      let travelled = 0;
      for (;;) {
        const next = nextOnRoute(topo, at, route, region, seen);
        if (!next) break;
        seen.add(next.site.id);
        travelled += next.length_m;
        stops.push({ camera: topo.cameraAt(next.site.id)!, site: next.site, distance_m: travelled, leg_m: next.length_m, leg_s: next.tt_s });
        at = next.site;
      }
      if (stops.length >= MIN_STOPS) chains.push(stops);
    }
    // At most two trips a route: its longest chain, and the longest one running roughly the other way. Chains are grouped by overall bearing rather than by compass label, because a curving road would otherwise split into several near-duplicate trips.
    const ends = (stops: TripStop[]): number => bearing(stops[0]!.site, stops[stops.length - 1]!.site);
    chains.sort((a, b) => b.length - a.length || b[b.length - 1]!.distance_m - a[a.length - 1]!.distance_m);
    const first = chains[0];
    if (!first) continue;
    const back = chains.find((stops) => apart(ends(stops), ends(first)) > 120);
    for (const stops of back ? [first, back] : [first]) {
      const way = headingOf(ends(stops));
      trips.push({ id: `${route}:${way}`, route, heading: way, region, stops, length_m: stops[stops.length - 1]!.distance_m });
    }
  }
  return trips.sort((a, b) => b.stops.length - a.stops.length || a.id.localeCompare(b.id));
}

/** Drives a trip: shows each stop in turn for as long as it deserves, then asks what to drive next when the road runs out. */
export class RoadTrip {
  private timer: number | null = null;
  trip: Trip | null = null;
  index = 0;

  constructor(
    private readonly show: (trip: Trip, index: number) => void,
    private readonly ended: (trip: Trip) => Trip | null,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(trip: Trip, from = 0): void {
    this.stop();
    this.trip = trip;
    this.index = Math.min(from, trip.stops.length - 1);
    this.show(trip, this.index);
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  /** How long the current stop stays: a base, plus the drive to the next stop scaled down to watching speed, plus a little more for live video. */
  dwell(): number {
    const trip = this.trip;
    if (!trip) return MIN_DWELL_S;
    const stop = trip.stops[this.index]!;
    const next = trip.stops[this.index + 1];
    const drive = next ? next.leg_s / PACE_DIVISOR : 0;
    return Math.min(MAX_DWELL_S, MIN_DWELL_S + drive) + (stop.camera.has_video ? VIDEO_BONUS_S : 0);
  }

  private schedule(): void {
    this.timer = window.setTimeout(() => this.advance(), this.dwell() * 1000);
  }

  private advance(): void {
    const trip = this.trip;
    if (!trip) return;
    if (this.index + 1 < trip.stops.length) {
      this.index++;
      this.show(trip, this.index);
      this.schedule();
      return;
    }
    // End of the road. Turn around if the route runs the other way too, otherwise drive it again, so a wall left on keeps moving.
    this.start(this.ended(trip) ?? trip);
  }
}
