/** What the sky is doing over each city, read from the cameras rather than from a weather service.
 *
 * Two readings. Brightness is the median of the cameras' mean luma, which is what the national map paints as the sunset wave: the east coast going dark first and Las Vegas last. And a murk hint, when most of a city's cameras lose contrast against their own recent pictures at the same time in daylight, which is what rain on the lens, fog and low cloud look like to a thumbnail.
 *
 * The murk hint is a toy, not a measurement. Its thresholds below are guesses that nobody has checked against real weather, and it says so wherever it is shown. It is only ever read in daylight, because dusk flattens every picture in a city at once and would otherwise be reported as a storm every evening. */
import { solarElevation } from '../../shared/src/index.js';
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
};
export function readSky(regions, cameras, now) {
    const byRegion = new Map();
    for (const camera of cameras) {
        if (camera.lastTs === null || now - camera.lastTs > SKY.RECENT_S)
            continue;
        const list = byRegion.get(camera.region) ?? [];
        list.push(camera);
        byRegion.set(camera.region, list);
    }
    return regions.map(({ key, name, lat, lon }) => {
        const recent = byRegion.get(key) ?? [];
        const lights = recent.flatMap((camera) => (camera.brightness === null ? [] : [camera.brightness]));
        let known = 0;
        let low = 0;
        for (const camera of recent) {
            // The newest contrast is the one being judged, so it is left out of the median it is judged against.
            const earlier = camera.contrasts.slice(0, -1);
            if (camera.contrast === null || earlier.length < SKY.HISTORY_MIN)
                continue;
            known++;
            if (camera.contrast < SKY.LOW_RATIO * median(earlier))
                low++;
        }
        const sun = solarElevation(lat, lon, now);
        const murky = sun >= SKY.DAYLIGHT_DEG && known >= SKY.MIN_CAMERAS && low / known >= SKY.MIN_SHARE;
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
            weather: murky ? 'murky' : null,
        };
    });
}
//# sourceMappingURL=sky.js.map