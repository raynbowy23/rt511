import { describe, expect, it } from 'vitest';
import { vehicles } from './NightShift';

describe('vehicles', () => {
  it('counts by kind, most first, in words', () => {
    expect(vehicles({ status: 'counted', vehicles: 3, by_class: { truck: 1, car: 2 } })).toBe('2 cars, 1 truck');
  });

  it('pluralizes the irregular ones', () => {
    expect(vehicles({ status: 'counted', vehicles: 2, by_class: { bus: 2 } })).toBe('2 buses');
    expect(vehicles({ status: 'counted', vehicles: 1, by_class: { bus: 1 } })).toBe('1 bus');
  });

  it('says so when the road is empty', () => {
    expect(vehicles({ status: 'counted', vehicles: 0, by_class: {} })).toBe('no vehicles');
  });
});
