import { describe, expect, it } from 'vitest';
import { arr, num, obj, ShapeError, str } from './validate';

describe('response checks', () => {
  it('pass values of the right shape straight through', () => {
    expect(obj({ a: 1 }, 'x')).toEqual({ a: 1 });
    expect(arr([1], 'x')).toEqual([1]);
    expect(num(0.5, 'x')).toBe(0.5);
    expect(str('', 'x')).toBe('');
  });

  it('name the field that did not match, which is what makes a backend change debuggable', () => {
    expect(() => num('5', 'cameras[0].period_s')).toThrow(ShapeError);
    expect(() => num('5', 'cameras[0].period_s')).toThrow(/cameras\[0\]\.period_s/);
  });

  it('refuse the near misses', () => {
    expect(() => obj([], 'x')).toThrow(ShapeError);
    expect(() => obj(null, 'x')).toThrow(ShapeError);
    expect(() => num(Number.NaN, 'x')).toThrow(ShapeError);
    expect(() => num(Number.POSITIVE_INFINITY, 'x')).toThrow(ShapeError);
  });
});
