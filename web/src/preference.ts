import { solarElevation, type AttentionAxes } from '@rt511/shared';

/** A person's own attention, learned from the choices they make in "Which would you watch?".
 *
 * Each choice between two cameras is a comparison: this one deserved attention more than that one. A Bradley–Terry model turns comparisons into weights over the same things the wall's equation looks at, so the person's attention and the equation's can be set side by side. P(a over b) = σ(w · (x_a − x_b)), fitted by gradient descent with a little L2, no intercept, so swapping the two cameras swaps the answer.
 *
 * Everything here is plain arithmetic on numbers the server already sends. The votes are kept in the browser and never leave it. */

export interface Factor {
  key: string;
  label: string;
  /** What a high value means, for the panel. */
  hint: string;
}

/** The features, in order. Each is roughly 0 to 1, so the learned weights are comparable with each other. */
export const FACTORS: Factor[] = [
  { key: 'movement', label: 'Unusual movement', hint: 'moving more than it usually does at this hour' },
  { key: 'road', label: 'Big road', hint: 'how big the road is, from traffic counts or road class' },
  { key: 'incident', label: 'Incident nearby', hint: 'a reported incident near the camera' },
  { key: 'queue', label: 'Queue reaching it', hint: 'stopped traffic or an incident further down the road' },
  { key: 'stopped', label: 'Stopped traffic', hint: 'the picture looks like stopped traffic' },
  { key: 'dark', label: 'After dark', hint: 'the sun is down where the camera is' },
  { key: 'bright', label: 'Bright picture', hint: 'how bright the picture is' },
  { key: 'freeway', label: 'Freeway', hint: 'a freeway camera rather than a street' },
];

export interface Candidate {
  id: number;
  region: string;
  city: string;
  location: string;
  /** The wall's own score, for comparing with the person's choice. */
  attention: number;
  /** The fixed equation's score alone, the baseline. Optional so choices recorded before it existed still read. */
  equation?: number | undefined;
  /** The second look's reading of this camera when it was chosen, confident or not, or null when it had none. */
  look?: Look | null | undefined;
  x: number[];
}

/** One second-look answer as a vote keeps it. */
export interface Look {
  level: number;
  levels: number;
  confidence: number;
  at: number;
}

/** "learn" pairs are chosen to teach the person's own model fastest. "evaluate" pairs are chosen without reference to any model's opinion of the person, so they can judge the rankers fairly. */
export type DuelMode = 'learn' | 'evaluate';
/** How an evaluation pair was drawn: uniformly, or from the pairs the equation and the second look order differently. Kept on the vote because the two strata have to be reported apart. */
export type Stratum = 'random' | 'disagree';

export interface Vote {
  ts: number;
  a: Omit<Candidate, 'x'> & { x: number[] };
  b: Omit<Candidate, 'x'> & { x: number[] };
  pick: 'a' | 'b';
  mode?: DuelMode | undefined;
  stratum?: Stratum | null | undefined;
}

/** One camera's features, from its score's parts and where the sun is on it. */
export function features(axes: AttentionAxes, camera: { lat: number; lon: number; is_freeway: boolean }, brightness: number | null, now: number): number[] {
  const elevation = solarElevation(camera.lat, camera.lon, now);
  // Fully dark six degrees below the horizon, fully light six above, a ramp through twilight between.
  const dark = Math.min(1, Math.max(0, (6 - elevation) / 12));
  return [axes.anomaly ?? 0, axes.scale_prior, axes.incident_floor, axes.queue_floor, axes.gate?.floor ?? 0, dark, brightness ?? 0.5, camera.is_freeway ? 1 : 0];
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const dot = (w: number[], x: number[]): number => w.reduce((sum, value, i) => sum + value * (x[i] ?? 0), 0);

/** How strongly the person prefers `a` over `b`, 0 to 1. */
export function prefer(weights: number[], a: number[], b: number[]): number {
  return sigmoid(dot(weights, a.map((value, i) => value - (b[i] ?? 0))));
}

/** The person's own score for one camera, on the same scale as `prefer`'s argument. Only the order matters, which is what the wall ranks by. */
export function score(weights: number[], x: number[]): number {
  return dot(weights, x);
}

const L2 = 0.02;
const RATE = 0.5;
const STEPS = 400;

/** Fits the weights to every vote so far. A few hundred full passes over a few hundred votes is instant, and a fixed schedule from zero makes the result the same every time for the same votes. */
export function train(votes: Vote[]): number[] {
  const w = FACTORS.map(() => 0);
  if (votes.length === 0) return w;
  const rows = votes.map((vote) => ({ d: vote.a.x.map((value, i) => value - (vote.b.x[i] ?? 0)), y: vote.pick === 'a' ? 1 : 0 }));
  for (let step = 0; step < STEPS; step++) {
    const gradient = w.map((value) => L2 * value);
    for (const { d, y } of rows) {
      const error = sigmoid(dot(w, d)) - y;
      for (let i = 0; i < w.length; i++) gradient[i]! += (error * (d[i] ?? 0)) / rows.length;
    }
    for (let i = 0; i < w.length; i++) w[i]! -= RATE * gradient[i]!;
  }
  return w;
}

/** How often the wall's equation would have chosen the same camera, over the votes where its two scores differ. Null with no such votes. */
export function agreement(votes: Vote[]): { agree: number; total: number } | null {
  const decided = votes.filter((vote) => Math.abs(vote.a.attention - vote.b.attention) > 1e-6);
  if (decided.length === 0) return null;
  const agree = decided.filter((vote) => (vote.pick === 'a') === vote.a.attention > vote.b.attention).length;
  return { agree, total: decided.length };
}

/** The votes where the person most clearly went against the equation: they chose the camera the wall scored lower, by the widest gap. */
export function disagreements(votes: Vote[], limit = 3): { chosen: Vote['a']; passed: Vote['a']; gap: number }[] {
  return votes
    .map((vote) => {
      const chosen = vote.pick === 'a' ? vote.a : vote.b;
      const passed = vote.pick === 'a' ? vote.b : vote.a;
      return { chosen, passed, gap: passed.attention - chosen.attention };
    })
    .filter((item) => item.gap > 0)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, limit);
}

/** The next pair to ask about. Early on, any two different cameras. Once there are a few votes, the pair the model is least sure about out of a random sample, so each answer teaches it the most. A camera shown in the last few pairs is avoided when there is any choice. */
export function nextPair(candidates: Candidate[], weights: number[], votes: number, recent: Set<number>, random: () => number = Math.random): [Candidate, Candidate] | null {
  const fresh = candidates.filter((candidate) => !recent.has(candidate.id));
  const pool = fresh.length >= 2 ? fresh : candidates;
  if (pool.length < 2) return null;
  const pick = (): [Candidate, Candidate] => {
    const i = Math.floor(random() * pool.length);
    let j = Math.floor(random() * (pool.length - 1));
    if (j >= i) j++;
    return [pool[i]!, pool[j]!];
  };
  if (votes < 5) return pick();
  let best = pick();
  let closest = Math.abs(prefer(weights, best[0].x, best[1].x) - 0.5);
  for (let n = 0; n < 30; n++) {
    const pair = pick();
    const distance = Math.abs(prefer(weights, pair[0].x, pair[1].x) - 0.5);
    if (distance < closest) {
      best = pair;
      closest = distance;
    }
  }
  return best;
}

/** How far apart two cameras must sit, on each ranking, for the pair to count as the two rankings disagreeing rather than a near tie. */
const DISAGREE_EQUATION = 0.02;
const DISAGREE_LOOK = 0.25;
/** The share of evaluation pairs drawn from the disagreements, when there are any. The rest are uniform, which is what an overall figure is read from. */
const DISAGREE_SHARE = 0.5;

/** Whether the equation and the second look put two cameras in opposite orders, each by more than a near tie. */
export function disagree(a: Candidate, b: Candidate): boolean {
  if (!a.look || !b.look || a.equation === undefined || b.equation === undefined) return false;
  const byEquation = a.equation - b.equation;
  const byLook = a.look.level - b.look.level;
  return Math.abs(byEquation) > DISAGREE_EQUATION && Math.abs(byLook) > DISAGREE_LOOK && byEquation * byLook < 0;
}

/** The next evaluation pair. Half the time, when there are any, one of the pairs the two rankings order differently, since those are the pairs that tell them apart. Otherwise any two cameras, uniformly. Never informed by the person's own model, which would bias the test towards it. */
export function nextEvalPair(candidates: Candidate[], recent: Set<number>, random: () => number = Math.random): { pair: [Candidate, Candidate]; stratum: Stratum } | null {
  const fresh = candidates.filter((candidate) => !recent.has(candidate.id));
  const pool = fresh.length >= 2 ? fresh : candidates;
  if (pool.length < 2) return null;
  if (random() < DISAGREE_SHARE) {
    const split: [Candidate, Candidate][] = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) if (disagree(pool[i]!, pool[j]!)) split.push([pool[i]!, pool[j]!]);
    if (split.length > 0) {
      const pair = split[Math.floor(random() * split.length)]!;
      // Sides shuffled, so neither ranking's favourite always sits on the left.
      return { pair: random() < 0.5 ? pair : [pair[1], pair[0]], stratum: 'disagree' };
    }
  }
  const i = Math.floor(random() * pool.length);
  let j = Math.floor(random() * (pool.length - 1));
  if (j >= i) j++;
  return { pair: [pool[i]!, pool[j]!], stratum: 'random' };
}

export interface RankerAgreement {
  agree: number;
  total: number;
}

/** How often each ranking picked the camera the person chose, over evaluation choices only, and only where that ranking told the two apart. The person's own model is left out here, because it was trained on these same choices; the analysis script scores it on held-out choices instead. */
export function evaluation(votes: Vote[]): { choices: number; disagreements: number; equation: RankerAgreement; look: RankerAgreement } {
  const evaluated = votes.filter((vote) => vote.mode === 'evaluate');
  const equation = { agree: 0, total: 0 };
  const look = { agree: 0, total: 0 };
  for (const vote of evaluated) {
    const pickedA = vote.pick === 'a';
    if (vote.a.equation !== undefined && vote.b.equation !== undefined && Math.abs(vote.a.equation - vote.b.equation) > 1e-6) {
      equation.total++;
      if (pickedA === vote.a.equation > vote.b.equation) equation.agree++;
    }
    if (vote.a.look && vote.b.look && Math.abs(vote.a.look.level - vote.b.look.level) > 1e-6) {
      look.total++;
      if (pickedA === vote.a.look.level > vote.b.look.level) look.agree++;
    }
  }
  return { choices: evaluated.length, disagreements: evaluated.filter((vote) => vote.stratum === 'disagree').length, equation, look };
}
