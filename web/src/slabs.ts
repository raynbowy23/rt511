import { latOfLonLat, lonOfLonLat, type NationalResponse } from '@rt511/shared';
import { AlbersUsa, groupForState, type Box } from './albers';

/** The covered states lifted out of the country and set side by side, west to east, on a tilted table.
 *
 * Every state without a source is dropped. Everything here is plain geometry in "world" units, which the views scale and pan; how high a slab floats is left to the view, in screen pixels, so a hover can lift one without recomputing anything. */

/** The tilt: the row is turned this far from the screen's horizontal, then squashed vertically, which is what makes a flat map read as a table seen from a corner. */
const TURN = (-22 * Math.PI) / 180;
const SQUASH = 0.52;
/** How much a state's size is eased toward the others. Zero keeps true relative size, where Vermont would be a speck beside California; one would make every state the same size. */
const EASE = 0.35;
/** The space between neighboring slabs, as a share of the median slab width. */
const GAP = 0.3;

export interface Slab {
  code: string;
  name: string;
  /** The top face, in world units. */
  rings: [number, number][][];
  box: Box;
  /** The middle of the top face, where the label hangs. */
  center: [number, number];
  /** How high this slab floats at rest, in screen pixels. Neighbors differ so the row reads as loose pieces rather than a strip. */
  float: number;
  cameras: number;
}

export interface SlabLayout {
  slabs: Slab[];
  bounds: Box;
  /** Each cataloged camera's world position and slab index, in the order the sources list them. A camera outside every slab has index -1. */
  camX: Float64Array;
  camY: Float64Array;
  camSlab: Int16Array;
  /** The world position of a point in a given state, or null when that state is not a slab. */
  place: (lon: number, lat: number, code: string) => [number, number] | null;
  /** The slab a point falls in, searching every slab, or -1. */
  slabOf: (lon: number, lat: number) => number;
}

interface Local {
  code: string;
  name: string;
  rings: [number, number][][];
  box: Box;
}

export function explode(national: NationalResponse): SlabLayout {
  const projection = new AlbersUsa({
    conus: Object.entries(national.states)
      .filter(([code]) => groupForState(code) === 'conus')
      .flatMap(([, state]) => state.polygons.flat()),
    alaska: national.states.AK?.polygons.flat() ?? [],
    hawaii: national.states.HI?.polygons.flat() ?? [],
  });
  const project = (lon: number, lat: number, code: string): [number, number] => projection.project(lon, lat, groupForState(code));

  const locals: Local[] = [];
  for (const code of national.covered_states) {
    const state = national.states[code];
    if (!state) continue;
    const rings = state.polygons.map((ring) => ring.map((point) => project(lonOfLonLat(point), latOfLonLat(point), code)));
    locals.push({ code, name: state.name, rings, box: boxOf(rings) });
  }
  // West to east by the middle of each state.
  locals.sort((a, b) => a.box.minX + a.box.maxX - (b.box.minX + b.box.maxX));

  const areas = locals.map((local) => (local.box.maxX - local.box.minX) * (local.box.maxY - local.box.minY));
  const reference = median(areas);
  const scales = areas.map((area) => clamp((reference / Math.max(1e-12, area)) ** EASE, 0.6, 2.2));
  const widths = locals.map((local, i) => (local.box.maxX - local.box.minX) * scales[i]!);
  const gap = median(widths) * GAP;

  // Each state's own transform: centered on its box, eased in size, set along the row, then tilted with everything else.
  const transforms: ((x: number, y: number) => [number, number])[] = [];
  let along = 0;
  locals.forEach((local, i) => {
    const s = scales[i]!;
    const cx = (local.box.minX + local.box.maxX) / 2;
    const cy = (local.box.minY + local.box.maxY) / 2;
    const offset = along + widths[i]! / 2;
    along += widths[i]! + gap;
    transforms.push((x, y) => tilt((x - cx) * s + offset, (y - cy) * s));
  });

  const slabs: Slab[] = locals.map((local, i) => {
    const rings = local.rings.map((ring) => ring.map(([x, y]) => transforms[i]!(x, y)));
    const box = boxOf(rings);
    return { code: local.code, name: local.name, rings, box, center: [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2], float: [6, 16, 10, 20, 8, 14, 4, 18][i % 8]!, cameras: 0 };
  });
  const index = new Map(locals.map((local, i) => [local.code, i]));

  const inside = (i: number, x: number, y: number): boolean => {
    const { box, rings } = locals[i]!;
    return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && contains(rings, x, y);
  };
  const slabOf = (lon: number, lat: number): number => {
    for (let i = 0; i < locals.length; i++) {
      const [x, y] = project(lon, lat, locals[i]!.code);
      if (inside(i, x, y)) return i;
    }
    return -1;
  };
  const place = (lon: number, lat: number, code: string): [number, number] | null => {
    const i = index.get(code);
    if (i === undefined) return null;
    const [x, y] = project(lon, lat, code);
    return transforms[i]!(x, y);
  };

  let total = 0;
  for (const source of Object.values(national.sources)) total += source.cameras.ids.length;
  const camX = new Float64Array(total);
  const camY = new Float64Array(total);
  const camSlab = new Int16Array(total).fill(-1);
  let at = 0;
  for (const source of Object.values(national.sources)) {
    const candidates = source.states.map((code) => index.get(code)).filter((i): i is number => i !== undefined);
    const { lat, lon } = source.cameras;
    for (let k = 0; k < lat.length; k++, at++) {
      const la = lat[k] as number;
      const lo = lon[k] as number;
      // A source in one state needs no test. One spanning several is tested against each, and a camera just offshore goes to its nearest.
      let chosen = candidates.length === 1 ? candidates[0]! : -1;
      if (chosen === -1 && candidates.length > 1) {
        let nearest = Infinity;
        for (const i of candidates) {
          const [x, y] = project(lo, la, locals[i]!.code);
          if (inside(i, x, y)) {
            chosen = i;
            break;
          }
          const { box } = locals[i]!;
          const d = Math.hypot(x - (box.minX + box.maxX) / 2, y - (box.minY + box.maxY) / 2);
          if (d < nearest) {
            nearest = d;
            chosen = i;
          }
        }
      }
      if (chosen === -1) continue;
      const [x, y] = project(lo, la, locals[chosen]!.code);
      [camX[at], camY[at]] = transforms[chosen]!(x, y);
      camSlab[at] = chosen;
      slabs[chosen]!.cameras++;
    }
  }

  const bounds = boxOf(slabs.flatMap((slab) => slab.rings));
  return { slabs, bounds, camX, camY, camSlab, place, slabOf };
}

/** The table's two directions in world units: along the row, west to east, and across it. */
export const ALONG = tilt(1, 0);
export const ACROSS = tilt(0, 1);

function tilt(x: number, y: number): [number, number] {
  const cos = Math.cos(TURN);
  const sin = Math.sin(TURN);
  return [x * cos - y * sin, (x * sin + y * cos) * SQUASH];
}

/** Even-odd point in polygon over every ring, so an island is inside and a hole is not. */
export function contains(rings: readonly (readonly [number, number])[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function boxOf(rings: [number, number][][]): Box {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const ring of rings) {
    for (const [x, y] of ring) {
      box.minX = Math.min(box.minX, x);
      box.minY = Math.min(box.minY, y);
      box.maxX = Math.max(box.maxX, x);
      box.maxY = Math.max(box.maxY, y);
    }
  }
  return box;
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
