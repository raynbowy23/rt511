/** What the sky is doing over each city, read from the cameras rather than from a weather service.
 *
 * Brightness is the median of the cameras' mean luma, which the national map paints as the sunset wave. The murk hint fires when most of a city's cameras lose contrast against their own recent pictures at once, and the snow hint when several turn white together.
 *
 * The murk and snow hints are toys, not measurements, with unchecked thresholds. They are only read in daylight, because dusk flattens every picture in a city at once and would otherwise be reported as a storm every evening. */

import { solarElevation, type SkyRegion } from '../../shared/src/index.js';
import { round } from './config.js';
import { median } from './poller.js';

export const SKY = {
  /** A picture older than this does not speak for the sky now. Two radar periods, so a city nobody is watching still counts its sparse anchors. */
  RECENT_S: 1200,
  /** Earlier pictures a camera needs before its usual contrast means anything. A radar anchor gets about six in the hour it is sampled, so this keeps them in play. */
  HISTORY_MIN: 4,
  /** A camera whose contrast is below this share of its own recent median has gone flat. A guess. */
  LOW_RATIO: 0.7,
  /** How many cameras with a known contrast a city needs before it is judged at all, and what share of them must have gone flat together. One flat camera is a smeared lens, most of a city is the weather. Both guesses. */
  MIN_CAMERAS: 4,
  MIN_SHARE: 0.5,
  /** The sun must be at least this high. Below it, the light is changing fast enough that every camera flattens with it. */
  DAYLIGHT_DEG: 10,
  /** A camera has turned white when at least this share of its picture is white, and that share is at least SNOW_RISE above its own recent median, so a camera that always looks at a white wall or a concrete deck never counts. Both guesses. */
  SNOW_WHITE: 0.25,
  SNOW_RISE: 0.15,
  /** How many cameras with a known white share must have turned white together, and what share of them, before a city reads as snow. Three rather than four because rural weather-station cameras are thin on the ground. */
  SNOW_MIN_CAMERAS: 3,
  SNOW_MIN_SHARE: 1 / 3,
} as const;

export interface SkyCamera {
  region: string;
  lastTs: number | null;
  brightness: number | null;
  contrast: number | null;
  /** Recent contrasts, oldest first, with the newest last. */
  contrasts: readonly number[];
  /** The white share of the newest frame and of recent ones, oldest first. */
  white?: number | null;
  whites?: readonly number[];
}

export function readSky(regions: readonly { key: string; name: string; lat: number; lon: number }[], cameras: Iterable<SkyCamera>, now: number): SkyRegion[] {
  const byRegion = new Map<string, SkyCamera[]>();
  for (const camera of cameras) {
    if (camera.lastTs === null || now - camera.lastTs > SKY.RECENT_S) continue;
    const list = byRegion.get(camera.region) ?? [];
    list.push(camera);
    byRegion.set(camera.region, list);
  }
  return regions.map(({ key, name, lat, lon }) => {
    const recent = byRegion.get(key) ?? [];
    const lights = recent.flatMap((camera) => (camera.brightness === null ? [] : [camera.brightness]));
    let known = 0;
    let low = 0;
    let snowKnown = 0;
    let snowWhite = 0;
    for (const camera of recent) {
      // The newest contrast is the one being judged, so it is left out of the median it is judged against.
      const earlier = camera.contrasts.slice(0, -1);
      if (camera.contrast === null || earlier.length < SKY.HISTORY_MIN) continue;
      known++;
      if (camera.contrast < SKY.LOW_RATIO * median(earlier)) low++;
    }
    for (const camera of recent) {
      const earlier = (camera.whites ?? []).slice(0, -1);
      if (camera.white == null || earlier.length < SKY.HISTORY_MIN) continue;
      snowKnown++;
      if (camera.white >= SKY.SNOW_WHITE && camera.white - median(earlier) >= SKY.SNOW_RISE) snowWhite++;
    }
    const sun = solarElevation(lat, lon, now);
    const murky = sun >= SKY.DAYLIGHT_DEG && known >= SKY.MIN_CAMERAS && low / known >= SKY.MIN_SHARE;
    // Daylight only, for the same reason: headlights and floodlights on wet pavement turn a night picture white too.
    const snow = sun >= SKY.DAYLIGHT_DEG && snowWhite >= SKY.SNOW_MIN_CAMERAS && snowWhite / snowKnown >= SKY.SNOW_MIN_SHARE;
    return {
      key,
      name,
      lat,
      lon,
      sun_elevation: round(sun, 1),
      brightness: lights.length ? round(median(lights), 3) : null,
      cameras: recent.length,
      contrast_known: known,
      contrast_low: low,
      snow_known: snowKnown,
      snow_white: snowWhite,
      weather: snow ? 'snow' : murky ? 'murky' : null,
    };
  });
}
