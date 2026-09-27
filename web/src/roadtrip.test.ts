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

  it('reads any state\'s routes, so a new state needs no code change', () => {
    expect(routeOf('OH-161 at Dublin Rd')).toBe('OH-161');
    expect(routeOf('WI 32 at Layton Ave')).toBe('WI-32');
    expect(routeOf('i-35 at 2nd Ave')).toBe('I-35');
  });

  it('takes whichever route comes first', () => {
    expect(routeOf('IA 28 at I-235')).toBe('IA-28');
    expect(routeOf('I-235 at IA 28')).toBe('I-235');
  });

  it('does not read ordinary words as state routes', () => {
    expect(routeOf('Exit ramp in 2 miles')).toBeNull();
    expect(routeOf('Bridge or 4th St')).toBeNull();
  });

  it('is null for a street with no route number', () => {
    expect(routeOf('High St at Main St')).toBeNull();
    expect(routeOf(null)).toBeNull();
    expect(routeOf(undefined)).toBeNull();
  });
});
