import { useEffect, useState, type ReactElement } from 'react';
import { getDiary, type DiaryKind, type DiaryResponse } from '../api';

const labels: Record<DiaryKind, string> = {
  incident: 'Incident',
  stopped: 'Stopped traffic',
  movement: 'Unusual movement',
  murky: 'Murky',
  snow: 'Snow',
  clear: 'Clear again',
  sunset: 'Sunset',
  sunrise: 'Sunrise',
};

function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** What the wall noticed, day by day. Words only: the server keeps no pictures, so an entry opens the camera as it is now rather than as it was. */
export function Diary({
  regionName,
  onCamera,
  onRegion,
  onClose,
}: {
  regionName: (key: string) => string;
  onCamera: (id: number, region: string) => void;
  onRegion: (key: string) => void;
  onClose: () => void;
}): ReactElement {
  const [day, setDay] = useState<string | undefined>(undefined);
  const [data, setData] = useState<DiaryResponse | null>(null);

  useEffect(() => {
    let canceled = false;
    const run = async (): Promise<void> => {
      const response = await getDiary(day);
      if (!canceled && response) setData(response);
    };
    void run();
    // Only today's page grows, so only today's page is read again.
    const today = day === undefined;
    const timer = today ? window.setInterval(() => void run(), 60_000) : 0;
    return () => {
      canceled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [day]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  const entries = data ? [...data.entries].reverse() : [];
  return (
    <aside className="diary" aria-label="Diary">
      <header className="diary-head">
        <h2 className="diary-title">Diary</h2>
        {data && data.days.length > 1 && (
          <select className="diary-day" value={data.day} onChange={(event) => setDay(event.currentTarget.value === data.days[0] ? undefined : event.currentTarget.value)}>
            {data.days.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        )}
        {data && data.days.length <= 1 && <span className="diary-day-single">{data.day}</span>}
        <button type="button" className="diary-close" onClick={onClose}>
          Close <kbd>Esc</kbd>
        </button>
      </header>
      <p className="diary-hint">The wall writes a line here whenever it notices something: a highlight, a sunset or sunrise, murky skies or snow. Click a line to open that camera, or that city, as it is now. Earlier days are in the menu above.</p>
      {entries.length === 0 ? (
        <p className="diary-empty">Nothing written yet today. The wall looks once a minute, so keep it running and lines will appear here as things happen.</p>
      ) : (
        <ol className="diary-list">
          {entries.map((entry, i) => (
            <li key={`${entry.ts}-${i}`}>
              <button type="button" className={`diary-entry is-${entry.kind}`} onClick={() => (entry.camera === null ? onRegion(entry.region) : onCamera(entry.camera, entry.region))}>
                <span className="diary-time">{clock(entry.ts)}</span>
                <span className="diary-kind">{labels[entry.kind] ?? entry.kind}</span>
                <span className="diary-where">{regionName(entry.region)}</span>
                <span className="diary-brief">{entry.brief}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="diary-note">Text only. No camera imagery is stored. Murky and snow are hints from the pictures, not a weather report.</p>
    </aside>
  );
}
