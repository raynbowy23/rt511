import { useCallback, useMemo, useState } from 'react';
import { train, type Vote } from '../preference';

const KEY = 'rt511.preferences.v1';
/** Enough to learn eight weights well many times over, and small enough that local storage never notices. The oldest go first. */
const MAX_VOTES = 2000;

function read(): Vote[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Vote[]).filter((vote) => vote && Array.isArray(vote.a?.x) && Array.isArray(vote.b?.x)) : [];
  } catch {
    return [];
  }
}

function write(votes: Vote[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(votes));
  } catch {
    // A browser that refuses storage still gets a model for this visit; it just forgets it afterwards.
  }
}

/** The person's choices from "Which would you watch?", kept in this browser only, and the weights learned from them. */
export function usePreferences(): { votes: Vote[]; weights: number[]; add: (vote: Vote) => void; reset: () => void } {
  const [votes, setVotes] = useState<Vote[]>(read);
  const weights = useMemo(() => train(votes), [votes]);
  const add = useCallback((vote: Vote) => {
    setVotes((old) => {
      const next = [...old, vote].slice(-MAX_VOTES);
      write(next);
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    write([]);
    setVotes([]);
  }, []);
  return { votes, weights, add, reset };
}
