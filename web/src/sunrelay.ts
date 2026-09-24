import { solarElevation } from '@rt511/shared';

/** The sun between these heights is golden hour through civil twilight, the stretch worth watching. */
const WINDOW_DEG = 6;
/** How far ahead to look for a city's next sunset or sunrise. */
const HORIZON_S = 24 * 3600;
const STEP_S = 60;

export interface RelayCity {
  key: string;
  name: string;
  lat: number;
  lon: number;
}

export type Phase = 'sunset' | 'sunrise' | 'waiting' | 'night';

export interface RelayPick {
  city: RelayCity;
  phase: Phase;
  /** Degrees of sun above the horizon at the city now. */
  elevation: number;
  /** What happens next and where, for the readout: the next sunset after this one, or at night the first sunrise. */
  next: { city: RelayCity; at: number; event: 'sunset' | 'sunrise' } | null;
}

function setting(city: RelayCity, now: number): boolean {
  return solarElevation(city.lat, city.lon, now + 600) < solarElevation(city.lat, city.lon, now);
}

/** When the sun next crosses the horizon at a city, going down for a sunset or up for a sunrise, found by stepping a minute at a time. Null if it does not within a day, which cannot happen at these latitudes but is not assumed. */
function nextCrossing(city: RelayCity, now: number, down: boolean): number | null {
  let before = solarElevation(city.lat, city.lon, now);
  for (let t = now + STEP_S; t <= now + HORIZON_S; t += STEP_S) {
    const after = solarElevation(city.lat, city.lon, t);
    if (down ? before > 0 && after <= 0 : before <= 0 && after > 0) return t;
    before = after;
  }
  return null;
}

export const nextSunset = (city: RelayCity, now: number): number | null => nextCrossing(city, now, true);
export const nextSunrise = (city: RelayCity, now: number): number | null => nextCrossing(city, now, false);

/** The city to show now. A sun near the horizon wins, setting before rising; failing that, the lowest setting sun, which is the next sunset on its way; and when it is night everywhere, the city where the sun rises first, so the relay never goes dark. */
export function pickRelay(cities: RelayCity[], now: number): RelayPick | null {
  if (cities.length === 0) return null;
  const read = cities.map((city) => ({ city, elevation: solarElevation(city.lat, city.lon, now), down: setting(city, now) }));
  const near = (r: { elevation: number }): boolean => Math.abs(r.elevation) <= WINDOW_DEG;
  const byNearness = (a: { elevation: number }, b: { elevation: number }): number => Math.abs(a.elevation) - Math.abs(b.elevation);
  const sunset = read.filter((r) => r.down && near(r)).sort(byNearness)[0];
  const sunrise = read.filter((r) => !r.down && near(r)).sort(byNearness)[0];
  const lowestSetting = read.filter((r) => r.down && r.elevation > 0).sort((a, b) => a.elevation - b.elevation)[0];
  const firstLight = read.map((r) => ({ r, at: nextSunrise(r.city, now) ?? Infinity })).sort((a, b) => a.at - b.at)[0];

  if (sunset || sunrise || lowestSetting) {
    const chosen = (sunset ?? sunrise ?? lowestSetting)!;
    const phase: Phase = sunset ? 'sunset' : sunrise ? 'sunrise' : 'waiting';
    // The handoff is to whichever other city sets next. A city already past its sunset hands off from now, not from tomorrow's.
    const from = chosen.elevation <= 0 ? now : (nextSunset(chosen.city, now) ?? now);
    const upcoming = cities
      .filter((city) => city.key !== chosen.city.key)
      .map((city) => ({ city, at: nextSunset(city, now) }))
      .filter((c): c is { city: RelayCity; at: number } => c.at !== null && c.at > from)
      .sort((a, b) => a.at - b.at)[0];
    return { city: chosen.city, phase, elevation: chosen.elevation, next: upcoming ? { ...upcoming, event: 'sunset' } : null };
  }
  // Night everywhere: show the city whose sun comes up first, and say when.
  const dawn = firstLight!;
  return { city: dawn.r.city, phase: 'night', elevation: dawn.r.elevation, next: Number.isFinite(dawn.at) ? { city: dawn.r.city, at: dawn.at, event: 'sunrise' } : null };
}
