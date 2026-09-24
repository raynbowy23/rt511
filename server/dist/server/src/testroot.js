/** A scratch repository root holding two small synthetic cities, for tests that start the whole app.
 *
 * Built rather than read from `out/`, because city graphs are generated from OpenStreetMap by the pipeline and are not in the repository: a test that read them passed on the machine that built them and failed on every fresh clone. These cities are straight chains of freeway cameras with made-up coordinates and road attributes, which is everything the app-level tests exercise, and they carry no third-party data. The real source table is copied in, so source keys, blocks and terms are the ones the app runs with. */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** The repository root, from `server/dist/server/src/` where the compiled tests run. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Cameras per synthetic city. Enough to fill a board of thirty for one state and leave radar anchors to choose from. */
export const FIXTURE_CAMERAS = 40;
const CITIES = [
    { key: 'des-moines-ia', name: 'Des Moines, IA', source: 'iowadot', lat: 41.6, lon: -93.6 },
    { key: 'oakland-ca', name: 'Oakland, CA', source: 'caltrans', lat: 37.8, lon: -122.27 },
];
function build(root) {
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'out'), { recursive: true });
    copyFileSync(join(REPO_ROOT, 'data', 'sources.json'), join(root, 'data', 'sources.json'));
    const regions = CITIES.map((city) => ({
        key: city.key,
        name: city.name,
        source: city.source,
        bbox: [city.lat - 0.2, city.lon - 0.2, city.lat + 0.2, city.lon + 0.2],
        center: [city.lat, city.lon],
        radius_km: 15,
        limit: FIXTURE_CAMERAS,
    }));
    writeFileSync(join(root, 'data', 'regions.json'), JSON.stringify(regions));
    for (const city of CITIES) {
        // A camera every kilometre or so due north, one per site, joined into a single northbound freeway.
        const points = Array.from({ length: FIXTURE_CAMERAS }, (_, i) => ({ id: i + 1, lat: city.lat - 0.18 + i * 0.009, lon: city.lon }));
        const catalog = points.map((p) => ({
            id: p.id,
            region: city.key,
            source: city.source,
            image_path: `https://images.example/${city.key}/${p.id}.jpg`,
            roadway: 'I-35',
            direction: 'N',
            location: `I-35 at exit ${p.id}`,
            lat: p.lat,
            lon: p.lon,
            video_url: null,
            video_auth: false,
            link_id: null,
            source_system: 'fixture',
            mile_marker: p.id,
        }));
        const sites = points.map((p) => ({
            id: `${city.key}:S${String(p.id).padStart(3, '0')}`,
            lat: p.lat,
            lon: p.lon,
            is_freeway: true,
            roadway: 'I 35',
            mile_marker: p.id,
            bearing: 0,
            cameras: [p.id],
            snaps: [{ lat: p.lat, lon: p.lon, highway: 'motorway', name: 'I 35', ref: 'I 35', two_way: false, lanes: 3, lanes_forward: null, lanes_backward: null, maxspeed_kmh: 105, maxspeed_source: 'tag', bearing: 0, distance_m: 5 }],
        }));
        const edges = sites.slice(1).map((site, i) => ({
            src: sites[i].id,
            dst: site.id,
            kind: 'freeway',
            length_m: 1000,
            tt_s: 35,
            highways: ['motorway'],
            geometry: [
                [sites[i].lat, sites[i].lon],
                [site.lat, site.lon],
            ],
        }));
        const cameras = catalog.map((c, i) => ({ id: c.id, region: city.key, source: city.source, roadway: c.roadway, direction: c.direction, location: c.location, lat: c.lat, lon: c.lon, mile_marker: c.mile_marker, site: sites[i].id, is_freeway: true, has_video: false }));
        const meta = { region: city.key, region_name: city.name, source: city.source, bbox: regions.find((r) => r.key === city.key).bbox, sites: sites.length, cameras: cameras.length, edges: edges.length, unsnapped: [], report: { edge_kinds: { freeway: edges.length } } };
        writeFileSync(join(root, 'data', `cameras_${city.key}.json`), JSON.stringify(catalog));
        writeFileSync(join(root, 'out', `graph_${city.key}.json`), JSON.stringify({ meta, sites, cameras, edges }));
    }
}
let shared = null;
/** The scratch root, built once per test process and removed when the process exits. */
export function testRoot() {
    if (shared)
        return shared;
    const root = mkdtempSync(join(tmpdir(), 'rt511-root-'));
    build(root);
    process.on('exit', () => rmSync(root, { recursive: true, force: true }));
    shared = root;
    return root;
}
//# sourceMappingURL=testroot.js.map