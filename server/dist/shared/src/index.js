/** The wire contract between the rt511 server and the wall.
 *
 * Both sides import these, which is the point of the port: the shapes are declared once rather than described in Python and re-declared in TypeScript. Coordinate order is part of the contract and is carried in the type, because `[lat, lon]` and `[lon, lat]` are both pairs of numbers and a swap renders a plausible rotated map instead of failing. */
export { asLatLon, asLonLat, latLon, lonLat, latOf, lonOf, latOfLonLat, lonOfLonLat, toLatLon, toLonLat } from './coords.js';
export { solarElevation } from './sun.js';
export const ROAD_CLASSES = [
    'unclassified',
    'tertiary_link',
    'tertiary',
    'secondary_link',
    'secondary',
    'primary_link',
    'primary',
    'trunk_link',
    'trunk',
    'motorway_link',
    'motorway',
];
//# sourceMappingURL=index.js.map