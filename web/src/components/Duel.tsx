import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { snapUrl } from '../api';
import { agreement, disagreements, evaluation, FACTORS, nextEvalPair, nextPair, type Candidate, type DuelMode, type Stratum, type Vote } from '../preference';

/** How long both scores stay up after a choice before the next pair comes in. */
const REVEAL_MS = 1600;
/** In evaluation nothing is revealed, so the pause is only long enough to see the choice land. */
const EVALUATE_PAUSE_MS = 450;
const MODE_KEY = 'rt511.duelMode';
/** Choices needed before the weights mean anything, and before the wall can be ranked by them. */
const SHOW_WEIGHTS_AFTER = 5;
const RANK_AFTER = 10;
/** Cameras shown in this many recent pairs are rested, so the same few do not keep coming back. */
const RECENT = 6;

/** "Which would you watch?": two cameras from the city, pictures only, and a choice. Each choice is a comparison the model learns the person's own attention from, and the wall's score is revealed afterwards. */
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
  /** When the pair was drawn. The pictures are asked for as of this moment, so a poll landing mid-decision does not swap in a newer frame than the recorded features describe. */
  const [pairAt, setPairAt] = useState(() => Date.now() / 1000);
  /** The pause after a choice. Cleared whenever the pair changes some other way, or the pause would replace a pair the person is already looking at. */
  const pause = useRef(0);
  const [stratum, setStratum] = useState<Stratum | null>(null);
  const [reveal, setReveal] = useState<'a' | 'b' | null>(null);
  const [mode, setModeState] = useState<DuelMode>(readMode);

  // Latest values for the callbacks below, which are held by a timer and a key listener.
  const latest = useRef({ candidates, weights, count: votes.length, mode });
  latest.current = { candidates, weights, count: votes.length, mode };

  const advance = useCallback(() => {
    window.clearTimeout(pause.current);
    const { candidates: pool, weights: w, count, mode: current } = latest.current;
    const drawn = current === 'evaluate' ? nextEvalPair(pool, new Set(recent.current)) : null;
    const next = current === 'evaluate' ? (drawn?.pair ?? null) : nextPair(pool, w, count, new Set(recent.current));
    if (next) recent.current = [...recent.current, next[0].id, next[1].id].slice(-RECENT * 2);
    setPair(next);
    setPairAt(Date.now() / 1000);
    setStratum(drawn?.stratum ?? null);
    setReveal(null);
  }, []);

  const setMode = (next: DuelMode): void => {
    setModeState(next);
    latest.current.mode = next;
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Remembering the mode is a convenience; without storage it lasts the visit.
    }
    advance();
  };

  useEffect(() => () => window.clearTimeout(pause.current), []);

  // The first pair, and a new one if the pool was empty and has filled since.
  const hasPool = candidates.length >= 2;
  useEffect(() => {
    if (hasPool && pair === null) advance();
  }, [hasPool, pair, advance]);

  const choose = useCallback(
    (pick: 'a' | 'b') => {
      if (!pair || reveal) return;
      const [a, b] = pair;
      onVote({ ts: Date.now() / 1000, a, b, pick, mode, stratum: mode === 'evaluate' ? stratum : null });
      setReveal(pick);
      pause.current = window.setTimeout(advance, mode === 'evaluate' ? EVALUATE_PAUSE_MS : REVEAL_MS);
    },
    [pair, reveal, onVote, advance, mode, stratum],
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

  const blind = mode === 'evaluate';
  const hasLook = candidates.some((candidate) => candidate.look);
  const agreed = agreement(votes);
  const evaluated = evaluation(votes);
  const percent = ({ agree, total }: { agree: number; total: number }): string => (total === 0 ? 'none yet' : `${String(Math.round((100 * agree) / total))}%`);
  const against = disagreements(votes);
  const top = Math.max(1e-9, ...weights.map((w) => Math.abs(w)));
  const ordered = FACTORS.map((factor, i) => ({ factor, w: weights[i] ?? 0 })).sort((x, y) => Math.abs(y.w) - Math.abs(x.w));

  return (
    <div className="duel" role="dialog" aria-label="Which would you watch?">
      <div className="duel-stage">
        <header className="duel-head">
          <h2>Which would you watch?</h2>
          <p>{mode === 'evaluate' ? 'Pick the one you would rather watch. Nothing is revealed, so no score can steer the next choice.' : 'Pick with a click or ← →. Space skips. The wall’s own score shows after you choose.'}</p>
          <div className="duel-mode" role="group" aria-label="Mode">
            {(['learn', 'evaluate'] as const).map((option) => (
              <button key={option} type="button" className={mode === option ? 'is-on' : ''} aria-pressed={mode === option} onClick={() => setMode(option)}>
                {option === 'learn' ? 'Learn my attention' : 'Evaluate'}
              </button>
            ))}
          </div>
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
                  <img src={snapUrl(camera.id, -1, pairAt)} alt="" draggable={false} />
                  <span className="duel-where">
                    {camera.location}
                    <small>{camera.city}</small>
                  </span>
                  {reveal && mode === 'learn' && (
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
          {agreed && !blind && (
            <>
              {' · '}you and the wall agree on <b>{Math.round((100 * agreed.agree) / agreed.total)}%</b>
            </>
          )}
        </p>
        {blind ? (
          <div className="duel-evaluation">
            <h4>Evaluation</h4>
            <p>
              {evaluated.choices} blind {evaluated.choices === 1 ? 'choice' : 'choices'}, {evaluated.disagreements} where the two rankings split.
            </p>
            <p>Results stay hidden while you choose, so none can steer the next choice. They show in Learn mode.</p>
            {!hasLook && <p>No second look is running, since it needs a Jev key, so these choices can compare the equation with your own attention but not with the look.</p>}
          </div>
        ) : (
          evaluated.choices > 0 && (
            <div className="duel-evaluation">
              <h4>Evaluation</h4>
              <p>
                {evaluated.choices} blind {evaluated.choices === 1 ? 'choice' : 'choices'}, {evaluated.disagreements} where the two rankings split.
              </p>
              <p>
                On the {evaluated.paired} both rankings could decide, the equation picked your camera in <b>{percent(evaluated.equation)}</b> and the second look in <b>{percent(evaluated.look)}</b>.
              </p>
            </div>
          )
        )}
        {blind ? null : votes.length < SHOW_WEIGHTS_AFTER ? (
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
        {against.length > 0 && !blind && (
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
  const body = JSON.stringify({ format: 'rt511-preferences', version: 2, factors: FACTORS.map((factor) => factor.key), weights, votes }, null, 1);
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `rt511-attention-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function readMode(): DuelMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'evaluate' ? 'evaluate' : 'learn';
  } catch {
    return 'learn';
  }
}
