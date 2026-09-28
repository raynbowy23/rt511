import { describe, expect, it } from 'vitest';
import { agreement, disagree, disagreements, evaluation, FACTORS, nextEvalPair, nextPair, prefer, train, type Candidate, type Vote } from './preference';

const MOVEMENT = 0;
const ROAD = 1;

function candidate(id: number, x: Partial<Record<number, number>>, attention = 0.5): Candidate {
  return { id, region: 'test', city: 'Test', location: `Camera ${String(id)}`, attention, x: FACTORS.map((_, i) => x[i] ?? 0) };
}

function vote(a: Candidate, b: Candidate, pick: 'a' | 'b'): Vote {
  return { ts: 0, a, b, pick };
}

/** A deterministic stand-in for Math.random. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('train', () => {
  it('learns nothing from nothing', () => {
    expect(train([]).every((w) => w === 0)).toBe(true);
  });

  it('learns a person who always picks the bigger road, and not movement', () => {
    const random = seeded(1);
    const votes: Vote[] = [];
    for (let n = 0; n < 60; n++) {
      const a = candidate(n * 2, { [MOVEMENT]: random(), [ROAD]: random() });
      const b = candidate(n * 2 + 1, { [MOVEMENT]: random(), [ROAD]: random() });
      votes.push(vote(a, b, (a.x[ROAD] ?? 0) > (b.x[ROAD] ?? 0) ? 'a' : 'b'));
    }
    const w = train(votes);
    expect(w[ROAD]!).toBeGreaterThan(1);
    expect(Math.abs(w[MOVEMENT]!)).toBeLessThan(w[ROAD]! / 3);
  });

  it('is symmetric: swapping the two cameras swaps the preference', () => {
    const w = train([vote(candidate(1, { [MOVEMENT]: 1 }), candidate(2, {}), 'a')]);
    const a = candidate(3, { [MOVEMENT]: 0.8 }).x;
    const b = candidate(4, { [MOVEMENT]: 0.2 }).x;
    expect(prefer(w, a, b) + prefer(w, b, a)).toBeCloseTo(1, 10);
  });

  it('gives the same weights for the same votes', () => {
    const votes = [vote(candidate(1, { [MOVEMENT]: 1 }), candidate(2, { [ROAD]: 1 }), 'b')];
    expect(train(votes)).toEqual(train(votes));
  });
});

describe('agreement and disagreements', () => {
  it('count how often the equation would have chosen the same camera', () => {
    const high = candidate(1, {}, 0.9);
    const low = candidate(2, {}, 0.2);
    const tie = candidate(3, {}, 0.2);
    const votes = [vote(high, low, 'a'), vote(high, low, 'b'), vote(low, tie, 'a')];
    expect(agreement(votes)).toEqual({ agree: 1, total: 2 });
    expect(agreement([])).toBeNull();
  });

  it('list the choices that went against the equation, widest gap first', () => {
    const votes = [vote(candidate(1, {}, 0.9), candidate(2, {}, 0.1), 'b'), vote(candidate(3, {}, 0.6), candidate(4, {}, 0.5), 'b'), vote(candidate(5, {}, 0.2), candidate(6, {}, 0.8), 'b')];
    const found = disagreements(votes);
    expect(found.map((item) => item.chosen.id)).toEqual([2, 4]);
    expect(found[0]!.gap).toBeCloseTo(0.8);
  });
});

describe('nextPair', () => {
  const pool = [candidate(1, { [ROAD]: 1 }), candidate(2, { [ROAD]: 0 }), candidate(3, { [ROAD]: 0.5 }), candidate(4, { [ROAD]: 0.55 })];

  it('never pairs a camera with itself', () => {
    const random = seeded(7);
    for (let n = 0; n < 50; n++) {
      const pair = nextPair(pool, FACTORS.map(() => 0), 0, new Set(), random)!;
      expect(pair[0].id).not.toBe(pair[1].id);
    }
  });

  it('avoids cameras shown recently when there is a choice', () => {
    const pair = nextPair(pool, FACTORS.map(() => 0), 0, new Set([1, 2]), seeded(3))!;
    expect(new Set([pair[0].id, pair[1].id])).toEqual(new Set([3, 4]));
  });

  it('once it has learned something, asks about the pair it is least sure of', () => {
    const weights = FACTORS.map((_, i) => (i === ROAD ? 5 : 0));
    const pair = nextPair(pool, weights, 10, new Set(), seeded(11))!;
    expect(new Set([pair[0].id, pair[1].id])).toEqual(new Set([3, 4]));
  });

  it('needs two cameras', () => {
    expect(nextPair([pool[0]!], FACTORS.map(() => 0), 0, new Set())).toBeNull();
  });
});

describe('evaluation pairs', () => {
  const cam = (id: number, equation: number, level: number | null, at = 0): Candidate => ({ id, region: 'r', city: 'c', location: `cam ${String(id)}`, attention: equation, equation, look: level === null ? null : { level, levels: 4, confidence: 0.8, at }, x: [] });

  it('knows when the equation and the second look order two cameras differently', () => {
    expect(disagree(cam(1, 0.8, 0.5), cam(2, 0.4, 2.5))).toBe(true);
    expect(disagree(cam(1, 0.8, 2.5), cam(2, 0.4, 0.5))).toBe(false);
    expect(disagree(cam(1, 0.8, 2.5), cam(2, 0.79, 0.5))).toBe(false);
    expect(disagree(cam(1, 0.8, null), cam(2, 0.4, 2.5))).toBe(false);
    // Levels from two different looks are on two different scales, so they say nothing about each other.
    expect(disagree(cam(1, 0.8, 0.5, 100), cam(2, 0.4, 2.5, 220))).toBe(false);
  });

  it('draws from the disagreements when asked to, and uniformly otherwise', () => {
    const pool = [cam(1, 0.9, 3), cam(2, 0.8, 2.8), cam(3, 0.5, 0.2), cam(4, 0.2, 2.9)];
    const split = nextEvalPair(pool, new Set(), () => 0.1)!;
    expect(split.stratum).toBe('disagree');
    expect(disagree(split.pair[0], split.pair[1])).toBe(true);
    const any = nextEvalPair(pool, new Set(), () => 0.9)!;
    expect(any.stratum).toBe('random');
    expect(nextEvalPair([cam(1, 0.5, 1)], new Set())).toBeNull();
  });

  it('scores each ranking only on evaluation choices it could tell apart', () => {
    const vote = (a: Candidate, b: Candidate, pick: 'a' | 'b', mode: 'learn' | 'evaluate' = 'evaluate'): Vote => ({ ts: 0, a, b, pick, mode, stratum: 'random' });
    const result = evaluation([
      vote(cam(1, 0.8, 0.5), cam(2, 0.4, 2.5), 'b'),
      vote(cam(1, 0.8, 2.5), cam(2, 0.4, 0.5), 'a'),
      vote(cam(1, 0.5, null), cam(2, 0.5, 1), 'a'),
      vote(cam(1, 0.9, 3), cam(2, 0.1, 0), 'b', 'learn'),
      // Decided by the equation but not comparable for the look, so left out of both: the two are scored on the same choices.
      vote(cam(1, 0.9, null), cam(2, 0.1, 1), 'a'),
      vote(cam(1, 0.9, 3, 100), cam(2, 0.1, 1, 220), 'a'),
    ]);
    expect(result.choices).toBe(5);
    expect(result.paired).toBe(2);
    expect(result.equation).toEqual({ agree: 1, total: 2 });
    expect(result.look).toEqual({ agree: 2, total: 2 });
  });
});
