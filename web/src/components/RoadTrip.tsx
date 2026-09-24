import { useEffect, type ReactElement } from 'react';
import type { Trip } from '../roadtrip';

function km(metres: number): string {
  return `${(metres / 1000).toFixed(1)} km`;
}

/** The trips a city offers, longest first. Opened from the top bar; picking one starts it and closes the list. */
export function RoadTripPicker({ trips, onPick, onClose }: { trips: Trip[]; onPick: (trip: Trip) => void; onClose: () => void }): ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  return (
    <aside className="trip-picker" aria-label="Road trips">
      <header className="trip-picker-head">
        <span className="trip-picker-title">Road trip</span>
        <button type="button" className="trip-picker-close" onClick={onClose}>
          Close <kbd>Esc</kbd>
        </button>
      </header>
      {trips.length === 0 ? (
        <p className="trip-picker-empty">No numbered route in this city has three cameras in a row to drive past.</p>
      ) : (
        <ol className="trip-picker-list">
          {trips.map((trip) => (
            <li key={trip.id}>
              <button type="button" className="trip-picker-item" onClick={() => onPick(trip)}>
                <span className="trip-picker-route">
                  {trip.route} {trip.heading}
                </span>
                <span className="trip-picker-facts">
                  {trip.stops.length} cameras · {km(trip.length_m)}
                  {trip.stops.some((stop) => stop.camera.has_video) ? ` · ${trip.stops.filter((stop) => stop.camera.has_video).length} with live video` : ''}
                </span>
                <span className="trip-picker-ends">
                  {trip.stops[0]!.camera.location} → {trip.stops[trip.stops.length - 1]!.camera.location}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

/** Where the trip is, over the picture: the route, the stop, how far has been driven and what comes next. */
export function TripHud({ trip, index, onStop }: { trip: Trip; index: number; onStop: () => void }): ReactElement {
  const stop = trip.stops[index]!;
  const next = trip.stops[index + 1];
  return (
    <div className="trip-hud" role="status">
      <div className="trip-hud-route">
        Road trip · {trip.route} {trip.heading}
      </div>
      <div className="trip-hud-progress">
        Camera {index + 1} of {trip.stops.length} · {km(stop.distance_m)} of {km(trip.length_m)}
      </div>
      <div className="trip-hud-bar" aria-hidden="true">
        <span style={{ width: `${trip.length_m > 0 ? (100 * stop.distance_m) / trip.length_m : 0}%` }} />
      </div>
      <div className="trip-hud-next">{next ? `Next · ${next.camera.location} in ${km(next.leg_m)}` : 'End of the road · turning around'}</div>
      <button type="button" className="trip-hud-stop" onClick={onStop}>
        End trip
      </button>
    </div>
  );
}
