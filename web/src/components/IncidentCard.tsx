import type { ReactElement } from 'react';
import type { Camera, Incident } from '../api';

/** How long ago, in the units a person would say it in. */
export function since(seconds: number | null): string {
  if (seconds === null) return 'time unknown';
  const age = Math.max(0, Date.now() / 1000 - seconds);
  if (age < 90) return `${Math.round(age)} s ago`;
  if (age < 5400) return `${Math.round(age / 60)} min ago`;
  return `${(age / 3600).toFixed(1)} h ago`;
}

/** One dispatch record, opened from the map.
 *
 * The type is the agency's own signal code and is shown raw, because inventing a label for it would be worse. */
export function IncidentCard({
  incident,
  cameras,
  attribution,
  onCamera,
  onClose,
}: {
  incident: Incident;
  cameras: Map<number, Camera>;
  attribution: string;
  onCamera: (id: number) => void;
  onClose: () => void;
}): ReactElement {
  const nearby = incident.cameras.map((id) => ({ id, camera: cameras.get(id) })).filter((entry) => entry.camera !== undefined);
  return (
    <aside className="incident-card" role="dialog" aria-label="Incident">
      <div className="incident-card-head">
        <span className="incident-code">{incident.type || 'incident'}</span>
        <span className="incident-when">{since(incident.reported_at)}</span>
        <button type="button" className="incident-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <h2 className="incident-where">{incident.location || 'location not given'}</h2>
      <div className="incident-place">{[incident.city, incident.county].filter(Boolean).join(' · ')}</div>
      {incident.remarks && <p className="incident-remarks">{incident.remarks}</p>}
      {nearby.length > 0 ? (
        <div className="incident-cameras">
          <div className="incident-legend">Cameras within 1.5 km</div>
          {nearby.map(({ id, camera }) => (
            <button key={id} type="button" className="incident-camera" onClick={() => onCamera(id)}>
              {camera?.location ?? `#${id}`}
            </button>
          ))}
        </div>
      ) : (
        <div className="incident-legend">No camera within 1.5 km</div>
      )}
      <div className="incident-credit">{attribution}</div>
    </aside>
  );
}
