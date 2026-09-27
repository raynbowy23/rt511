import { describe, expect, it } from 'vitest';
import type { AttentionAxes } from '@rt511/shared';
import { driverOf } from './score';

function axes(over: Partial<AttentionAxes> = {}): AttentionAxes {
  return {
    anomaly: 0.4,
    spectacle: 0.4,
    incident_floor: 0,
    queue_floor: 0,
    queue: null,
    incident_floor_base: 0,
    incident: null,
    scale_prior: 0.5,
    scale_prior_source: 'class',
    scale_amplifier: 1,
    baseline: 0.01,
    baseline_n: 5,
    baseline_sd: null,
    ambiguous_zero: false,
    gate: null,
    jev: null,
    ...over,
  };
}

describe('driverOf', () => {
  it('is movement when no floor reaches the score', () => {
    expect(driverOf(0.6, axes())?.key).toBe('movement');
  });

  it('names the floor that equals the score, since a floor wins a tie', () => {
    expect(driverOf(0.7, axes({ incident_floor: 0.7 }))?.key).toBe('incident');
    expect(driverOf(0.5, axes({ queue_floor: 0.5 }))?.key).toBe('queue');
    expect(driverOf(0.6, axes({ gate: { floor: 0.6 } as AttentionAxes['gate'] }))?.word).toBe('stopped');
  });

  it('prefers the larger floor when two are set', () => {
    expect(driverOf(0.8, axes({ incident_floor: 0.8, queue_floor: 0.4 }))?.key).toBe('incident');
  });

  it('says nothing about a camera with no score yet', () => {
    expect(driverOf(null, axes())).toBeNull();
    expect(driverOf(0.5, null)).toBeNull();
  });
});
