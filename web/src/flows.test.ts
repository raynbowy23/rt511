import { describe, expect, it } from 'vitest';
import { latLon, latOf, type LatLon } from '@rt511/shared';
import { measure, pointAt, roadPath, type Link } from './flows';

/** A straight road A → B → C → D, with each link's geometry running from one site to the next, plus the reverse links the map adds so attention can spread both ways. */
function road(): Map<string, Link[]> {
  const at = { A: 0, B: 1, C: 2, D: 3 } as const;
  const links = new Map<string, Link[]>();
  const add = (from: keyof typeof at, to: keyof typeof at): void => {
    const points: LatLon[] = [latLon(at[from], 0), latLon((at[from] + at[to]) / 2, 0.1), latLon(at[to], 0)];
    links.set(from, [...(links.get(from) ?? []), { to, points }]);
    links.set(to, [...(links.get(to) ?? []), { to: from, points: [...points].reverse() }]);
  };
  add('A', 'B');
  add('B', 'C');
  add('C', 'D');
  return links;
}

describe('roadPath', () => {
  it('follows the road from one site to another, as one line', () => {
    const path = roadPath(road(), 'A', 'D')!;
    expect(path.map((p) => latOf(p))).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
  });

  it('runs against the direction of travel too, since attention spreads up the road', () => {
    const path = roadPath(road(), 'D', 'B')!;
    expect(latOf(path[0]!)).toBe(3);
    expect(latOf(path[path.length - 1]!)).toBe(1);
  });

  it('draws nothing for sites that are not joined within the hop limit, rather than a straight line', () => {
    expect(roadPath(road(), 'A', 'D', 2)).toBeNull();
    expect(roadPath(road(), 'A', 'nowhere')).toBeNull();
    expect(roadPath(road(), 'A', 'A')).toBeNull();
  });
});

describe('pointAt', () => {
  const line = measure([
    [0, 0],
    [10, 0],
    [10, 10],
  ]);

  it('measures the whole line', () => {
    expect(line.length).toBe(20);
  });

  it('places a point by distance along the line, round the corner', () => {
    expect(pointAt(line, 5)).toEqual([5, 0]);
    expect(pointAt(line, 15)).toEqual([10, 5]);
  });

  it('clamps to the ends', () => {
    expect(pointAt(line, -3)).toEqual([0, 0]);
    expect(pointAt(line, 99)).toEqual([10, 10]);
  });
});
