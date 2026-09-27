import { describe, expect, it } from 'vitest';
import { routeOf } from './roadtrip';

describe('routeOf', () => {
  it('reads the route a road name opens with, the way the signs write it', () => {
    expect(routeOf('I 35')).toBe('I-35');
    expect(routeOf('I-35/80 @ MM 130.2')).toBe('I-35');
    expect(routeOf('IA 5 @ MM 3')).toBe('IA-5');
    expect(routeOf('US-65')).toBe('US-65');
  });

  it('drops leading zeros so one route is one label', () => {
    expect(routeOf('SR 024')).toBe('SR-24');
  });

  it('is null for a street with no route number', () => {
    expect(routeOf('High St at Main St')).toBeNull();
    expect(routeOf(null)).toBeNull();
    expect(routeOf(undefined)).toBeNull();
  });
});
