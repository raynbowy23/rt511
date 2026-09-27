import { useEffect, useState, type ReactElement } from 'react';
import { solarElevation } from '@rt511/shared';
import { getCount, type Camera, type CountResponse } from '../api';

/** The time zone of each state the wall reads, taken from the two-letter suffix of a region key such as `des-moines-ia`. Every city served today sits in its state's main zone. A state missing here falls back to the viewer's own clock. */
const ZONES: Record<string, string> = {
  ca: 'America/Los_Angeles',
  or: 'America/Los_Angeles',
  ia: 'America/Chicago',
  ky: 'America/New_York',
  oh: 'America/New_York',
  vt: 'America/New_York',
  nh: 'America/New_York',
  me: 'America/New_York',
  wi: 'America/Chicago',
};

/** How often the open camera is asked about. The server counts each frame once, so asking more often than frames arrive costs nothing but a lookup. */
const EVERY_MS = 15_000;

const NOUNS: Record<string, [string, string]> = {
  car: ['car', 'cars'],
  truck: ['truck', 'trucks'],
  bus: ['bus', 'buses'],
  motorcycle: ['motorcycle', 'motorcycles'],
};

export function vehicles(count: CountResponse): string {
  const parts = Object.entries(count.by_class ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => {
      const [one, many] = NOUNS[kind] ?? [kind, kind];
      return `${String(n)} ${n === 1 ? one : many}`;
    });
  return parts.length > 0 ? parts.join(', ') : 'no vehicles';
}

/** Night shift: after dark at the camera, the vehicle detector's count of the picture on screen, in the camera's own local time. "3:12 AM · 2 cars."
 *
 * Display only. It reads the same count the gate logs, and nothing here feeds the attention score. It shows nothing in daylight, and nothing at all when no detector is running. */
export function NightShift({ camera }: { camera: Camera | null }): ReactElement | null {
  const [count, setCount] = useState<CountResponse | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const dark = camera !== null && solarElevation(camera.lat, camera.lon, now) < 0;

  useEffect(() => {
    setCount(null);
    if (!camera || !dark) return;
    let cancelled = false;
    const run = async (): Promise<void> => {
      const response = await getCount(camera.id);
      if (!cancelled) setCount(response);
    };
    void run();
    const timer = window.setInterval(() => void run(), EVERY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [camera, dark]);

  // The clock and the darkness both move, so the line is re-read once a minute even when the count has not changed.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!camera || !dark || count?.status !== 'counted' || count.frame_ts === undefined) return null;
  const zone = ZONES[(camera.region ?? '').slice(-2)];
  const clock = new Date(count.frame_ts * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) });
  return (
    <div className="night-shift" title="Counted by the vehicle detector running on this machine. Display only, not part of the attention score.">
      <span className="night-shift-clock">{clock}</span>
      <span className="night-shift-count">{vehicles(count)}</span>
    </div>
  );
}
