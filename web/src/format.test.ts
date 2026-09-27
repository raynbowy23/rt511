import { describe, expect, it } from 'vitest';
import { period } from './format';

describe('period', () => {
  it('says seconds under a minute and whole minutes from there', () => {
    expect(period(5)).toBe('5 s');
    expect(period(15)).toBe('15 s');
    expect(period(60)).toBe('1 min');
    expect(period(300)).toBe('5 min');
  });

  it('rounds, since the server reports periods as it measures them', () => {
    expect(period(4.6)).toBe('5 s');
    expect(period(89)).toBe('1 min');
    expect(period(91)).toBe('2 min');
  });
});
