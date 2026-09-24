/** Two coordinate orders arrive from the same backend: `/api/graph` and `/api/roads` send `[lat, lon]`, `/api/national` sends GeoJSON `[lon, lat]`. Both are pairs of numbers, so a swap compiles cleanly and draws a plausible rotated map, which is worse than crashing.
 *
 * Branding them apart makes that swap a compile error. The only place a raw pair becomes a branded one is the validation layer, where the order is read off the endpoint's documented contract once. */

declare const LatLonOrder: unique symbol;
declare const LonLatOrder: unique symbol;

/** Latitude first, as `/api/graph` and `/api/roads` send it. */
export type LatLon = readonly [number, number] & { readonly [LatLonOrder]: true };

/** Longitude first, GeoJSON order, as `/api/national` sends it. */
export type LonLat = readonly [number, number] & { readonly [LonLatOrder]: true };

export const latLon = (lat: number, lon: number): LatLon => [lat, lon] as unknown as LatLon;
export const lonLat = (lon: number, lat: number): LonLat => [lon, lat] as unknown as LonLat;

// Accessors per order rather than one polymorphic pair: at runtime both brands are plain arrays, so a function taking either could not tell them apart and would have to guess.
export const latOf = (point: LatLon): number => point[0];
export const lonOf = (point: LatLon): number => point[1];
export const latOfLonLat = (point: LonLat): number => point[1];
export const lonOfLonLat = (point: LonLat): number => point[0];

/** Reorders rather than reinterprets: the only sanctioned way to cross between the two. */
export const toLonLat = (point: LatLon): LonLat => lonLat(point[1], point[0]);
export const toLatLon = (point: LonLat): LatLon => latLon(point[1], point[0]);

/** Brands a pair that has already been checked to be two finite numbers in the named order. Confined to the validation layer on purpose. */
export const asLatLon = (pair: readonly [number, number]): LatLon => pair as LatLon;
export const asLonLat = (pair: readonly [number, number]): LonLat => pair as LonLat;
