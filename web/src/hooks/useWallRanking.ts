import { useEffect, useMemo, useRef, useState } from 'react';
import type { Camera, CameraState } from '../api';
import type { TileRank, Tier } from '../components/Wall';

// A camera has to beat the tier boundary by this many ranks before it loses its size. Without the margin two cameras trading places on consecutive polls make the whole wall reflow, which reads as jitter rather than breathing.
const HYSTERESIS = 4;

/** Ranks the wall by attention on a slow cadence. The poll runs every ten seconds, but sizes change a few times a minute at most: re-ranking on every poll would make the wall twitch instead of breathe, which is the whole point of the view.
 *
 * Attention rather than activity, which is what this used to rank on. Activity is frame difference over a rolling median and knows nothing about how big the road is, what hour it is, or whether a state trooper is standing on it. Attention is that same movement measure amplified by the scale prior, held up by an incident floor, and adjusted by whatever the arbiter has said, so a crash on an interstate can hold a large tile while its picture sits still. */
export function useWallRanking(cameras: Camera[], states: Map<number, CameraState>, rerankMs: number): Map<number, TileRank> {
  const [tick, setTick] = useState(0);
  const tiers = useRef(new Map<number, Tier>());
  const latest = useRef(states);
  latest.current = states;

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), rerankMs);
    return () => window.clearInterval(timer);
  }, [rerankMs]);

  // The first poll to arrive should rank immediately rather than waiting out the first interval.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || states.size === 0) return;
    seeded.current = true;
    setTick((value) => value + 1);
  }, [states]);

  return useMemo(() => {
    void tick;
    const ranked = cameras
      .map((camera) => ({ camera, attention: latest.current.get(camera.id)?.attention ?? null }))
      .filter((entry) => entry.attention !== null)
      .sort((a, b) => (b.attention as number) - (a.attention as number));

    const bigCount = Math.max(2, Math.round(ranked.length / 26));
    const wideCount = Math.max(4, Math.round(ranked.length / 9));
    const out = new Map<number, TileRank>();

    ranked.forEach((entry, rank) => {
      const current = tiers.current.get(entry.camera.id) ?? 'unit';
      const bigEdge = current === 'big' ? bigCount + HYSTERESIS : bigCount;
      const wideEdge = current === 'unit' ? bigCount + wideCount : bigCount + wideCount + HYSTERESIS;
      const tier: Tier = rank < bigEdge ? 'big' : rank < wideEdge ? 'wide' : 'unit';
      tiers.current.set(entry.camera.id, tier);
      out.set(entry.camera.id, { tier, top: rank < bigCount });
    });

    // Cameras with no score yet stay at unit size rather than inheriting whatever they had.
    for (const camera of cameras) {
      if (out.has(camera.id)) continue;
      tiers.current.set(camera.id, 'unit');
      out.set(camera.id, { tier: 'unit', top: false });
    }
    return out;
  }, [cameras, tick]);
}
