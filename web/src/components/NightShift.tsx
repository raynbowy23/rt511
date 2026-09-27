import { useEffect, useState, type ReactElement } from 'react';
import { solarElevation } from '@rt511/shared';
import { getCount, type Camera, type CountResponse } from '../api';

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
export function NightShift({ camera, timeZone = null }: { camera: Camera | null; /** The city's IANA time zone, from its source in data/sources.json. Without one the viewer's own clock is used. */ timeZone?: string | null }): ReactElement | null {
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
  const zone = timeZone;
  const clock = new Date(count.frame_ts * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) });
  return (
    <div className="night-shift" title="Counted by the vehicle detector running on this machine. Display only, not part of the attention score.">
      <span className="night-shift-clock">{clock}</span>
      <span className="night-shift-count">{vehicles(count)}</span>
    </div>
  );
}
