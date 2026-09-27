import type { ReactElement, ReactNode } from 'react';

export interface Crumb {
  label: string;
  go?: (() => void) | undefined;
}

type Level = 'home' | 'national' | 'map' | 'wall' | 'board';

/** The top bar: where you are on the left, then three kinds of control that used to look identical and now do not.
 *
 * The view switch is a segmented control that shows the view you are in, the way a tab does: the country as a map or as the board of its best cameras, a city as a map or as its wall of cameras. Autoplay modes are separate buttons with a play icon, which say "Stop" while they run, since each one takes over the screen until it is stopped. The diary is a panel and sits apart at the end. Keyboard shortcuts are in the tooltips rather than printed on the buttons. */
export function TopBar({
  crumbs,
  status,
  ok,
  level,
  touring,
  onView,
  onHome,
  onToggleTour,
  diaryOpen = false,
  onDiary,
  whichOpen = false,
  onWhich,
  tripOn = false,
  onRoadTrip,
  relayOn = false,
  onRelay,
}: {
  crumbs: Crumb[];
  status: string;
  ok: boolean;
  level: Level;
  touring: boolean;
  /** Switches to a view within the current scope. A view that is not available leaves the switch without that option. */
  onView: (level: Level) => void;
  /** The front page. The name in the corner goes there, as it does on most sites. */
  onHome?: () => void;
  onToggleTour: () => void;
  diaryOpen?: boolean;
  onDiary?: () => void;
  whichOpen?: boolean;
  /** "Which would you watch?", in a city. */
  onWhich?: () => void;
  tripOn?: boolean;
  onRoadTrip?: () => void;
  relayOn?: boolean;
  onRelay?: () => void;
}): ReactElement {
  const inCity = level === 'map' || level === 'wall';
  const views: { level: Level; label: string; title: string }[] = inCity
    ? [
        { level: 'map', label: 'Map', title: 'The city’s roads and cameras (M)' },
        { level: 'wall', label: 'Wall', title: 'Every camera in the city, busiest first (M)' },
      ]
    : [
        { level: 'national', label: 'Map', title: 'Every city on one map' },
        { level: 'board', label: 'Board', title: 'The most interesting cameras across the country right now' },
      ];

  return (
    <header className="topbar">
      <div className="brand">
        {onHome && level !== 'home' ? (
          <button type="button" className="brand-mark is-link" title="Front page" onClick={onHome}>
            rt511
          </button>
        ) : (
          <span className="brand-mark">rt511</span>
        )}
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
      {/* Nothing is polled on the front page, so there is no camera status to report there. */}
      <div className="status">
        {level !== 'home' && (
          <>
            <span className={`status-dot${ok ? '' : ' is-down'}`} />
            <span className="status-text">{status}</span>
          </>
        )}
      </div>
      <div className="controls">
        <div className="view-switch" role="tablist" aria-label="View">
          {views.map((view) => (
            <button
              key={view.level}
              type="button"
              role="tab"
              aria-selected={level === view.level}
              className={`view-option${level === view.level ? ' is-on' : ''}`}
              title={view.title}
              onClick={() => level !== view.level && onView(view.level)}
            >
              {view.label}
            </button>
          ))}
        </div>
        <div className="modes" aria-label="Autoplay">
          {inCity && (
            <Mode on={touring} label="Tour" title="Walk the wall’s most interesting cameras one after another (Space)" onClick={onToggleTour} />
          )}
          {inCity && onRoadTrip && (
            <Mode on={tripOn} label="Road trip" title="Drive a numbered route camera by camera" onClick={onRoadTrip} />
          )}
          {onRelay && <Mode on={relayOn} label="Sun relay" title="Follow the sunset, or the sunrise, from city to city" onClick={onRelay} />}
        </div>
        {inCity && onWhich && (
          <button type="button" className={`control which-toggle${whichOpen ? ' is-on' : ''}`} aria-pressed={whichOpen} title="Which would you watch? Pick between two cameras, and the wall learns your attention" onClick={onWhich}>
            Which?
          </button>
        )}
        {onDiary && (
          <button type="button" className={`control diary-toggle${diaryOpen ? ' is-on' : ''}`} aria-pressed={diaryOpen} title="What the wall noticed, day by day" onClick={onDiary}>
            <BookIcon />
            Diary
          </button>
        )}
      </div>
    </header>
  );
}

function Mode({ on, label, title, onClick }: { on: boolean; label: string; title: string; onClick: () => void }): ReactElement {
  return (
    <button type="button" className={`control mode${on ? ' is-on' : ''}`} aria-pressed={on} title={on ? `Stop ${label.toLowerCase()}` : title} onClick={onClick}>
      {on ? <StopIcon /> : <PlayIcon />}
      {on ? `Stop ${label.toLowerCase()}` : label}
    </button>
  );
}

function Icon({ children }: { children: ReactNode }): ReactElement {
  return (
    <svg className="control-icon" viewBox="0 0 10 10" aria-hidden="true">
      {children}
    </svg>
  );
}

const PlayIcon = (): ReactElement => (
  <Icon>
    <path d="M2 1.2 8.6 5 2 8.8Z" />
  </Icon>
);

const StopIcon = (): ReactElement => (
  <Icon>
    <rect x="2" y="2" width="6" height="6" />
  </Icon>
);

const BookIcon = (): ReactElement => (
  <Icon>
    <path d="M1.2 1.8h3.1c.5 0 .7.3.7.7v6c0-.4-.3-.6-.7-.6H1.2ZM8.8 1.8H5.7c-.5 0-.7.3-.7.7v6c0-.4.3-.6.7-.6h3.1Z" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" />
  </Icon>
);
