import { useEffect, useMemo, useRef, useState } from 'react';
import type { Camera } from '../api';
import type { Topology } from '../graph';
import { Tour } from '../tour';

export interface TourControls {
  running: boolean;
  toggle: (fromCameraId?: number) => void;
  start: (fromCameraId?: number) => void;
  stop: () => void;
  follow: (cameraId: number) => void;
}

/** Wraps the corridor tour, a timer walking the graph outside React. The promote callback is held in a ref so the tour is not rebuilt on every render. */
export function useTour(topology: Topology | null, promote: (camera: Camera) => void): TourControls {
  const [running, setRunning] = useState(false);
  const promoteRef = useRef(promote);
  promoteRef.current = promote;

  const tour = useMemo(() => (topology ? new Tour(topology, (camera) => promoteRef.current(camera)) : null), [topology]);

  useEffect(() => {
    return () => {
      tour?.stop();
      setRunning(false);
    };
  }, [tour]);

  return useMemo(
    () => ({
      running,
      toggle: (fromCameraId?: number) => {
        if (!tour) return;
        tour.toggle(fromCameraId);
        setRunning(tour.running);
      },
      start: (fromCameraId?: number) => {
        if (!tour) return;
        tour.start(fromCameraId);
        setRunning(tour.running);
      },
      stop: () => {
        if (!tour) return;
        tour.stop();
        setRunning(false);
      },
      follow: (cameraId: number) => tour?.follow(cameraId),
    }),
    [tour, running],
  );
}
