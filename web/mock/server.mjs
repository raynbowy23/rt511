// Mock of the rt511 server: same routes, same shapes, invented data, and procedurally drawn PNG frames, so the wall can be developed and screenshotted with no backend, no network and no agency's cameras. Plain Node, no dependencies. Every name and picture here is made up, and the attribution says so: crediting a real agency for a drawn frame would misrepresent that agency.

import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.PORT ?? 8511);
const INTERVAL_S = 60;
const RING = 30;
const STARTED_AT = Date.now() / 1000 - 8 * 60;
// Site ids are namespaced by region in the real backend, and the map and minimap both read the region out of that prefix, so the mock namespaces them too.
const REGION = 'mock-city';
const REGION_NAME = 'Mock City';
const SOURCE = 'mock';
const CAMERA_ATTRIBUTION = 'Synthetic frames drawn by the mock server. No agency data.';
const DISCLAIMER = 'Mock data. Every camera, road and picture on this page is invented for development.';
const ROAD_ATTRIBUTION = 'Road data © OpenStreetMap contributors (ODbL)';
const BBOX = [30.35, -84.5, 30.6, -84.1];

// Deterministic PRNG so a given camera looks the same across restarts.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- Synthetic graph ------------------------------------------------------
// An I-10 style freeway running roughly east-west with paired directional sites at each mile marker, plus a surface street chain crossing it, so every edge kind in the contract appears.

const sites = [];
const cameras = [];
const edges = [];
let nextCam = 3500;

function addSite(id, lat, lon, isFreeway, roadway, extra) {
  const site = { id: `${REGION}:${id}`, lat, lon, is_freeway: isFreeway, roadway, mile_marker: null, bearing: null, cameras: [], ...extra };
  sites.push(site);
  return site;
}

function addCamera(site, direction, location, hasVideo) {
  const id = nextCam++;
  cameras.push({
    id,
    region: REGION,
    roadway: site.roadway,
    direction,
    location,
    lat: site.lat + (Math.random() - 0.5) * 1e-4,
    lon: site.lon + (Math.random() - 0.5) * 1e-4,
    is_freeway: site.is_freeway,
    site: site.id,
    has_video: hasVideo,
    snapshot_url: `https://example.invalid/mock/Cctv/${id}`,
  });
  site.cameras.push(id);
  return id;
}

const MM_START = 187.0;
const MM_COUNT = 14;
const freewayEB = [];
const freewayWB = [];

for (let i = 0; i < MM_COUNT; i++) {
  const mm = MM_START + i * 1.8;
  const lat = 30.472 + i * 0.0016;
  const lon = -84.49 + i * 0.0245;
  const eb = addSite(`S${String(i * 2 + 1).padStart(3, '0')}`, lat - 0.0006, lon, true, 'I-10', { mile_marker: Number(mm.toFixed(1)), bearing: 89.0 });
  const wb = addSite(`S${String(i * 2 + 2).padStart(3, '0')}`, lat + 0.0006, lon, true, 'I-10', { mile_marker: Number(mm.toFixed(1)), bearing: 269.0 });
  addCamera(eb, 'E', `I10-MM ${mm.toFixed(1)}EB`, true);
  addCamera(wb, 'W', `I10-MM ${mm.toFixed(1)}WB`, true);
  freewayEB.push(eb);
  freewayWB.push(wb);
  edges.push({ src: eb.id, dst: wb.id, kind: 'sister', length_m: 0, tt_s: 0, geometry: [[eb.lat, eb.lon], [wb.lat, wb.lon]] });
}

function chain(list, kind) {
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    const len = 2900 + Math.round(Math.random() * 600);
    edges.push({
      src: a.id,
      dst: b.id,
      kind,
      length_m: len,
      tt_s: Number((len / 29.0).toFixed(1)),
      geometry: [[a.lat, a.lon], [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2 + 0.0008], [b.lat, b.lon]],
    });
  }
}

chain(freewayEB, 'freeway');
chain([...freewayWB].reverse(), 'freeway');

const STREETS = [
  ['Apalachee Pkwy', 14],
  ['N Monroe St', 12],
  ['Capital Cir NE', 13],
  ['W Tennessee St', 12],
  ['Thomasville Rd', 10],
  ['S Adams St', 9],
  ['Gaines St', 8],
  ['Mahan Dr', 11],
  ['Blair Stone Rd', 9],
  ['Orange Ave', 8],
];
const CROSS = ['at Blair Stone Rd', 'at Magnolia Dr', 'at Paul Russell Rd', 'at Conner Blvd', 'at Tharpe St', 'at Pensacola St', 'at Lafayette St', 'at Bradford Rd'];

let siteNo = sites.length;
for (const [name, n] of STREETS) {
  const base = sites.length;
  const list = [];
  for (let i = 0; i < n; i++) {
    const lat = 30.44 + Math.random() * 0.055;
    const lon = -84.46 + Math.random() * 0.12;
    const s = addSite(`S${String(++siteNo).padStart(3, '0')}`, lat, lon, false, name, {});
    addCamera(s, ['N', 'E', 'S', 'W'][i % 4], `${name} ${CROSS[(base + i) % CROSS.length]}`, Math.random() > 0.08);
    list.push(s);
  }
  list.sort((a, b) => a.lon - b.lon);
  chain(list, 'street');
  // One ramp tying the street chain to the nearest freeway site, so the graph is connected and ramp edges exist.
  const anchor = list[0];
  const near = freewayEB.reduce((best, s) => (Math.abs(s.lon - anchor.lon) < Math.abs(best.lon - anchor.lon) ? s : best), freewayEB[0]);
  edges.push({ src: near.id, dst: anchor.id, kind: 'ramp', length_m: 640, tt_s: 34.0, geometry: [[near.lat, near.lon], [anchor.lat, anchor.lon]] });
}

const GRAPH = {
  meta: {
    region: REGION,
    region_name: REGION_NAME,
    attribution: CAMERA_ATTRIBUTION,
    regions: [{ region: REGION, region_name: REGION_NAME, source: SOURCE, attribution: CAMERA_ATTRIBUTION, bbox: BBOX }],
    built_at: STARTED_AT,
    sites: sites.length,
    cameras: cameras.length,
    edges: edges.length,
  },
  sites,
  cameras,
  edges,
};

// --- Synthetic roads ------------------------------------------------------
// Enough geometry to exercise the map view: a gridded street network over the bbox, a couple of highways along the freeway corridor, and ramps between them. Nowhere near a real extract, but the same shape and the same order of magnitude.

function buildRoads() {
  const [south, west, north, east] = BBOX;
  const roads = {};
  const put = (cls, line) => (roads[cls] ??= []).push(line);
  const jitter = (r, amount) => (r() - 0.5) * amount;

  const r = rng(20260918);
  for (let i = 0; i < 26; i++) {
    const lat = south + ((north - south) * (i + 0.5)) / 26;
    const line = [];
    for (let j = 0; j <= 40; j++) line.push([lat + jitter(r, 0.002), west + ((east - west) * j) / 40]);
    put(i % 5 === 0 ? 'secondary' : i % 3 === 0 ? 'tertiary' : 'unclassified', line);
  }
  for (let i = 0; i < 34; i++) {
    const lon = west + ((east - west) * (i + 0.5)) / 34;
    const line = [];
    for (let j = 0; j <= 30; j++) line.push([south + ((north - south) * j) / 30, lon + jitter(r, 0.002)]);
    put(i % 6 === 0 ? 'primary' : i % 3 === 0 ? 'tertiary' : 'unclassified', line);
  }
  // The freeway the camera sites sit on, plus a trunk and its ramps.
  const mainline = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    mainline.push([30.472 + t * 0.022 + Math.sin(t * 9) * 0.0015, -84.49 + t * 0.343]);
  }
  put('motorway', mainline);
  put('trunk', mainline.map(([lat, lon]) => [lat - 0.03 + Math.cos(lon) * 0.004, lon]));
  for (let i = 4; i < 56; i += 6) {
    const a = mainline[i];
    put('motorway_link', [a, [a[0] - 0.012, a[1] + 0.006]]);
    put('primary_link', [[a[0] - 0.012, a[1] + 0.006], [a[0] - 0.02, a[1] + 0.012]]);
  }
  return roads;
}

const ROADS = buildRoads();

// --- National index -------------------------------------------------------
// Enough of the country payload to exercise the landing view: a few blocky stand-in state outlines in GeoJSON [lon, lat] order (the opposite of everything else here, exactly as the real endpoint does it), the mock's own cameras as a source, and this region marked as served.

function buildNational() {
  const box = (west, south, east, north) => [[
    [west, south], [east, south], [east, north], [west, north], [west, south],
  ]];
  const states = {
    FL: { name: 'Florida', polygons: box(-87.6, 25.1, -80.1, 31.0) },
    GA: { name: 'Georgia', polygons: box(-85.6, 30.4, -80.8, 35.0) },
    AL: { name: 'Alabama', polygons: box(-88.5, 30.2, -84.9, 35.0) },
    SC: { name: 'South Carolina', polygons: box(-83.4, 32.0, -78.5, 35.2) },
    TN: { name: 'Tennessee', polygons: box(-90.3, 35.0, -81.6, 36.7) },
    MS: { name: 'Mississippi', polygons: box(-91.7, 30.2, -88.1, 35.0) },
  };
  return {
    attribution: 'State boundaries are crude stand-ins in this mock',
    states,
    covered_states: ['FL'],
    sources: {
      [SOURCE]: {
        name: 'Mock source',
        states: ['FL'],
        has_video: true,
        attribution: CAMERA_ATTRIBUTION,
        cameras: {
          ids: cameras.map((c) => c.id),
          lat: cameras.map((c) => c.lat),
          lon: cameras.map((c) => c.lon),
        },
      },
    },
    regions: [
      {
        key: REGION,
        name: REGION_NAME,
        source: SOURCE,
        center: [(BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2],
        bbox: BBOX,
        radius_km: null,
        built: true,
        served: true,
        cameras: cameras.length,
        cataloged: cameras.length,
      },
      {
        key: 'jacksonville-fl',
        name: 'Jacksonville, FL',
        source: SOURCE,
        center: [30.33, -81.66],
        bbox: [30.2, -81.8, 30.5, -81.5],
        radius_km: 12.0,
        built: true,
        served: false,
        cameras: 0,
        cataloged: 0,
      },
    ],
  };
}

const NATIONAL = buildNational();

// --- Poll state -----------------------------------------------------------
// Activity drifts on a slow sine per camera with a little noise, so the ranking really does churn and the wall is seen breathing rather than frozen.

const state = new Map();
for (const c of cameras) {
  const r = rng(c.id * 2654435761);
  state.set(c.id, {
    phase: r() * Math.PI * 2,
    period: 70 + r() * 160,
    gain: 0.25 + r() * 0.7,
    brightness: 0.18 + r() * 0.5,
    // A few cameras never produce frames, to exercise the placeholder path.
    silent: r() < 0.06,
    frames: [],
    lastAppend: 0,
  });
}

function tick(now) {
  for (const c of cameras) {
    const st = state.get(c.id);
    if (st.silent) continue;
    if (now - st.lastAppend < INTERVAL_S * 0.5) continue;
    st.lastAppend = now;
    const wave = 0.5 + 0.5 * Math.sin((now / st.period) * Math.PI * 2 + st.phase);
    const diff = Math.max(0.0015, (0.004 + wave * 0.055 * st.gain) * (0.75 + Math.random() * 0.5));
    st.frames.push({ ts: now, brightness: Number((st.brightness + (Math.random() - 0.5) * 0.06).toFixed(3)), diff: Number(diff.toFixed(4)) });
    if (st.frames.length > RING) st.frames.shift();
  }
}

// Backfill so the ring buffers are populated the moment the page loads.
for (let t = STARTED_AT; t <= Date.now() / 1000; t += INTERVAL_S * 0.5) tick(t);
setInterval(() => tick(Date.now() / 1000), 5000);

function activityOf(st) {
  if (st.frames.length < 3) return null;
  const diffs = st.frames.map((f) => f.diff).filter((d) => d != null);
  const base = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const last = diffs[diffs.length - 1];
  return Number(Math.max(0, Math.min(1, last / (base * 2.2))).toFixed(3));
}

// --- PNG generation -------------------------------------------------------
// A crude night road scene: sky gradient, road surface, lane dashes, and headlight blobs whose count and position follow the frame's diff metric, so a busy camera visibly has more going on.

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const W = 320;
const H = 240;
const snapCache = new Map();

function scene(camId, frameIdx, frame) {
  const key = `${camId}:${frameIdx}`;
  const hit = snapCache.get(key);
  if (hit) return hit;
  const r = rng(camId * 7919 + frameIdx * 104729);
  const buf = Buffer.alloc(W * H * 3);
  const horizon = Math.round(H * (0.34 + r() * 0.1));
  const warm = r();
  const brightness = frame.brightness ?? 0.35;
  const put = (x, y, rr, gg, bb) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    buf[i] = Math.max(buf[i], Math.min(255, rr));
    buf[i + 1] = Math.max(buf[i + 1], Math.min(255, gg));
    buf[i + 2] = Math.max(buf[i + 2], Math.min(255, bb));
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let rr;
      let gg;
      let bb;
      if (y < horizon) {
        const t = y / horizon;
        rr = 14 + t * 34 * (0.6 + warm);
        gg = 18 + t * 32;
        bb = 28 + t * 44;
      } else {
        const t = (y - horizon) / (H - horizon);
        rr = 26 + t * 26;
        gg = 26 + t * 25;
        bb = 30 + t * 27;
      }
      const n = (r() - 0.5) * 16;
      const k = 0.55 + brightness;
      buf[i] = Math.max(0, Math.min(255, (rr + n) * k));
      buf[i + 1] = Math.max(0, Math.min(255, (gg + n) * k));
      buf[i + 2] = Math.max(0, Math.min(255, (bb + n) * k));
    }
  }
  // Lane dashes receding to a vanishing point.
  const vx = W * (0.3 + r() * 0.4);
  for (let lane = -1; lane <= 1; lane++) {
    for (let y = horizon + 4; y < H; y += 9) {
      const t = (y - horizon) / (H - horizon);
      const x = vx + lane * t * W * 0.42;
      const w = Math.max(1, Math.round(t * 5));
      for (let dx = -w; dx <= w; dx++) for (let dy = 0; dy < Math.max(1, t * 4); dy++) put(Math.round(x + dx), y + dy, 150, 148, 138);
    }
  }
  // Vehicles: headlights ahead, tail lights receding. Count follows the frame's diff.
  const n = Math.round(1 + (frame.diff ?? 0.01) * 110);
  for (let v = 0; v < n; v++) {
    const t = 0.1 + r() * 0.9;
    const y = Math.round(horizon + t * (H - horizon) * 0.95);
    const x = Math.round(vx + (r() - 0.5) * 2 * t * W * 0.5);
    const rad = Math.max(1, Math.round(t * 5));
    const tail = r() < 0.45;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad * 2; dx <= rad * 2; dx++) {
        const f = Math.max(0, 1 - Math.hypot(dx / 2, dy) / rad);
        if (f <= 0) continue;
        if (tail) put(x + dx, y + dy, 210 * f, 40 * f, 36 * f);
        else put(x + dx, y + dy, 235 * f, 226 * f, 190 * f);
      }
    }
  }
  const out = png(W, H, buf);
  snapCache.set(key, out);
  if (snapCache.size > 4000) snapCache.clear();
  return out;
}

// --- Routing --------------------------------------------------------------

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(s);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/api/regions') {
    return json(res, 200, {
      active: REGION,
      regions: [{ key: REGION, name: REGION_NAME, source: SOURCE, attribution: CAMERA_ATTRIBUTION, license: 'Invented for development', terms_url: '', notice: '', bbox: BBOX, cameras: cameras.length }],
      disclaimer: DISCLAIMER,
    });
  }

  if (p === '/api/graph') return json(res, 200, GRAPH);

  if (p === '/api/national') {
    return json(res, 200, NATIONAL);
  }

  if (p === '/api/roads') {
    const asked = url.searchParams.get('region');
    if (asked && asked !== REGION) return json(res, 200, { attribution: ROAD_ATTRIBUTION, regions: {} });
    return json(res, 200, { attribution: ROAD_ATTRIBUTION, regions: { [REGION]: { bbox: BBOX, roads: ROADS } } });
  }

  if (p === '/api/cameras') {
    return json(res, 200, {
      interval_s: INTERVAL_S,
      started_at: STARTED_AT,
      cameras: cameras.map((c) => {
        const st = state.get(c.id);
        const last = st.frames[st.frames.length - 1];
        return {
          id: c.id,
          region: c.region,
          frames: st.frames.length,
          polls: st.frames.length + 5,
          unchanged: 5,
          unavailable: 0,
          errors: 0,
          last_ts: last ? last.ts : null,
          brightness: last ? last.brightness : null,
          diff: last ? last.diff : null,
          activity: activityOf(st),
        };
      }),
    });
  }

  let m = p.match(/^\/api\/frames\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const st = state.get(id);
    if (!st) return json(res, 404, { error: 'unknown camera' });
    return json(res, 200, { id, frames: st.frames.map((f, k) => ({ k, ts: f.ts, brightness: f.brightness, diff: k === 0 ? null : f.diff })) });
  }

  m = p.match(/^\/api\/snap\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const st = state.get(id);
    if (!st || st.frames.length === 0) return json(res, 404, { error: 'no frames' });
    let k = Number(url.searchParams.get('k') ?? -1);
    if (!Number.isFinite(k)) k = -1;
    if (k < 0) k = st.frames.length + k;
    k = Math.max(0, Math.min(st.frames.length - 1, k));
    const body = scene(id, k, st.frames[k]);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'public, max-age=3600' });
    return res.end(body);
  }

  m = p.match(/^\/api\/stream\/(\d+)$/);
  if (m) {
    if (!cameras.some((c) => c.id === Number(m[1]))) return json(res, 404, { error: 'unknown camera' });
    // The mock cannot synthesize video, so every camera answers as one that publishes no stream and the hero falls back to replay stills, which is the behavior worth exercising.
    return json(res, 404, { error: 'camera publishes no stream' });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`rt511 mock backend on http://127.0.0.1:${PORT} (${cameras.length} cameras, ${sites.length} sites, ${edges.length} edges)`);
});
