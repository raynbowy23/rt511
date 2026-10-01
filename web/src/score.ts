import type { AttentionAxes } from '@rt511/shared';

/** Which part of the score set its level, in a word. The level is the larger of the movement term and the strongest of three floors, and a floor wins a tie, so the strongest floor is the reason when it is at least the movement term; otherwise it is movement. */
export function driverOf(attention: number | null, axes: AttentionAxes | null): { key: string; word: string; title: string } | null {
  if (attention === null || !axes) return null;
  const floors: { key: string; word: string; title: string; value: number }[] = [
    { key: 'incident', word: 'incident', title: 'Held up by a reported incident nearby', value: axes.incident_floor },
    { key: 'queue', word: 'queue', title: 'Held up by a queue that may reach this camera from an incident or stopped traffic further down the road', value: axes.queue_floor },
    { key: 'still', word: 'stopped', title: 'Held up because the traffic in the picture looks stopped', value: axes.gate?.floor ?? 0 },
  ];
  const floor = floors.reduce((best, item) => (item.value > best.value ? item : best));
  if (floor.value > 0 && floor.value >= (axes.movement ?? 0) - 1e-6) return floor;
  return { key: 'movement', word: 'moving', title: 'Movement against this camera\'s own normal for this hour, scaled by the size of the road' };
}
