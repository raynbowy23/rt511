import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { getBoard, type BoardResponse, type Camera, type CameraState } from '../api';
import { useWallRanking } from '../hooks/useWallRanking';
import { Wall } from './Wall';
import { Highlights } from './Highlights';

const FILTER_KEY = 'rt511.board-filter';
const BOARD_POLL_MS = 10_000;

function readFilter(): { state: string; region: string } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FILTER_KEY) ?? '{}') as Record<string, unknown>;
    return { state: typeof saved.state === 'string' ? saved.state : '', region: typeof saved.region === 'string' ? saved.region : '' };
  } catch {
    return { state: '', region: '' };
  }
}

/** The board reads cached results only. Reusing the wall does not send its visibility observations back to the server. */
export function Board({ cameras, activeId, onSelect, onData }: { cameras: Map<number, Camera>; activeId: number | null; onSelect: (id: number) => void; onData: (states: CameraState[], ok: boolean) => void }): ReactElement {
  const [filter, setFilter] = useState(readFilter);
  const [data, setData] = useState<BoardResponse | null>(null);
  const [ok, setOk] = useState(true);
  const report = useRef(onData);
  report.current = onData;

  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
    } catch {
      // Filters still work when the browser refuses storage.
    }
    let cancelled = false;
    const run = async (): Promise<void> => {
      const next = await getBoard(filter.state, filter.region);
      if (cancelled) return;
      setOk(next !== null);
      if (next) setData(next);
      report.current(next?.cameras ?? [], next !== null);
    };
    setData(null);
    void run();
    const timer = window.setInterval(() => void run(), BOARD_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [filter]);

  const states = useMemo(() => new Map((data?.cameras ?? []).map((camera) => [camera.id, camera])), [data]);
  const tiles = useMemo(() => (data?.cameras ?? []).map((entry): Camera => cameras.get(entry.id) ?? { id: entry.id, region: entry.region, location: entry.location, roadway: entry.roadway, direction: null, lat: 0, lon: 0, site: null, is_freeway: false, has_video: false }), [data, cameras]);
  const captions = useMemo(() => new Map((data?.cameras ?? []).map((camera, rank) => [camera.id, `${rank + 1} · ${camera.region_name.replace(/, [A-Z]{2}$/, '')} · ${camera.state} · ${Math.round(camera.attention * 100)}${camera.radar ? ' · radar' : ''}`])), [data]);
  const ranks = useWallRanking(tiles, states, 20_000);

  return (
    <section className="pane board" aria-label="National camera board">
      <div className="board-filters" role="group" aria-label="State">
        <button type="button" aria-pressed={!filter.state} onClick={() => setFilter({ state: '', region: '' })}>All states</button>
        {data?.states.map((state) => <button type="button" key={state} aria-pressed={filter.state === state} onClick={() => setFilter({ state, region: '' })}>{state}</button>)}
      </div>
      <div className="board-filters" role="group" aria-label="City">
        <button type="button" aria-pressed={!filter.region} onClick={() => setFilter({ ...filter, region: '' })}>All cities</button>
        {data?.regions.filter((region) => !filter.state || region.state === filter.state).map((region) => <button type="button" key={region.key} aria-pressed={filter.region === region.key} onClick={() => setFilter({ ...filter, region: region.key })}>{region.name}</button>)}
      </div>
      {!ok && <p className="board-empty">Waiting for the backend</p>}
      {ok && !data && <p className="board-empty">Loading the board</p>}
      {data?.cameras.length === 0 && <p className="board-empty">{data.states.length ? 'No scored cameras match these filters.' : 'The national radar samples every city every ten minutes. The board fills over the first few minutes as cameras return frames.'}</p>}
      <Wall highlights={<Highlights onSelect={onSelect} />} cameras={tiles} captions={captions} states={states} ranks={ranks} activeId={activeId} intervalS={600} visible onSelect={onSelect} onVisibleCameras={() => undefined} />
    </section>
  );
}
