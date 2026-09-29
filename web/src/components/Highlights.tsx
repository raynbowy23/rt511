import { useEffect, useState, type ReactElement } from 'react';
import { getHighlights, type Highlight } from '../api';

const labels = { incident: 'Incident', stopped: 'Stopped traffic', movement: 'Unusual movement' };

function age(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Keeping the outgoing row for one fade lets changing briefs settle without disturbing the wall below. */
export function Highlights({ region, onSelect }: { region?: string | undefined; onSelect: (id: number) => void }): ReactElement | null {
  const [rows, setRows] = useState<{ current: Highlight[]; previous: Highlight[]; revision: number }>({ current: [], previous: [], revision: 0 });
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    let canceled = false;
    let pending = false;
    const run = async (): Promise<void> => {
      if (document.hidden || pending) return;
      pending = true;
      const response = await getHighlights(region);
      pending = false;
      if (canceled || !response) return;
      const next = response.highlights.slice(0, 5);
      setRows((old) => JSON.stringify(old.current) === JSON.stringify(next) ? old : { current: next, previous: old.current, revision: old.revision + 1 });
    };
    void run();
    const poll = window.setInterval(() => void run(), 15_000);
    const tick = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    const resume = (): void => { if (!document.hidden) { setNow(Date.now() / 1000); void run(); } };
    document.addEventListener('visibilitychange', resume);
    return () => { canceled = true; window.clearInterval(poll); window.clearInterval(tick); document.removeEventListener('visibilitychange', resume); };
  }, [region]);
  useEffect(() => {
    if (!rows.previous.length) return;
    const timer = window.setTimeout(() => setRows((old) => ({ ...old, previous: [] })), 900);
    return () => window.clearTimeout(timer);
  }, [rows.revision, rows.previous.length]);
  if (!rows.current.length) return null;
  const row = (items: Highlight[], outgoing: boolean): ReactElement => <div className={`hl-row ${outgoing ? 'hl-outgoing' : 'hl-incoming'}`} key={`${rows.revision}-${outgoing}`} aria-hidden={outgoing || undefined} inert={outgoing}>
    {items.map((item, i) => <button className="hl-card" type="button" key={i} onClick={() => onSelect(item.camera)} tabIndex={outgoing ? -1 : 0}>
      <span className="hl-label">{labels[item.kind]}</span>
      <span className="hl-brief">{item.brief}</span>
      <span className="hl-age">{age(item.at, now)}</span>
    </button>)}
  </div>;
  return <section className="hl-ribbon" aria-label="Highlights">{row(rows.current, false)}{rows.previous.length > 0 && row(rows.previous, true)}</section>;
}
