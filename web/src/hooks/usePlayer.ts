import { useEffect, useRef, useState } from 'react';
import type HlsType from 'hls.js';
import { getStream, type Camera } from '../api';

/** Owns the one video element's playback: the stream lookup, the hls.js instance and its teardown.
 *
 * React's development mode mounts every effect twice, and an async attach that ignores its own cancellation would leave a second hls.js instance pulling segments for a video element nobody can see. Every path out of this effect destroys what it made. */
export function usePlayer(video: HTMLVideoElement | null, camera: Camera | null): { mode: string; live: boolean } {
  const [mode, setMode] = useState('Loading');
  const [live, setLive] = useState(false);
  // The attach is async; this tells a late resolution that its effect has already been cleaned up.
  const generation = useRef(0);

  useEffect(() => {
    if (!video || !camera) {
      setMode('Loading');
      setLive(false);
      return;
    }

    const mine = ++generation.current;
    let hls: HlsType | null = null;
    let canceled = false;
    setLive(false);
    setMode('Loading');

    const onPlaying = (): void => {
      if (canceled || mine !== generation.current) return;
      setLive(true);
      setMode('Live');
    };
    video.addEventListener('playing', onPlaying);

    const teardown = (): void => {
      if (hls) {
        hls.destroy();
        hls = null;
      }
      video.removeAttribute('src');
      video.load();
    };

    void (async () => {
      if (!camera.has_video) {
        if (!canceled) setMode('Snapshots only');
        return;
      }
      const { stream, reason } = await getStream(camera.id);
      if (canceled || mine !== generation.current) return;
      if (!stream) {
        setMode(modeForReason(reason));
        return;
      }
      // hls.js is most of the bundle and only a promoted camera needs it, so it arrives the first time one is opened.
      const { default: Hls } = await import('hls.js');
      if (canceled || mine !== generation.current) return;

      if (Hls.isSupported()) {
        // liveSyncDurationCount 2 keeps latency near two segments, which on a 6 s target duration is about as close to live as this source allows.
        const instance = new Hls({ liveSyncDurationCount: 2, enableWorker: true });
        hls = instance;
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || canceled) return;
          instance.destroy();
          if (hls === instance) hls = null;
          setMode(modeForReason(null));
          setLive(false);
        });
        instance.loadSource(stream.url);
        instance.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = stream.url;
      } else {
        setMode('Snapshots only');
        return;
      }
      void video.play().catch(() => undefined);
    })();

    return () => {
      canceled = true;
      video.removeEventListener('playing', onPlaying);
      teardown();
    };
  }, [video, camera]);

  return { mode, live };
}

/** Says why there is no video, rather than calling everything "snapshots only". A camera this run is not polling has no stills either, so the difference matters on screen. */
function modeForReason(reason: string | null): string {
  if (reason === null) return 'Snapshots only';
  if (reason.includes('not being polled')) return 'Not polled';
  if (reason.includes('no stream')) return 'Snapshots only';
  if (reason.includes('unknown camera')) return 'Unknown camera';
  if (reason.includes('unreachable')) return 'Backend unreachable';
  return 'Snapshots only';
}
