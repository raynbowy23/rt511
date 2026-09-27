import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { snapUrl } from '../api';
import { agreement, disagreements, FACTORS, nextPair, type Candidate, type Vote } from '../preference';

/** How long both scores stay up after a choice before the next pair comes in. */
const REVEAL_MS = 1600;
/** Choices needed before the weights mean anything, and before the wall can be ranked by them. */
const SHOW_WEIGHTS_AFTER = 5;
const RANK_AFTER = 10;
/** Cameras shown in this many recent pairs are rested, so the same few do not keep coming back. */
const RECENT = 6;

/** "Which would you watch?": two cameras from the city, pictures only, and a choice. Each choice is a comparison the model learns the person's own attention from, and the wall's score is revealed afterwards so the two can be compared. The panel beside it shows what the person weighs, how often they and the wall agree, and where they disagree most. */
export function Duel({
  candidates,
  votes,
  weights,
  rankByYou,
  onVote,
  onReset,
  onRankByYou,
  onClose,
}: {
  candidates: Candidate[];
  votes: Vote[];
  weights: number[];
  rankByYou: boolean;
  onVote: (vote: Vote) => void;
  onReset: () => void;
  onRankByYou: (on: boolean) => void;
  onClose: () => void;
}): ReactElement {
  const recent = useRef<number[]>([]);
  const [pair, setPair] = useState<[Candidate, Candidate] | null>(null);
  const [reveal, setReveal] = useState<'a' | 'b' | null>(null);

  // Latest values for the callbacks below, which are held by a timer and a key listener.
  const latest = useRef({ candidates, weights, count: votes.length });
  latest.current = { candidates, weights, count: votes.length };

  const advance = useCallback(() => {
    const { candidates: pool, weights: w, count } = latest.current;
    const next = nextPair(pool, w, count, new Set(recent.current));
    if (next) recent.current = [...recent.current, next[0].id, next[1].id].slice(-RECENT * 2);
    setPair(next);
    setReveal(null);
  }, []);

  // The first pair, and a new one if the pool was empty and has filled since.
  const hasPool = candidates.length >= 2;
  useEffect(() => {
    if (hasPool && pair === null) advance();
  }, [hasPool, pair, advance]);

  const choose = useCallback(
    (pick: 'a' | 'b') => {
      if (!pair || reveal) return;
      const [a, b] = pair;
      onVote({ ts: Date.now() / 1000, a, b, pick });
      setReveal(pick);
      window.setTimeout(advance, REVEAL_MS);
    },
    [pair, reveal, onVote, advance],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const handled = ['ArrowLeft', 'ArrowRight', 'ArrowDown', ' ', 'Escape'].includes(event.key);
      if (!handled) return;
      // Captured first and stopped, so the wall's own arrow and space keys do not act underneath.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft') choose('a');
      else if (event.key === 'ArrowRight') choose('b');
      else if (!reveal) advance();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [choose, advance, onClose, reveal]);

  const agreed = agreement(votes);
  const against = disagreements(votes);
  const top = Math.max(1e-9, ...weights.map((w) => Math.abs(w)));
  const ordered = FACTORS.map((factor, i) => ({ factor, w: weights[i] ?? 0 })).sort((x, y) => Math.abs(y.w) - Math.abs(x.w));

  return (
    <div className="duel" role="dialog" aria-label="Which would you watch?">
      <div className="duel-stage">
        <header className="duel-head">
          <h2>Which would you watch?</h2>
          <p>Pick with a click or ← →. Space skips. The wall's own score shows after you choose.</p>
          <button type="button" className="duel-close" onClick={onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </header>
        {pair ? (
          <div className="duel-pair">
            {(['a', 'b'] as const).map((side, i) => {
              const camera = pair[i]!;
              const other = pair[1 - i]!;
              const chosen = reveal === side;
              const wallPrefers = camera.attention > other.attention;
              return (
                <button key={`${side}-${camera.id}`} type="button" className={`duel-card${reveal ? (chosen ? ' is-chosen' : ' is-passed') : ''}`} onClick={() => choose(side)} disabled={reveal !== null}>
                  <img src={snapUrl(camera.id, -1, Date.now() / 1000)} alt="" draggable={false} />
                  <span className="duel-where">
                    {camera.location}
                    <small>{camera.city}</small>
                  </span>
                  {reveal && (
                    <span className="duel-reveal">
                      <b>{camera.attention.toFixed(2)}</b> wall
                      {chosen && <em>{camera.attention === other.attention ? 'the wall had them level' : wallPrefers ? 'the wall agrees' : 'the wall would have picked the other'}</em>}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="duel-empty">Waiting for scores. The wall needs a couple of pictures from each camera before it can score them, which takes a minute or two after a city opens.</p>
        )}
      </div>

      <aside className="duel-panel">
        <h3>Your attention</h3>
        <p className="duel-count">
          {votes.length} {votes.length === 1 ? 'choice' : 'choices'}
          {agreed && (
            <>
              {' · '}you and the wall agree on <b>{Math.round((100 * agreed.agree) / agreed.total)}%</b>
            </>
          )}
        </p>
        {votes.length < SHOW_WEIGHTS_AFTER ? (
          <p className="duel-note">A few more choices and what you weigh starts to show here.</p>
        ) : (
          <>
            <p className="duel-note">Bars to the right draw your eye; bars to the left turn it away.</p>
            <ul className="duel-weights">
              {ordered.map(({ factor, w }) => (
                <li key={factor.key} title={factor.hint}>
                  <span className="duel-factor">{factor.label}</span>
                  <span className="duel-bar">
                    <i className={w >= 0 ? 'is-up' : 'is-down'} style={{ width: `${String(Math.round((50 * Math.abs(w)) / top))}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {against.length > 0 && (
          <div className="duel-against">
            <h4>Where you and the wall disagree most</h4>
            <ol>
              {against.map(({ chosen, passed, gap }) => (
                <li key={`${chosen.id}-${passed.id}-${gap}`}>
                  You chose <b>{chosen.location}</b> over {passed.location}, which the wall scored {gap.toFixed(2)} higher.
                </li>
              ))}
            </ol>
          </div>
        )}
        <label className={`duel-toggle${votes.length < RANK_AFTER ? ' is-disabled' : ''}`}>
          <input type="checkbox" checked={rankByYou} disabled={votes.length < RANK_AFTER} onChange={(event) => onRankByYou(event.currentTarget.checked)} />
          Rank the wall by your attention
          {votes.length < RANK_AFTER && <small> after {RANK_AFTER} choices</small>}
        </label>
        <div className="duel-actions">
          <button type="button" onClick={() => download(votes, weights)} disabled={votes.length === 0}>
            Export
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Forget every choice made in this browser?')) {
                onReset();
                onRankByYou(false);
              }
            }}
            disabled={votes.length === 0}
          >
            Start over
          </button>
        </div>
        <p className="duel-note">Your choices stay in this browser. Nothing is sent anywhere.</p>
      </aside>
    </div>
  );
}

/** The choices and the weights as JSON, for looking at elsewhere. */
function download(votes: Vote[], weights: number[]): void {
  const body = JSON.stringify({ format: 'rt511-preferences', version: 1, factors: FACTORS.map((factor) => factor.key), weights, votes }, null, 1);
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `rt511-attention-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
