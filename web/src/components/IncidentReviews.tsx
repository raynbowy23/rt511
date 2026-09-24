import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { getJev, type JevSnapshot, type VerdictPoint } from '../api';

/** What the arbiter has been saying, over time.
 *
 * The wall shows a number. This shows how that number was argued for, and more importantly how the argument moved: a record whose screen score is falling while its cleared probability climbs is a record on its way off the wall, and none of that is visible in the score alone.
 *
 * Read-only in the strongest sense. The endpoint behind it reports answers already formed and never causes a call, so leaving this pane open costs nothing beyond the poll. */

const POLL_MS = 3_000;
/** Answers land about once a minute per record, so a series of forty points is a little over half an hour. The strip is drawn to a fixed viewBox and stretched, which keeps a two-point series legible next to a full one. */
const STRIP_W = 240;
const STRIP_H = 34;

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The screen score on its own scale, which the answer carries rather than the rubric, so a rubric edited on the server cannot silently rescale this. */
function normalised(point: VerdictPoint): number {
  if (point.score_levels <= 1) return 0;
  return Math.max(0, Math.min(1, point.score / (point.score_levels - 1)));
}

/** Kept off the edges so that a point at 0 or at 1 is drawn rather than half clipped by the viewport. */
const PAD_X = 4;
const PAD_Y = 3;

function Strip({ history }: { history: VerdictPoint[] }): ReactElement {
  if (history.length === 0) return <div className="arb-strip is-empty" />;
  const span = STRIP_W - 2 * PAD_X;
  const at = (i: number) => (history.length === 1 ? STRIP_W / 2 : PAD_X + (i * span) / (history.length - 1));
  const y = (value: number) => PAD_Y + (1 - Math.max(0, Math.min(1, value))) * (STRIP_H - 2 * PAD_Y);
  const line = (value: (p: VerdictPoint) => number): string =>
    history.map((p, i) => `${i === 0 ? 'M' : 'L'} ${at(i).toFixed(1)} ${y(value(p)).toFixed(1)}`).join(' ');
  return (
    <svg className="arb-strip" viewBox={`0 0 ${STRIP_W} ${STRIP_H}`} preserveAspectRatio="none" aria-hidden="true">
      <line className="arb-rule" x1={0} x2={STRIP_W} y1={y(1)} y2={y(1)} />
      <line className="arb-rule" x1={0} x2={STRIP_W} y1={y(0)} y2={y(0)} />
      <path className="arb-line arb-line-cleared" d={line((p) => p.cleared)} />
      <path className="arb-line arb-line-score" d={line(normalised)} />
      {history.map((p, i) => (
        <circle key={p.at} className={`arb-dot${p.gated.includes('screen') ? ' is-gated' : ''}`} cx={at(i)} cy={y(normalised(p))} r={1.8} />
      ))}
    </svg>
  );
}

/** One answer as three bars. The gate mark is the point on each bar where the answer starts being acted on, which is the only thing that makes a number here consequential. */
function Answers({ point, gates }: { point: VerdictPoint; gates: JevSnapshot['gates'] }): ReactElement {
  const rows = [
    { key: 'screen', value: point.score_confidence, gate: gates.act_confidence,
      caption: `Wall space. Confidence gate ${gates.act_confidence}.`,
      explanation: `Jev's ordered judgment of wall space. 0 means nothing worth showing. ${point.score_levels - 1} means the main panel. The bar shows confidence. At confidence ${gates.act_confidence} or higher the score scales the floor from ${1 - gates.score_swing} to ${1 + gates.score_swing} times itself.` },
    { key: 'cleared', value: point.cleared, gate: gates.noul_threshold,
      caption: `Chance it is over. Gate ${gates.noul_threshold}.`,
      explanation: `Probability the event is already over. At ${gates.noul_threshold} or higher the floor is multiplied by ${gates.cleared_residue}. This is the answer that clears an event. A low screen score can also reduce its floor.` },
    { key: 'supported', value: point.supported, gate: gates.noul_threshold,
      caption: `Chance the view fits. Gate ${gates.noul_threshold}.`,
      explanation: `Probability the cameras show something consistent with the report. At ${gates.noul_threshold} or higher the floor is multiplied by ${gates.supported_lift}. This answer never lowers the floor.` },
  ];
  return (
    <div className="arb-answers">
      {rows.map((row) => (
        <div key={row.key} className={`arb-answer${!point.gated.includes(row.key) ? ' is-acted' : ''}`} title={row.explanation}>
          <span className="arb-answer-label">{row.key}</span>
          <span className="arb-bar">
            <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, row.value))})` }} />
            <b style={{ left: `${row.gate * 100}%` }} title="The tick marks where this answer starts to count." />
          </span>
          <span className="arb-answer-value">
            {row.key === 'screen' ? `${point.score.toFixed(1)}/${point.score_levels - 1}` : row.value.toFixed(2)}
          </span>
          <span className="arb-caption">{row.caption}</span>
        </div>
      ))}
      <p className="arb-caption">Each tick marks where an answer starts to count. The screen bar shows confidence {point.score_confidence.toFixed(2)}.</p>
    </div>
  );
}

/** Each clock owns its render so a second passing does not redraw the answers or their history. */
function ReadAge({ at }: { at: number }): ReactElement {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="arb-when">{Math.max(0, Math.floor(now - at))} s ago</span>;
}

export function IncidentReviews({ open }: { open: boolean }): ReactElement {
  const [snapshot, setSnapshot] = useState<JevSnapshot | null>(null);
  /** Null means the request has not come back yet, false means it came back. Kept apart so that the first render does not accuse a healthy server of being unreachable. */
  const [reachable, setReachable] = useState<boolean | null>(null);
  const seen = useRef(new Map<string, number>());

  // Opening the reviews promotes their cameras until the section closes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async (): Promise<void> => {
      const next = await getJev(true);
      if (cancelled) return;
      setReachable(next !== null);
      if (next) setSnapshot(next);
    };
    void run();
    const timer = window.setInterval(() => void run(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      // Hand the cameras back rather than leaving them on the fast period until the promotion times out.
      void getJev(false);
    };
  }, [open]);

  // Which records answered since the last render, so a change can be marked rather than merely appearing.
  const changed = useMemo(() => {
    const out = new Set<string>();
    if (!snapshot) return out;
    for (const row of snapshot.incidents) {
      const at = row.latest?.at ?? 0;
      if (seen.current.get(row.id) !== at && seen.current.has(row.id)) out.add(row.id);
      seen.current.set(row.id, at);
    }
    return out;
  }, [snapshot]);

  const tokens = snapshot ? snapshot.input_tokens + snapshot.output_tokens : 0;

  // An empty pane is a question, so it answers it. The counts narrow one step at a time, and the first that reads zero is the reason nothing has been asked about.
  const waiting = useMemo((): string | null => {
    if (!snapshot || snapshot.incidents.length > 0) return null;
    if (!snapshot.enabled) return 'No JEV_API key, so floors stay deterministic and nothing is asked.';
    if (snapshot.watching_regions === 0) return 'No city is being watched. Nothing is polled at the country level, so there are no pictures and no dispatch records to arbitrate. Open a city.';
    if (snapshot.feeds_read === 0) return 'No incident feed has been read yet. Only Ohio has one, and it is read every two minutes once an Ohio city is open, with your own OHGO key.';
    if (snapshot.live_incidents === 0) return 'The incident feed is open and currently lists nothing.';
    if (snapshot.linked_incidents === 0) return `${count(snapshot.live_incidents, 'record')} live, none of them within 1.5 km of a camera this server is serving.`;
    if (snapshot.relevant_incidents === 0) return `${count(snapshot.linked_incidents, 'record')} near a camera, all of them ordinary police business rather than anything about the road.`;
    if (snapshot.servable_incidents === 0)
      return `${count(snapshot.relevant_incidents, 'record')} about the road, none of them near a camera this server is running. Records are matched against every camera the state publishes, so most of them belong to cities that are not open here.`;
    if (snapshot.ready_incidents === 0)
      return `${count(snapshot.servable_incidents, 'record')} waiting on a picture, out of ${snapshot.relevant_incidents} about the road that this server can see nothing of. Their cameras are held on the fast period while this section is open, and each needs two frames that differ before it can be asked about. At night the sources return the same image about half the time, so this can take several minutes.`;
    return `${count(snapshot.ready_incidents, 'record')} ready. The first answers land within a minute.`;
  }, [snapshot]);

  return (
    <section className="incident-reviews">
          <header className="arb-head">
            <p className="arb-sub">The source provides a new picture per camera about once a minute. Jev reads a record again at most once a minute and only when a picture changed.</p>
            <p className="arb-sub">
              {snapshot === null
                ? reachable === false
                  ? 'no answer from the server'
                  : 'asking the server'
                : !snapshot.enabled
                  ? 'no key, floors are deterministic'
                  : `${snapshot.calls} calls · ${tokens.toLocaleString()} tokens · at least ${snapshot.reask_after_s}s between reads`}
            </p>
            {snapshot?.enabled && snapshot.prioritised_cameras > 0 && (
              <p className="arb-sub">{snapshot.prioritised_cameras} cameras held on the fast period while this section is open</p>
            )}
            {snapshot?.enabled && (snapshot.throttled > 0 || snapshot.errors > 0) && (
              <p className="arb-warn">
                {snapshot.errors > 0 && `${snapshot.errors} failed`}
                {snapshot.errors > 0 && snapshot.throttled > 0 && ' · '}
                {snapshot.throttled > 0 && `${snapshot.throttled} held back by the rate limit`}
              </p>
            )}
          </header>

          {waiting !== null && <p className="arb-empty">{waiting}</p>}
          {reachable === false && snapshot === null && (
            <p className="arb-empty">No answer from the server. A server running an older build does not have this endpoint yet, so restarting it is the usual fix.</p>
          )}

          {snapshot?.incidents.map((row) => {
            const latest = row.latest;
            const previous = row.history[row.history.length - 2];
            const drift = latest && previous ? normalised(latest) - normalised(previous) : 0;
            return (
              <article key={row.id} className={`arb-row${changed.has(row.id) ? ' is-new' : ''}`}>
                <div className="arb-row-head">
                  <span className="arb-code">{row.code || 'incident'}</span>
                  <span className="arb-where">{row.location || 'location not given'}</span>
                  {latest && <ReadAge at={latest.at} />}
                </div>
                <Strip history={row.history} />
                <p className="arb-caption arb-strip-legend">Solid line shows screen score over time. Dashed line shows cleared probability. A grey dot means screen confidence was below the gate and did nothing. A coloured dot means the screen answer counted.</p>
                {latest && <Answers point={latest} gates={snapshot.gates} />}
                {latest && (
                  <div className="arb-foot" title={`The multiplier combines all answers that counted for the minimum score of the picked camera. When the camera choice counts the other cameras receive ${snapshot.gates.chosen_others} / ${snapshot.gates.chosen_gain} of this multiplier.`}>
                    <span className={`arb-mult${latest.multiplier < 1 ? ' is-down' : latest.multiplier > 1 ? ' is-up' : ''}`}>
                      floor × {latest.multiplier.toFixed(2)}
                    </span>
                    {Math.abs(drift) >= 0.01 && (
                      <span className={`arb-drift${drift > 0 ? ' is-up' : ' is-down'}`}>
                        {drift > 0 ? '▲' : '▼'} {Math.abs(drift * 100).toFixed(0)}%
                      </span>
                    )}
                    <span className="arb-points">{row.history.length} reads</span>
                    <p className="arb-caption">Change to the picked camera’s minimum score. When the choice counts other cameras get × {(snapshot.gates.chosen_others / snapshot.gates.chosen_gain).toFixed(2)} of it.</p>
                  </div>
                )}
              </article>
            );
          })}

          {snapshot && snapshot.cameras.length > 0 && (
            <section className="arb-gate">
              <h3>Still cameras</h3>
              {snapshot.cameras.map((camera) => (
                <div key={camera.uid} className="arb-gate-row">
                  <span className="arb-where">#{camera.uid}</span>
                  <span className="arb-answer-value">
                    standstill {camera.latest?.standstill.toFixed(2) ?? '-'} · floor {camera.latest?.floor.toFixed(2) ?? '-'}
                  </span>
                </div>
              ))}
            </section>
          )}
    </section>
  );
}
