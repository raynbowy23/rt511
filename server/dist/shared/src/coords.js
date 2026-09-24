/** Two coordinate orders arrive from the same backend: `/api/graph` and `/api/roads` send `[lat, lon]`, `/api/national` sends GeoJSON `[lon, lat]`. Both are pairs of numbers, so a swap compiles cleanly and draws a plausible rotated map, which is worse than crashing.
 *
 * Branding them apart makes that swap a compile error. The only place a raw pair becomes a branded one is the validation layer, where the order is read off the endpoint's documented contract once. */
export const latLon = (lat, lon) => [lat, lon];
export const lonLat = (lon, lat) => [lon, lat];
// Accessors per order rather than one polymorphic pair: at runtime both brands are plain arrays, so a function taking either could not tell them apart and would have to guess.
export const latOf = (point) => point[0];
export const lonOf = (point) => point[1];
export const latOfLonLat = (point) => point[1];
export const lonOfLonLat = (point) => point[0];
/** Reorders rather than reinterprets: the only sanctioned way to cross between the two. */
export const toLonLat = (point) => lonLat(point[1], point[0]);
export const toLatLon = (point) => latLon(point[1], point[0]);
/** Brands a pair that has already been checked to be two finite numbers in the named order. Confined to the validation layer on purpose. */
export const asLatLon = (pair) => pair;
export const asLonLat = (pair) => pair;
//# sourceMappingURL=coords.js.map