import type { CatalogCamera } from './config.js';

/** Sparse national sampling of cities nobody is watching. Ten anchors per city at one frame per 600 seconds cost about 0.017 requests a second per city, half a request a second across thirty cities. */
export const RADAR = {
  RADAR_PER_REGION: 10,
  /** Ten minutes between frames keeps that budget, including retries and unchanged images. It is also why the board takes ten to twenty minutes to fill after a start, since a camera needs two frames before it has a score. */
  RADAR_PERIOD_S: 600,
  /** Hourly rotation changes which cameras spend the same budget without adding a warmup poll. */
  RADAR_ROTATE_S: 3600,
  /** Recomputing local selections every thirty seconds adds no DOT requests to the frame budget. */
  RADAR_TICK_S: 30,
} as const;

/** Start with the strongest road priors, then walk the same ordering in bounded batches so smaller roads also get sampled. Elapsed time starts with this server rather than the Unix epoch. */
export function selectRadarAnchors(cameras: ReadonlyMap<number, CatalogCamera>, watching: ReadonlySet<string>, prior: (uid: number) => number, elapsedS: number): number[] {
  const regions = new Map<string, number[]>();
  for (const [uid, camera] of cameras) {
    if (watching.has(camera.region)) continue;
    const ids = regions.get(camera.region) ?? [];
    ids.push(uid);
    regions.set(camera.region, ids);
  }
  const anchors: number[] = [];
  for (const ids of regions.values()) {
    ids.sort((a, b) => prior(b) - prior(a) || cameras.get(a)!.id - cameras.get(b)!.id || a - b);
    const offset = Math.floor(Math.max(0, elapsedS) / RADAR.RADAR_ROTATE_S) * RADAR.RADAR_PER_REGION;
    for (let i = 0; i < Math.min(ids.length, RADAR.RADAR_PER_REGION); i++) anchors.push(ids[(offset + i) % ids.length]!);
  }
  return anchors;
}
