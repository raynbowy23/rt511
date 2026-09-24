/** A thin shape check at the boundary between the wall and its server.
 *
 * This used to be a full recursive walk of every field of every response, and it earned its keep when the server was Python: a renamed field crossed a language boundary with nothing to catch it, and the walk is what found cameras whose `site` had become null. The server is TypeScript now and imports the same contract from `@rt511/shared`, so field names cannot drift between the two without a compile error, and the server validates the pipeline's files where they are read. What remains here is the part types cannot cover: this bundle is a build artifact that can be served by a different version of the server, or reach a proxy's error page instead of the server at all, and `as T` on either would hand a render an undefined.
 *
 * So each endpoint is checked shallowly — the top-level shape, the presence of the collections the UI iterates, and one sample of each coordinate array — and the coordinate brands are applied here, which is the only place raw JSON becomes a typed pair. */

import { asLatLon, asLonLat, type LatLon, type LonLat } from '@rt511/shared';

export class ShapeError extends Error {
  constructor(path: string, expected: string, got: unknown) {
    super(`${path}: expected ${expected}, got ${describe(got)}`);
    this.name = 'ShapeError';
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

export function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ShapeError(path, 'an object', value);
  return value as Record<string, unknown>;
}

export function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ShapeError(path, 'an array', value);
  return value;
}

export function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ShapeError(path, 'a finite number', value);
  return value;
}

export function str(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ShapeError(path, 'a string', value);
  return value;
}

/** Checks that a field exists and is of the right kind without walking into it. The server guarantees what is inside; this guarantees the thing on the wire is a response from that server at all. */
export function field<T>(source: Record<string, unknown>, key: string, path: string, check: (value: unknown, path: string) => T): T {
  return check(source[key], `${path}.${key}`);
}

/** Brands a whole geometry structure after checking one sample point. A swap between the two coordinate orders is a compile error everywhere downstream, which is what the brands are for; checking every point again would only repeat what the server already did. */
export function latLonRings(value: unknown, path: string): LatLon[][] {
  const rings = arr(value, path);
  samplePair(rings[0], `${path}[0]`);
  return rings as LatLon[][];
}

export function latLonLine(value: unknown, path: string): LatLon[] {
  const points = arr(value, path);
  if (points.length > 0) pair(points[0], `${path}[0]`);
  return points.map((point) => asLatLon(point as [number, number]));
}

export function lonLatRings(value: unknown, path: string): LonLat[][] {
  const rings = arr(value, path);
  samplePair(rings[0], `${path}[0]`);
  return rings.map((ring) => arr(ring, path).map((point) => asLonLat(point as [number, number])));
}

function samplePair(ring: unknown, path: string): void {
  if (ring === undefined) return;
  const points = arr(ring, path);
  if (points.length > 0) pair(points[0], `${path}[0]`);
}

function pair(value: unknown, path: string): void {
  const items = arr(value, path);
  if (items.length < 2) throw new ShapeError(path, 'a pair of numbers', value);
  num(items[0], `${path}[0]`);
  num(items[1], `${path}[1]`);
}
