import type { GraphPromotion, CameraState, Incident } from '../../shared/src/index.js';
import type { Neighbor } from './jev.js';
import { driver, TUNING, type GateFloor, type QueueEntry } from './attention.js';

/** Shared bounds keep queue inference and the cameras offered to Jev on the same corridor. */
export const CORRIDOR = {
  /** Two hops catch the next stretch of road on either side without waking an entire corridor. */
  PROMOTE_HOPS: 2,
  /** Thirty extra cameras bound the request cost even when many events happen together. */
  PROMOTE_MAX: 30,
  /** Five minutes of attention after the last trigger keep flickering evidence from flapping the poll rate. */
  PROMOTE_HOLD_S: 300,
  /** Movement at roughly 1.8 times usual deserves a fresh look at neighbors once the baseline is established. */
  PROMOTE_ANOMALY: 0.9,
  /** How far up the corridor the candidate set for the queue-tail question reaches, in directed graph hops. A queue from a freeway closure routinely stands back further than the first camera upstream, and sites are a few hundred meters to a couple of kilometers apart, so three hops covers the distance a queue reaches inside the half hour the incident floor survives. */
  MAX_UPSTREAM_HOPS: 3,
  /** How fast a queue's tail travels back up the corridor, in kilometers per hour, against the traffic, so the road distance to an upstream camera divided by it is the time before the tail should be visible there. Treiber, Kesting and Helbing (2010, Transportation Research Part B 44(8-9), 983-1000) report 15 to 20 km/h. This sits at the slow end, which errs towards inferring a queue later rather than sooner, and has not been measured on these corridors. */
  WAVE_SPEED_KMH: 15,
  /** How far up the corridor the walk may reach, in meters of road, whatever the hop count allows, because three hops through a ramp-dense interchange can run far beyond any queue the incident floor outlives. Five kilometers is about twenty minutes at the stopping-wave speed, which is the window the floor actually survives. */
  MAX_UPSTREAM_M: 5000,
} as const;

/** Index once per ranking so scoring never walks the graph per camera. Named cameras are excluded from their own record even when another anchor reaches them. Other sides remain available only for an explicit Jev choice and receive no inferred queue floor. */
export function buildQueueIndex(incidents: Iterable<Incident>, corridor: Map<number, Neighbor[]>, cameras: Map<number, { lat: number; lon: number; location?: string; roadway?: string }>, gate?: GateFloor, now = Date.now() / 1000): Map<number, QueueEntry[]> {
  const index = new Map<number, QueueEntry[]>();
  for (const incident of incidents) {
    const anchors = incident.cameras.flatMap((uid) => {
      const camera = cameras.get(uid);
      return camera ? [{ uid, lat: camera.lat, lon: camera.lon }] : [];
    });
    for (const anchor of anchors) {
      for (const neighbor of corridor.get(anchor.uid) ?? []) {
        if (incident.cameras.includes(neighbor.uid)) continue;
        const entries = index.get(neighbor.uid) ?? [];
        entries.push({ incident, anchor, anchors, length_m: neighbor.length_m, wave_s: neighbor.wave_s, upstream: neighbor.side === 'upstream' });
        index.set(neighbor.uid, entries);
      }
    }
  }
  for (const [uid, camera] of cameras) {
    if (!gate || (gate(uid, now)?.value ?? 0) <= 0) continue;
    for (const neighbor of corridor.get(uid) ?? []) {
      if (neighbor.side !== 'upstream' || neighbor.uid === uid) continue;
      const entries = index.get(neighbor.uid) ?? [];
      entries.push({ source: 'standstill', description: camera.location ?? camera.roadway ?? `camera ${uid}`, anchor: { uid, lat: camera.lat, lon: camera.lon }, length_m: neighbor.length_m, wave_s: neighbor.wave_s, upstream: true });
      index.set(neighbor.uid, entries);
    }
  }
  return index;
}

export interface PromotionTrigger {
  reason: GraphPromotion['reason'];
  strength: number;
}

/** Inferred queues cannot recruit another generation of neighbors, and a cold movement baseline cannot distinguish an event from noise. */
export function promotionTrigger(state: Pick<CameraState, 'axes'>): PromotionTrigger | null {
  const axes = state.axes;
  if (!axes) return null;
  const cause = driver(axes);
  if (cause === 'incident' && axes.incident_floor > 0) return { reason: cause, strength: axes.incident_floor };
  if (cause === 'still' && (axes.gate?.floor ?? 0) > 0) return { reason: cause, strength: axes.gate!.floor };
  if (cause !== 'queue' && (axes.anomaly ?? 0) >= CORRIDOR.PROMOTE_ANOMALY && axes.baseline_n >= TUNING.AMBIGUOUS_MIN_SAMPLES) return { reason: 'movement', strength: axes.anomaly! };
  return null;
}

export type HeldTrigger = PromotionTrigger & { at: number };

/** Selection is pure so the same hold boundary and global cap can be checked without starting a poller.
 *
 * Hops come first in the ordering, ahead of trigger strength, because a two-hop neighborhood through an interchange is large enough for the strongest triggers to use the whole cap. Taking every trigger's adjacent cameras before anyone's second hop spreads the budget across events. */
export function selectPromotions(held: ReadonlyMap<number, HeldTrigger>, corridor: ReadonlyMap<number, Neighbor[]>, now: number): GraphPromotion[] {
  const sideRank = { upstream: 0, downstream: 1, nearby: 2 };
  const candidates = [...held].flatMap(([because, trigger]) => now - trigger.at >= CORRIDOR.PROMOTE_HOLD_S ? [] : (corridor.get(because) ?? []).filter((n) => n.uid !== because && n.hops <= CORRIDOR.PROMOTE_HOPS).map((n) => ({ uid: n.uid, because, reason: trigger.reason, strength: trigger.strength, hops: n.hops, side: sideRank[n.side], distance: n.length_m })));
  candidates.sort((a, b) => a.hops - b.hops || b.strength - a.strength || a.side - b.side || a.distance - b.distance || a.uid - b.uid || a.because - b.because);
  const unique = new Map<number, GraphPromotion>();
  for (const { uid, because, reason } of candidates) {
    if (!unique.has(uid)) unique.set(uid, { uid, because, reason });
    if (unique.size >= CORRIDOR.PROMOTE_MAX) break;
  }
  return [...unique.values()];
}
