import type { LatLon } from '@rt511/shared';

/** Attention spreading along the road: from a camera that saw something to a camera it made worth watching.
 *
 * Two kinds reach the map. A promotion is the wall looking closely at a camera's road neighbors because that camera saw an incident, stopped traffic or unusual movement. A queue is a floor raised under a camera upstream of an incident or of stopped traffic, because the queue could reach it. Both are things the scorer already decides; this module only turns them into paths along the road graph so they can be drawn moving. */

export type FlowReason = 'incident' | 'still' | 'movement';

export interface AttentionFlow {
  /** The camera the attention comes from: the one that saw something, or the queue's anchor. */
  from: number;
  /** The camera it reaches. */
  to: number;
  reason: FlowReason;
  /** 0 to 1: how strongly, which sets how bright the pulse is. */
  strength: number;
}

/** One directed road link between two sites, with its geometry in travel order. */
export interface Link {
  to: string;
  points: LatLon[];
}

/** The road between two sites as one line, found by a breadth-first walk over the graph's links in either direction, since attention spreads both up and down a road. Null when the two are not connected within `maxHops`, which leaves that flow undrawn rather than drawn as a straight line across the map. */
export function roadPath(links: ReadonlyMap<string, Link[]>, from: string, to: string, maxHops = 8): LatLon[] | null {
  if (from === to) return null;
  const previous = new Map<string, { site: string; points: LatLon[] }>();
  let frontier = [from];
  const seen = new Set([from]);
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const site of frontier) {
      for (const link of links.get(site) ?? []) {
        if (seen.has(link.to)) continue;
        seen.add(link.to);
        previous.set(link.to, { site, points: link.points });
        if (link.to === to) return stitch(previous, from, to);
        next.push(link.to);
      }
    }
    frontier = next;
  }
  return null;
}

function stitch(previous: Map<string, { site: string; points: LatLon[] }>, from: string, to: string): LatLon[] {
  const legs: LatLon[][] = [];
  for (let site = to; site !== from; ) {
    const step = previous.get(site)!;
    legs.unshift(step.points);
    site = step.site;
  }
  // Consecutive legs share the site between them, so each leg after the first drops its first point.
  return legs.flatMap((leg, i) => (i === 0 ? leg : leg.slice(1)));
}

/** A polyline measured once, so a pulse can be placed at any distance along it. */
export interface Measured {
  xs: number[];
  ys: number[];
  /** Distance from the start to each point. */
  at: number[];
  length: number;
}

export function measure(points: readonly [number, number][]): Measured {
  const xs: number[] = [];
  const ys: number[] = [];
  const at: number[] = [];
  let length = 0;
  points.forEach(([x, y], i) => {
    if (i > 0) length += Math.hypot(x - xs[i - 1]!, y - ys[i - 1]!);
    xs.push(x);
    ys.push(y);
    at.push(length);
  });
  return { xs, ys, at, length };
}

/** The point `distance` along a measured line, clamped to its ends. */
export function pointAt(line: Measured, distance: number): [number, number] {
  const n = line.xs.length;
  if (n === 0) return [0, 0];
  if (distance <= 0 || n === 1) return [line.xs[0]!, line.ys[0]!];
  if (distance >= line.length) return [line.xs[n - 1]!, line.ys[n - 1]!];
  let i = 1;
  while (i < n - 1 && line.at[i]! < distance) i++;
  const start = line.at[i - 1]!;
  const span = line.at[i]! - start || 1;
  const k = (distance - start) / span;
  return [line.xs[i - 1]! + (line.xs[i]! - line.xs[i - 1]!) * k, line.ys[i - 1]! + (line.ys[i]! - line.ys[i - 1]!) * k];
}
