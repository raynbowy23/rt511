import type { ReactElement } from 'react';

export interface Crumb {
  label: string;
  go?: (() => void) | undefined;
}

export function TopBar({
  crumbs,
  status,
  ok,
  level,
  touring,
  onToggleView,
  onToggleTour,
  onBoard,
  diaryOpen = false,
  onDiary,
  tripOn = false,
  onRoadTrip,
}: {
  crumbs: Crumb[];
  status: string;
  ok: boolean;
  level: 'national' | 'map' | 'wall' | 'board';
  touring: boolean;
  onToggleView: () => void;
  onToggleTour: () => void;
  onBoard: () => void;
  diaryOpen?: boolean;
  onDiary?: () => void;
  tripOn?: boolean;
  onRoadTrip?: () => void;
}): ReactElement {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">rt511</span>
        <nav className="crumbs" aria-label="Location">
          {crumbs.map((crumb, i) => (
            <span className="crumb-group" key={`${crumb.label}-${i}`}>
              {i > 0 && <span className="crumb-sep">›</span>}
              {crumb.go ? (
                <button type="button" className="crumb" onClick={crumb.go}>
                  {crumb.label}
                </button>
              ) : (
                <span className="crumb is-current">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      </div>
      <div className="status">
        <span className={`status-dot${ok ? '' : ' is-down'}`} />
        <span className="status-text">{status}</span>
      </div>
      <div className="controls">
        {onDiary && (
          <button type="button" className={`control${diaryOpen ? ' is-on' : ''}`} aria-pressed={diaryOpen} onClick={onDiary}>Diary</button>
        )}
        <button type="button" className={`control${level === 'board' ? ' is-on' : ''}`} aria-pressed={level === 'board'} onClick={onBoard}>Board</button>
        <button type="button" className={`control${level === 'map' ? ' is-on' : ''}`} data-action="view" hidden={level === 'national' || level === 'board'} onClick={onToggleView}>
          {level === 'map' ? 'Wall ' : 'Map '}
          <kbd>M</kbd>
        </button>
        {onRoadTrip && (
          <button type="button" className={`control${tripOn ? ' is-on' : ''}`} aria-pressed={tripOn} hidden={level === 'national' || level === 'board'} onClick={onRoadTrip}>
            Road trip
          </button>
        )}
        <button type="button" className={`control${touring ? ' is-on' : ''}`} data-action="tour" hidden={level === 'national' || level === 'board'} onClick={onToggleTour}>
          Tour <kbd>Space</kbd>
        </button>
      </div>
    </header>
  );
}
