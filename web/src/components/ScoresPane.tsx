import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ScoreCamera, ScoresResponse } from '@rt511/shared';
import { getScores } from '../api';
import { HoverCard } from './HoverCard';

const HISTORY_MS = 600_000;
type Point = { at: number; value: number };
const number = (value: number | null): string => value === null ? 'unknown' : value.toFixed(3);
export const driverLabel = { movement: 'Movement', incident: 'Incident', queue: 'Queue upstream', still: 'Stopped traffic' };

function Sparkline({ points, now }: { points: Point[]; now: number }): ReactElement {
  return <svg className="score-spark" viewBox="0 0 240 34" preserveAspectRatio="none" role="img" aria-label="Attention over the last 10 minutes">
    <polyline points={points.filter((point) => now - point.at <= HISTORY_MS).map((point) => `${2 + 236 * (1 - (now - point.at) / HISTORY_MS)},${32 - point.value * 30}`).join(' ')} />
  </svg>;
}

function CameraExplanation({ camera, tuning }: { camera: ScoreCamera; tuning: ScoresResponse['tuning'] }): ReactElement {
  const a = camera.axes;
  return <>
    <p>The wall compares greyscale snapshots a minute apart and averages pixel change.</p>
    {/* No picture yet is not a still picture, and the server keeps the two apart on purpose, so the explanation must not print a movement of zero for a camera it has not seen move or stand still. */}
    {a.anomaly === null ? (
      <p>This camera has not returned two pictures yet, so there is no movement to measure. That is not the same as a still picture. Until it has, its score comes from the floors alone.</p>
    ) : (
      <>
        <p>Change {number(camera.diff)} against this hour’s usual {number(a.baseline)} gives movement {number(a.anomaly)}. The usual blends {a.baseline_n} earlier frames at this hour with recent history. Matching usual scores {tuning.anomaly_at_baseline} and twice usual saturates.</p>
        <p>Movement combines anomaly x {tuning.weight_anomaly} and spectacle x {tuning.weight_spectacle}. Road factor {number(a.scale_amplifier)} multiplies it. The factor runs from {tuning.scale_amplifier_min} for a quiet street to {tuning.scale_amplifier_max} for a major interstate.</p>
      </>
    )}
    <p>Road scale {number(a.scale_prior)} comes from {{ aadt: 'published traffic counts', capacity: 'road capacity from tagged lanes and speed', class: 'road class', default: 'the default for an unplaced camera' }[a.scale_prior_source]}.</p>
    <p>The queue floor is inferred from an incident or confirmed stopped traffic further down the road. It shrinks with road distance and grows as a queue could have reached this camera.</p>
    <p>Queue floor {number(a.queue_floor)}. Incident floor {number(a.incident_floor)}. Stopped traffic floor {number(a.gate?.floor ?? 0)}. {driverLabel[camera.driver]} wins. A floor wins a tie because the score cannot drop below it. The result is limited to 0 through 1.</p>
  </>;
}

export function ScoresPane({ open, onOpen, region, onRegion, onCamera }: {
  open: boolean; onOpen: (next: boolean) => void; region: string | null;
  onRegion: (key: string) => void; onCamera: (id: number, region: string) => void;
}): ReactElement {
  const [view, setView] = useState<'cities' | 'cameras'>(() => {
    try { return localStorage.getItem('rt511.scores.view') === 'cameras' ? 'cameras' : 'cities'; } catch { return 'cities'; }
  });
  const [data, setData] = useState<ScoresResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const history = useRef(new Map<string, Point[]>());
  const polledAt = useRef(Date.now());
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let pending = false;
    const run = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      const next = await getScores();
      pending = false;
      if (cancelled) return;
      setFailed(next === null);
      if (!next) return;
      const now = Date.now();
      polledAt.current = now;
      for (const [key, points] of history.current) {
        const kept = points.filter((point) => now - point.at <= HISTORY_MS);
        if (kept.length) history.current.set(key, kept); else history.current.delete(key);
      }
      const append = (key: string, value: number): void => {
        const points = history.current.get(key) ?? [];
        points.push({ at: now, value });
        history.current.set(key, points);
      };
      for (const city of next.regions) append(`r${city.key}`, city.top5_mean);
      for (const camera of next.cameras) append(`c${camera.id}`, camera.attention);
      setData(next);
    };
    void run();
    const timer = window.setInterval(() => void run(), 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open]);
  const cameras = data?.cameras.filter((camera) => region === null || camera.region === region).sort((a, b) => b.attention - a.attention).slice(0, 15) ?? [];
  return <aside className={`arbiter${open ? ' is-open' : ''}`} aria-label="Scores">
    <button type="button" className="arb-tab" onClick={() => onOpen(!open)} aria-expanded={open}><span className="arb-tab-text">SCORES</span></button>
    {open && <div className="arb-body">
      <header className="arb-head"><h2>Scores</h2></header>
      {!!data?.graph_promoted?.length && <p className="arb-caption"><HoverCard content={<p>When one camera shows an incident, stopped traffic or unusual movement, cameras around it on the road graph are fetched with the cameras on screen rather than with the rest of the city, for five minutes after the change was last seen.</p>}>{data.graph_promoted.length} cameras watched closely because a neighbour changed</HoverCard></p>}
      <div className="score-toggle" aria-label="Score view">{(['cities', 'cameras'] as const).map((choice) => <button key={choice} type="button" aria-pressed={view === choice} onClick={() => {
        setView(choice);
        try { localStorage.setItem('rt511.scores.view', choice); } catch { /* Storage is optional for the view choice. */ }
      }}>{choice === 'cities' ? 'Cities' : 'Cameras'}</button>)}</div>
      {failed && <p className="arb-empty">Scores could not be refreshed.</p>}
      {!data && !failed && <p className="arb-empty">Reading scores</p>}
      {data && view === 'cities' && [...data.regions].sort((a, b) => b.top5_mean - a.top5_mean).map((city) => <article className="score-row" key={city.key} onClick={() => onRegion(city.key)}>
        <button className="score-location" onClick={(event) => { event.stopPropagation(); onRegion(city.key); }}>{city.name}</button>
        <HoverCard content={<p>Busiest five is the mean attention of the five highest scored cameras in this city. With fewer than five it uses those available. With none it shows zero. One busy junction should not make a whole city look busy.</p>}><span className="score-number">{number(city.top5_mean)}</span> busiest five</HoverCard>
        <Sparkline points={history.current.get(`r${city.key}`) ?? []} now={polledAt.current} />
        <p>{city.top ? `${city.top.location} · ${number(city.top.attention)}` : 'No scored camera yet'}</p>
        <p className="arb-caption">{city.scored} cameras scored · {city.incident_floored} held up by an incident · {city.still} still</p>
      </article>)}
      {data && view === 'cameras' && cameras.map((camera) => {
        const a = camera.axes;
        const movement = data.tuning.weight_anomaly * (a.anomaly ?? 0) + data.tuning.weight_spectacle * (a.spectacle ?? 0);
        return <article className="score-row" key={camera.id} onClick={() => onCamera(camera.id, camera.region)}>
          <button className="score-location" onClick={(event) => { event.stopPropagation(); onCamera(camera.id, camera.region); }}>{camera.location}</button>
          <p className="arb-caption">{region === null && `${data.regions.find((city) => city.key === camera.region)?.name ?? camera.region} · `}{camera.roadway}</p>
          <HoverCard content={<CameraExplanation camera={camera} tuning={data.tuning} />}><span className="score-number">{number(camera.attention)}</span></HoverCard>
          <span className={`score-driver is-${camera.driver}`}>{driverLabel[camera.driver]}</span>
          {data.graph_promoted?.some(({ uid }) => uid === camera.id) && <p className="arb-caption">Watched because a neighbour changed</p>}
          <Sparkline points={history.current.get(`c${camera.id}`) ?? []} now={polledAt.current} />
          <p className="score-breakdown"><span className={camera.driver === 'movement' ? 'is-winner' : ''}>{a.anomaly === null ? 'no picture yet' : <>movement {number(movement)} x road {number(a.scale_amplifier)} = {number(movement * a.scale_amplifier)}</>}</span> · <span className={camera.driver === 'incident' ? 'is-winner' : ''}>incident floor {number(a.incident_floor)}</span> · <span className={camera.driver === 'queue' ? 'is-winner' : ''}>queue floor {number(a.queue_floor)}{a.queue && ` behind ${a.queue.source === 'standstill' ? 'stopped traffic at ' : ''}${a.queue.incident}, ${(a.queue.length_m / 1000).toFixed(1)} km downstream`}</span>{a.gate && <> · <span className={camera.driver === 'still' ? 'is-winner' : ''}>still-traffic floor {number(a.gate.floor)}</span></>}</p>
        </article>;
      })}
      {data && (view === 'cities' ? data.regions.length === 0 : cameras.length === 0) && <p className="arb-empty">No scores here yet. Open a city to start watching its cameras.</p>}
    </div>}
  </aside>;
}
