/** Everything the service reads off disk. All of it is written by the Python pipeline; none of it is generated here.
 *
 * The parsers are deliberately strict. These files cross a language boundary, so a renamed field is exactly the kind of drift that would otherwise surface as an undefined in a draw call three layers away. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { asLatLon, asLonLat } from '../../shared/src/index.js';
export class DataError extends Error {
}
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        throw new DataError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function obj(value, where) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new DataError(`${where}: expected an object`);
    return value;
}
function arr(value, where) {
    if (!Array.isArray(value))
        throw new DataError(`${where}: expected an array`);
    return value;
}
function str(value, where) {
    if (typeof value !== 'string')
        throw new DataError(`${where}: expected a string`);
    return value;
}
function num(value, where) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new DataError(`${where}: expected a finite number`);
    return value;
}
function bool(value, where) {
    if (typeof value !== 'boolean')
        throw new DataError(`${where}: expected a boolean`);
    return value;
}
function nullableStr(value, where) {
    return value === null || value === undefined ? null : str(value, where);
}
function nullableNum(value, where) {
    return value === null || value === undefined ? null : num(value, where);
}
function bbox(value, where) {
    const items = arr(value, where);
    if (items.length !== 4)
        throw new DataError(`${where}: expected four numbers (south, west, north, east)`);
    return [num(items[0], where), num(items[1], where), num(items[2], where), num(items[3], where)];
}
/** The canonical table of 511 sites. Every measured fact about a site lives in this file so that the Python pipeline and this server cannot drift apart; nothing from it is duplicated in code. */
export function loadSources(root) {
    const data = obj(readJson(join(root, 'data', 'sources.json')), 'sources.json');
    const published = obj(data.sources, 'sources.json.sources');
    // Sources this machine reads under an arrangement of its own with an agency live in data/local/, which git ignores, so the published repository never claims them.
    const localPath = join(root, 'data', 'local', 'sources.json');
    const local = existsSync(localPath) ? obj(obj(readJson(localPath), 'local sources.json').sources, 'local sources.json.sources') : {};
    const clash = Object.keys(local).filter((key) => key in published);
    if (clash.length > 0)
        throw new DataError(`data/local/sources.json redefines published sources ${clash.join(', ')}; give local sources keys of their own`);
    const table = { ...published, ...local };
    const sources = {};
    for (const [key, value] of Object.entries(table)) {
        const rec = obj(value, `sources.json.sources.${key}`);
        const where = `sources.json.sources.${key}`;
        sources[key] = {
            key,
            name: str(rec.name, `${where}.name`),
            base_url: str(rec.base_url, `${where}.base_url`),
            states: arr(rec.states, `${where}.states`).map((s, i) => str(s, `${where}.states[${i}]`)),
            snapshot_content_type: str(rec.snapshot_content_type, `${where}.snapshot_content_type`),
            video_auth: bool(rec.video_auth, `${where}.video_auth`),
            has_video: bool(rec.has_video, `${where}.has_video`),
            attribution: str(rec.attribution, `${where}.attribution`),
            poll_period_s: num(rec.poll_period_s, `${where}.poll_period_s`),
            token_url: nullableStr(rec.token_url, `${where}.token_url`),
            notes: typeof rec.notes === 'string' ? rec.notes : '',
            kind: typeof rec.kind === 'string' ? rec.kind : 'platform',
            license: typeof rec.license === 'string' ? rec.license : '',
            terms_url: typeof rec.terms_url === 'string' ? rec.terms_url : '',
            notice: typeof rec.notice === 'string' ? rec.notice : '',
            max_requests_per_s: typeof rec.max_requests_per_s === 'number' && rec.max_requests_per_s > 0 ? rec.max_requests_per_s : null,
            focus_period_s: typeof rec.focus_period_s === 'number' && rec.focus_period_s > 0 ? rec.focus_period_s : null,
            local: key in local,
            time_zone: typeof rec.time_zone === 'string' && rec.time_zone ? rec.time_zone : null,
            feed: typeof rec.feed === 'object' && rec.feed !== null ? rec.feed : {},
        };
    }
    return { userAgent: str(data.user_agent, 'sources.json.user_agent'), sources, disclaimer: str(data.disclaimer, 'sources.json.disclaimer') };
}
export function loadRegions(root) {
    const regions = new Map();
    // The published cities, then any on local sources, which are kept under data/local/ with them.
    const entries = [join(root, 'data', 'regions.json'), join(root, 'data', 'local', 'regions.json')]
        .filter((path) => existsSync(path))
        .flatMap((path) => arr(readJson(path), 'regions.json'));
    for (const [i, value] of entries.entries()) {
        const rec = obj(value, `regions.json[${i}]`);
        const where = `regions.json[${i}]`;
        const centre = rec.center === null || rec.center === undefined ? null : arr(rec.center, `${where}.center`);
        regions.set(str(rec.key, `${where}.key`), {
            key: str(rec.key, `${where}.key`),
            name: str(rec.name, `${where}.name`),
            source: str(rec.source, `${where}.source`),
            bbox: bbox(rec.bbox, `${where}.bbox`),
            center: centre === null ? null : [num(centre[0], `${where}.center[0]`), num(centre[1], `${where}.center[1]`)],
            radius_km: nullableNum(rec.radius_km, `${where}.radius_km`),
            limit: nullableNum(rec.limit, `${where}.limit`),
            time_zone: typeof rec.time_zone === 'string' && rec.time_zone ? rec.time_zone : null,
        });
    }
    return regions;
}
/** The centre to draw a region at. Regions created from a city carry a real centre; the two built-in ones do not, so the middle of the bounding box stands in rather than every caller re-deriving it. */
export function centroid(region) {
    if (region.center)
        return region.center;
    const [south, west, north, east] = region.bbox;
    return [round((south + north) / 2, 6), round((west + east) / 2, 6)];
}
/** A region's data file: under data/local/ when the region is a local one and the file is there, otherwise the published one. */
function dataFile(root, name) {
    const local = join(root, 'data', 'local', name);
    return existsSync(local) ? local : join(root, 'data', name);
}
/** Each source's block in the global camera id space: the published sources in alphabetical order, then local ones after them. A camera's global id is its block times ten million plus its native id, so a published camera keeps its id whatever local sources a machine adds, and saved links and diary entries keep pointing at it. */
export function sourceBlocks(sources) {
    const keys = Object.keys(sources);
    const ordered = [...keys.filter((key) => !sources[key]?.local).sort(), ...keys.filter((key) => sources[key]?.local).sort()];
    return new Map(ordered.map((key, i) => [key, i]));
}
export function catalogPath(root, key) {
    return dataFile(root, `cameras_${key}.json`);
}
export function graphPath(root, key) {
    return join(root, 'out', `graph_${key}.json`);
}
export function loadCatalog(path) {
    return arr(readJson(path), path).map((value, i) => {
        const rec = obj(value, `${path}[${i}]`);
        const where = `${path}[${i}]`;
        return {
            id: num(rec.id, `${where}.id`),
            region: str(rec.region, `${where}.region`),
            source: str(rec.source, `${where}.source`),
            image_path: str(rec.image_path, `${where}.image_path`),
            roadway: str(rec.roadway, `${where}.roadway`),
            direction: nullableStr(rec.direction, `${where}.direction`),
            location: str(rec.location, `${where}.location`),
            lat: num(rec.lat, `${where}.lat`),
            lon: num(rec.lon, `${where}.lon`),
            video_url: nullableStr(rec.video_url, `${where}.video_url`),
            video_auth: bool(rec.video_auth, `${where}.video_auth`),
            link_id: nullableStr(rec.link_id, `${where}.link_id`),
            source_system: str(rec.source_system, `${where}.source_system`),
            mile_marker: nullableNum(rec.mile_marker, `${where}.mile_marker`),
        };
    });
}
/** A region graph, kept close to the file's own shape: the server hands most of it straight to the wall, and the parts it rewrites (camera ids) are checked here. */
export function loadGraph(path) {
    const data = obj(readJson(path), path);
    const meta = obj(data.meta, `${path}.meta`);
    const graph = data;
    arr(data.sites, `${path}.sites`);
    arr(data.cameras, `${path}.cameras`);
    arr(data.edges, `${path}.edges`);
    str(meta.region, `${path}.meta.region`);
    for (const [i, value] of graph.cameras.entries()) {
        const cam = obj(value, `${path}.cameras[${i}]`);
        num(cam.id, `${path}.cameras[${i}].id`);
        str(cam.source, `${path}.cameras[${i}].source`);
    }
    for (const [i, value] of graph.sites.entries()) {
        const site = obj(value, `${path}.sites[${i}]`);
        arr(site.cameras, `${path}.sites[${i}].cameras`);
    }
    return graph;
}
/** Traffic counts for one region, or null where there are none. Absent is the ordinary case: only Florida publishes a count layer this project has joined, so every other city scores on road class alone. */
export function loadAadt(root, region) {
    const path = dataFile(root, `aadt_${region}.json`);
    if (!existsSync(path))
        return null;
    const data = obj(readJson(path), path);
    const table = obj(data.cameras, `${path}.cameras`);
    const cameras = new Map();
    for (const [key, value] of Object.entries(table)) {
        const where = `${path}.cameras.${key}`;
        const id = Number(key);
        if (!Number.isInteger(id))
            throw new DataError(`${where}: camera id is not an integer`);
        const rec = obj(value, where);
        cameras.set(id, {
            aadt: num(rec.aadt, `${where}.aadt`),
            year: nullableNum(rec.year, `${where}.year`),
            county: nullableStr(rec.county, `${where}.county`),
            truck_pct: nullableNum(rec.truck_pct, `${where}.truck_pct`),
            distance_m: num(rec.distance_m, `${where}.distance_m`),
            aligned: bool(rec.aligned, `${where}.aligned`),
        });
    }
    return {
        region: str(data.region, `${path}.region`),
        source: typeof data.source === 'string' ? data.source : '',
        attribution: typeof data.attribution === 'string' ? data.attribution : '',
        terms_url: typeof data.terms_url === 'string' ? data.terms_url : '',
        cameras,
    };
}
export function loadNationalIndex(root) {
    const path = join(root, 'data', 'national_index.json');
    if (!existsSync(path))
        return { sources: {} };
    const data = obj(readJson(path), 'national_index.json');
    const sources = obj(data.sources, 'national_index.json.sources');
    const out = {};
    for (const [key, value] of Object.entries(sources)) {
        const rec = obj(value, `national_index.json.sources.${key}`);
        const ids = arr(rec.ids, `national_index.json.sources.${key}.ids`);
        const lat = arr(rec.lat, `national_index.json.sources.${key}.lat`);
        const lon = arr(rec.lon, `national_index.json.sources.${key}.lon`);
        // Parallel arrays only mean anything together: a short one would silently drop or misplace cameras on the country map.
        if (ids.length !== lat.length || lat.length !== lon.length) {
            throw new DataError(`national_index.json.sources.${key}: parallel arrays differ in length (${ids.length}/${lat.length}/${lon.length})`);
        }
        out[key] = { ids, lat, lon };
    }
    return { sources: out };
}
/** State outlines. This file is the one place in the project that carries GeoJSON order, so the rings are branded as such here, at the boundary, and nowhere downstream can mix them with the graph's [lat, lon]. */
export function loadStates(root) {
    const path = join(root, 'data', 'us_states.json');
    if (!existsSync(path))
        return { attribution: '', states: {} };
    const data = obj(readJson(path), 'us_states.json');
    const table = obj(data.states, 'us_states.json.states');
    const states = {};
    for (const [code, value] of Object.entries(table)) {
        const where = `us_states.json.states.${code}`;
        const rec = obj(value, where);
        states[code] = {
            name: str(rec.name, `${where}.name`),
            polygons: arr(rec.polygons, `${where}.polygons`).map((ring, i) => arr(ring, `${where}.polygons[${i}]`).map((point, j) => {
                const pair = arr(point, `${where}.polygons[${i}][${j}]`);
                return asLonLat([num(pair[0], `${where}.polygons[${i}][${j}][0]`), num(pair[1], `${where}.polygons[${i}][${j}][1]`)]);
            })),
        };
    }
    return { attribution: typeof data.attribution === 'string' ? data.attribution : '', states };
}
/** Road polylines grouped by highway class, from the cached Overpass extract the graph was built from. There is no tile layer anywhere in this project, so the map background is drawn from this. Coordinates are [lat, lon] rounded to five decimals, about a metre. */
export function roadBackground(path) {
    if (!existsSync(path))
        return {};
    const data = obj(readJson(path), path);
    const roads = {};
    for (const value of arr(data.elements ?? [], `${path}.elements`)) {
        const way = value;
        if (way.type !== 'way' || !way.geometry || way.geometry.length === 0)
            continue;
        const cls = way.tags?.highway;
        if (!cls)
            continue;
        const line = way.geometry.map((point) => asLatLon([round(point.lat, 5), round(point.lon, 5)]));
        (roads[cls] ??= []).push(line);
    }
    return roads;
}
/** Rounds to a number of decimals the way Python's round(x, n) does.
 *
 * Not `Math.round(x * 10**n) / 10**n`: scaling first introduces its own error and rounds a negative half the wrong way, which showed up as fifth-decimal disagreements on about one road coordinate in a thousand against the Python server. `toFixed` converts the true binary value, and on every case checked it agrees with Python, including the ties where Python's round-half-to-even applies. */
export function round(value, digits) {
    return Number(value.toFixed(digits));
}
//# sourceMappingURL=config.js.map