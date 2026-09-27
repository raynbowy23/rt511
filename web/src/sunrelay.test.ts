import { describe, expect, it } from 'vitest';
import { solarElevation } from '@rt511/shared';
import { nextSunrise, nextSunset, pickRelay, type RelayCity } from './sunrelay';

const PORTLAND: RelayCity = { key: 'portland-or', name: 'Portland, OR', lat: 45.52, lon: -122.68 };
const DES_MOINES: RelayCity = { key: 'des-moines-ia', name: 'Des Moines, IA', lat: 41.6, lon: -93.6 };
const BURLINGTON: RelayCity = { key: 'burlington-vt', name: 'Burlington, VT', lat: 44.48, lon: -73.21 };
const CITIES = [PORTLAND, DES_MOINES, BURLINGTON];
/** Noon Pacific time at the September equinox, a moment when the sun is up over all three. */
const NOON_PT = Date.UTC(2026, 8, 22, 19, 0) / 1000;

describe('nextSunset and nextSunrise', () => {
  it('find the moment the sun crosses the horizon, to the minute', () => {
    const set = nextSunset(PORTLAND, NOON_PT)!;
    expect(set).toBeGreaterThan(NOON_PT);
    expect(solarElevation(PORTLAND.lat, PORTLAND.lon, set - 60)).toBeGreaterThan(0);
    expect(solarElevation(PORTLAND.lat, PORTLAND.lon, set)).toBeLessThanOrEqual(0);
    const rise = nextSunrise(PORTLAND, set)!;
    expect(rise).toBeGreaterThan(set);
    expect(solarElevation(PORTLAND.lat, PORTLAND.lon, rise)).toBeGreaterThan(0);
  });

  it('sets in the east first', () => {
    expect(nextSunset(BURLINGTON, NOON_PT)!).toBeLessThan(nextSunset(DES_MOINES, NOON_PT)!);
    expect(nextSunset(DES_MOINES, NOON_PT)!).toBeLessThan(nextSunset(PORTLAND, NOON_PT)!);
  });
});

describe('pickRelay', () => {
  it('shows the city the sun is setting over, and hands off westward', () => {
    const now = nextSunset(DES_MOINES, NOON_PT)! - 300;
    const pick = pickRelay(CITIES, now)!;
    expect(pick.city.key).toBe('des-moines-ia');
    expect(pick.phase).toBe('sunset');
    expect(pick.next?.city.key).toBe('portland-or');
  });

  it('at night everywhere waits on the first sunrise, in the east', () => {
    const lastSet = nextSunset(PORTLAND, NOON_PT)!;
    const pick = pickRelay(CITIES, lastSet + 3 * 3600)!;
    expect(pick.phase).toBe('night');
    expect(pick.city.key).toBe('burlington-vt');
    expect(pick.next?.event).toBe('sunrise');
  });

  it('has nothing to show with no cities', () => {
    expect(pickRelay([], NOON_PT)).toBeNull();
  });
});
