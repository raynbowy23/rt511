import { describe, expect, it } from 'vitest';
import { lonLat, type NationalResponse } from '@rt511/shared';
import { contains, explode } from './slabs';

/** A box of a state, lon/lat corners. */
function square(west: number, south: number, size: number): NationalResponse['states'][string]['polygons'] {
  return [[lonLat(west, south), lonLat(west + size, south), lonLat(west + size, south + size), lonLat(west, south + size), lonLat(west, south)]];
}

function country(): NationalResponse {
  return {
    attribution: '',
    states: {
      OH: { name: 'Ohio', polygons: square(-84, 39, 3) },
      OR: { name: 'Oregon', polygons: square(-123, 42, 4) },
      VT: { name: 'Vermont', polygons: square(-73, 43, 1) },
      NH: { name: 'New Hampshire', polygons: square(-72, 43, 1) },
      TX: { name: 'Texas', polygons: square(-104, 27, 8) },
    },
    covered_states: ['VT', 'OH', 'OR', 'NH'],
    sources: {
      ohgo: { name: 'OHGO', site_url: '', states: ['OH'], has_video: false, attribution: '', cameras: { ids: [1], lat: [40.5], lon: [-82.5] } },
      necompass: { name: 'Compass', site_url: '', states: ['VT', 'NH'], has_video: false, attribution: '', cameras: { ids: [2, 3], lat: [43.5, 43.5], lon: [-71.5, -72.5] } },
    },
    regions: [],
  };
}

describe('explode', () => {
  it('keeps only the covered states, west to east', () => {
    expect(explode(country()).slabs.map((slab) => slab.code)).toEqual(['OR', 'OH', 'VT', 'NH']);
  });

  it('puts each camera on its own state, testing each state a source spans', () => {
    const layout = explode(country());
    const codes = [...layout.camSlab].map((i) => layout.slabs[i]?.code);
    expect(codes).toEqual(['OH', 'NH', 'VT']);
    expect(layout.slabs.map((slab) => slab.cameras)).toEqual([0, 1, 1, 1]);
  });

  it('places a camera inside its slab', () => {
    const layout = explode(country());
    for (let k = 0; k < layout.camX.length; k++) {
      const slab = layout.slabs[layout.camSlab[k]!]!;
      expect(contains(slab.rings, layout.camX[k]!, layout.camY[k]!)).toBe(true);
    }
  });

  it('knows no slab for a state it does not show', () => {
    const layout = explode(country());
    expect(layout.place(-100, 30, 'TX')).toBeNull();
    expect(layout.slabOf(-100, 30)).toBe(-1);
    expect(layout.slabs[layout.slabOf(-82.5, 40.5)]?.code).toBe('OH');
  });

  it('keeps slabs apart', () => {
    const { slabs } = explode(country());
    for (let i = 1; i < slabs.length; i++) {
      const [a, b] = [slabs[i - 1]!, slabs[i]!];
      for (const [x, y] of b.rings[0]!) expect(contains(a.rings, x, y)).toBe(false);
    }
  });
});
