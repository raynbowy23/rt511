/** An Albers USA style composite projection: a conic equal-area for the lower 48, with Alaska and Hawaii projected in conics of their own and placed under the south-west corner.
 *
 * Projecting Alaska in the same conic as the lower 48 either swallows the map in empty ocean or smears it across the top. The views now lift each covered state out on its own (see `slabs.ts`), so only a state's own shape matters here, and the placement of the insets is simply where Alaska and Hawaii would sit on a composite map. */

import { latOfLonLat, lonOfLonLat, type LonLat } from '@rt511/shared';

export type ProjGroup = 'conus' | 'alaska' | 'hawaii';

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Conic = (lon: number, lat: number) => [number, number];

const RAD = Math.PI / 180;

/** Albers conic equal-area. Returns map units with y already flipped so that south is down. */
function conic(lat0: number, lon0: number, lat1: number, lat2: number): Conic {
  const phi1 = lat1 * RAD;
  const phi2 = lat2 * RAD;
  const n = (Math.sin(phi1) + Math.sin(phi2)) / 2;
  const c = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
  const rho0 = Math.sqrt(c - 2 * n * Math.sin(lat0 * RAD)) / n;
  return (lon, lat) => {
    const rho = Math.sqrt(Math.max(0, c - 2 * n * Math.sin(lat * RAD))) / n;
    const theta = n * ((lon - lon0) * RAD);
    return [rho * Math.sin(theta), -(rho0 - rho * Math.cos(theta))];
  };
}

const CONUS = conic(37.5, -96, 29.5, 45.5);
const ALASKA = conic(50, -154, 55, 65);
const HAWAII = conic(20, -157, 8, 18);

interface Placement {
  conic: Conic;
  scale: number;
  dx: number;
  dy: number;
}

export class AlbersUsa {
  private readonly placements: Record<ProjGroup, Placement>;

  /** Placement is derived from the geometry actually supplied, so the insets sit correctly whatever outlines the backend sends. */
  constructor(points: Record<ProjGroup, LonLat[]>) {
    const conusBox = extent(CONUS, points.conus);
    const width = conusBox.maxX - conusBox.minX;
    const height = conusBox.maxY - conusBox.minY;

    const place = (group: ProjGroup, proj: Conic, fraction: number, left: number, gap: number): Placement => {
      const raw = extent(proj, points[group]);
      const rawWidth = Math.max(1e-9, raw.maxX - raw.minX);
      const scale = (width * fraction) / rawWidth;
      return {
        conic: proj,
        scale,
        dx: conusBox.minX + width * left - raw.minX * scale,
        dy: conusBox.maxY + height * gap - raw.minY * scale,
      };
    };

    this.placements = {
      conus: { conic: CONUS, scale: 1, dx: 0, dy: 0 },
      alaska: place('alaska', ALASKA, 0.3, 0.0, 0.03),
      hawaii: place('hawaii', HAWAII, 0.1, 0.38, 0.06),
    };
  }

  project(lon: number, lat: number, group: ProjGroup): [number, number] {
    const placement = this.placements[group];
    const [x, y] = placement.conic(lon, lat);
    return [x * placement.scale + placement.dx, y * placement.scale + placement.dy];
  }
}

/** Which sub-projection a state belongs to. */
export function groupForState(code: string): ProjGroup {
  if (code === 'AK') return 'alaska';
  if (code === 'HI') return 'hawaii';
  return 'conus';
}

function extent(proj: Conic, points: LonLat[]): Box {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const point of points) {
    const [x, y] = proj(lonOfLonLat(point), latOfLonLat(point));
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  }
  return box;
}
