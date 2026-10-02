/** A thin shape check at the boundary between the wall and its server.
 *
 * The server imports the same contract from `@rt511/shared`, so field names cannot drift between the two without a compile error. What remains here is the part types cannot cover: this bundle can be served by a different version of the server, or reach a proxy's error page, and `as T` on either would hand a render an undefined.
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

/** Checks that a field exists and is of the right kind without walking into it. */
export function field<T>(source: Record<string, unknown>, key: string, path: string, check: (value: unknown, path: string) => T): T {
  return check(source[key], `${path}.${key}`);
}

/** Brands a whole geometry structure after checking one sample point; the server already checked the rest, and the brands make a coordinate-order swap a compile error downstream. */
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
