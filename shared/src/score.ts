/** The scoring constants and the combination rule that the server's scorer and the browser's live line both use, defined once so the two cannot drift. */
export const SCORE = {
  /** A frame difference equal to the camera's baseline scores this, so an ordinary camera doing an ordinary thing sits mid-range and twice the baseline saturates. */
  ANOMALY_AT_BASELINE: 0.5,
  /** What a scale prior of 0 and of 1 multiply the movement term by: a quiet street, then a major interstate. */
  SCALE_AMPLIFIER_MIN: 0.5,
  SCALE_AMPLIFIER_MAX: 1.5,
  /** The smallest floor that places a camera in the upper band. Below it a floor still counts, but only against movement, so a queue that has barely begun to arrive does not jump ahead of every moving camera. */
  FLOOR_HOLD_MIN: 0.2,
  /** Where the upper band begins. Every camera held by a floor scores above every camera that is not. */
  BAND: 0.5,
} as const;

/** The attention score from the movement term and the strongest floor.
 *
 * The rule is lexicographic. A camera held by a floor of at least FLOOR_HOLD_MIN scores in the upper band, from 0.6 to 1, ordered by the larger of its floor and its movement. Every other camera scores in the lower band, from 0 to 0.5, ordered the same way, so consequence always outranks movement even on a busy freeway. */
export function combineAttention(movement: number, floor: number): number {
  const level = Math.min(1, Math.max(0, movement, floor));
  return floor >= SCORE.FLOOR_HOLD_MIN ? SCORE.BAND + (1 - SCORE.BAND) * level : SCORE.BAND * level;
}

/** Whether a score is in the upper band, that is, held by a floor. */
export function isHeld(attention: number | null): boolean {
  return attention !== null && attention > SCORE.BAND;
}

/** Limits how many floor-held cameras keep their place at the top of a ranking.
 *
 * Takes cameras already sorted by attention. The first `limit` held cameras keep their upper-band score. Any held camera beyond them is scored as though it had no floor, from its movement alone, and the list is sorted again, so that a burst of incidents and the queues behind them cannot take every prominent place. `movement` is the camera's clamped movement term. */
export function capHeld<T extends { attention: number; movement: number }>(sorted: T[], limit: number): (T & { capped: boolean })[] {
  let held = 0;
  const out = sorted.map((entry) => {
    if (!isHeld(entry.attention)) return { ...entry, capped: false };
    held++;
    if (held <= limit) return { ...entry, capped: false };
    return { ...entry, attention: SCORE.BAND * Math.min(1, Math.max(0, entry.movement)), capped: true };
  });
  return out.sort((a, b) => b.attention - a.attention);
}
