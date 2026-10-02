import { capHeld, type BoardCamera, type BoardResponse, type CameraState } from '../../shared/src/index.js';
import { driver } from './attention.js';
import type { CatalogCamera } from './config.js';
import { RADAR } from './radar.js';

/** Thirty tiles keep the national board readable without changing which cameras the server polls. */
export const BOARD_SIZE = 30;

/** At most this many board places go to cameras held by a floor. Beyond it they compete on movement alone, so a burst of incidents in one state and the queues behind them cannot fill the national board. */
const BOARD_HELD_LIMIT = BOARD_SIZE / 2;

/** A camera whose newest picture is older than this is left off the board. Two radar periods, so a radar anchor survives one missed sample. A camera in a city that has just been closed stops being polled, and without this its last score would sit on the national board for as long as the process ran, ranked against cameras that are live. */
export const BOARD_MAX_AGE_S = 2 * RADAR.RADAR_PERIOD_S;

/** Filter metadata describes all scored cameras, even when the requested slice is empty. Selection only reads the same scored states used by the wall. */
export function buildBoard(states: CameraState[], catalog: ReadonlyMap<number, CatalogCamera>, regions: BoardResponse['regions'], isRadar: (uid: number) => boolean, stateFilter: string | null, regionFilter: string | null, now = Date.now() / 1000): BoardResponse {
  const metadata = new Map(regions.map((region) => [region.key, region]));
  const scored: BoardCamera[] = states.flatMap((state) => {
    const camera = catalog.get(state.id);
    const region = camera && metadata.get(camera.region);
    if (!camera || !region || state.polls === 0 || state.attention === null || state.axes === null) return [];
    // A board of live tiles has nothing to show for a camera without a picture, and a stale picture is worse than none.
    if (state.last_ts === null || now - state.last_ts > BOARD_MAX_AGE_S) return [];
    return [{ ...state, region: region.key, region_name: region.name, state: region.state, location: camera.location, roadway: camera.roadway, attention: state.attention, axes: state.axes, driver: driver(state.axes), radar: isRadar(state.id) }];
  });
  const available = new Set(scored.map((camera) => camera.region));
  return {
    cameras: capHeld(
      scored
        .filter((camera) => (!stateFilter || camera.state === stateFilter) && (!regionFilter || camera.region === regionFilter))
        .sort((a, b) => b.attention - a.attention || a.id - b.id)
        .map((camera) => ({ camera, attention: camera.attention, movement: camera.axes.movement ?? 0 })),
      BOARD_HELD_LIMIT,
    )
      .slice(0, BOARD_SIZE)
      .map((entry) => entry.camera),
    states: [...new Set(scored.map((camera) => camera.state))].sort(),
    regions: regions.filter((region) => available.has(region.key)).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
