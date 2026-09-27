import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { getFrames, getLive, liveUrl, snapUrl, type Camera, type RegionMeta, type Frame, type Incident } from '../api';
import { since } from './IncidentCard';
import { usePlayer } from '../hooks/usePlayer';
import { Ptz } from '../ptz';
import type { AttentionAxes } from '@rt511/shared';
import { LiveMotion } from './LiveMotion';
import { NightShift } from './NightShift';
import { Crossfade } from './Crossfade';
import { period } from '../format';

/** The promoted camera: the one video element in the application, the ring buffer behind it as an instant replay, and digital pan, tilt and zoom over both.
 *
 * The chrome is React. Playback, the transform and the frame layers are not: they are media and pointer work on a ten-second cadence that the virtual DOM has nothing to offer. */
/** How long each frame of the timelapse stays up. A frame is roughly a minute of real time, so this plays ten minutes in about four seconds. */
const TIMELAPSE_MS = 400;
/** How often the panel restates that its camera is open, for a source with no faster focus period. Inside the server's thirty-second claim, with room for a slow request. */
const PANEL_RESTATE_S = 20;

export function CameraPanel({
  camera,
  source,
  axes,
  docked,
  expanded,
  pollTick,
  incidents,
  visible,
  onClose,
  onExpanded,
  overlay = null,
}: {
  camera: Camera | null;
  source: RegionMeta | undefined;
  axes: AttentionAxes | null;
  docked: boolean;
  expanded: boolean;
  /** Live dispatch records that named this camera as one of their nearby views. */
  incidents: Incident[];
  /** Bumped by the poll loop, so the replay range follows new frames without the panel owning a timer. */
  pollTick: number;
  visible: boolean;
  onClose: () => void;
  onExpanded: (expanded: boolean) => void;
  /** Drawn over the picture, such as a road trip's progress. */
  overlay?: ReactNode;
}): ReactElement {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLDivElement>(null);
  const zoom = useRef<HTMLDivElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const ptz = useRef<Ptz | null>(null);

  const [frames, setFrames] = useState<Frame[]>([]);
  const [scrub, setScrub] = useState(0);
  const [live, setLive] = useState(true);
  const [hasRing, setHasRing] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  /** The timelapse: the replay ring played as a loop. The frames are the ones the server already holds in memory for the scrub, so nothing is kept that was not kept before. */
  const [playing, setPlaying] = useState(false);
  const inFlight = useRef(false);

  const { mode, live: streaming } = usePlayer(video, camera);

  /** The open camera at its agency's own refresh rate, where that is faster than the wall's poll: how often a new picture can be expected, and when the newest was taken. */
  const [focusPeriod, setFocusPeriod] = useState<number | null>(null);
  const [focusTs, setFocusTs] = useState<number | null>(null);
  /** How often the wall itself is fetching this camera, for the badge of a snapshot camera without a focus period. */
  const [pollPeriod, setPollPeriod] = useState<number | null>(null);
  const wantsFocus = camera !== null && visible && live && !streaming;

  useEffect(() => {
    setFocusPeriod(null);
    setFocusTs(null);
    setPollPeriod(null);
    if (!camera || !wantsFocus) return;
    let cancelled = false;
    let timer = 0;
    const run = async (): Promise<void> => {
      const response = await getLive(camera.id);
      if (cancelled) return;
      setFocusPeriod(response?.period_s ?? null);
      setPollPeriod(response?.poll_s ?? null);
      if (response?.ts) setFocusTs(response.ts);
      // Asked again on the focus period, or every twenty seconds for a source without one, because each ask also keeps this camera on its source's own poll period and that claim lapses after thirty.
      timer = window.setTimeout(() => void run(), (response?.period_s ?? PANEL_RESTATE_S) * 1000);
    };
    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [camera, wantsFocus]);

  useEffect(() => {
    const viewport = stage.current;
    const target = media.current;
    const readout = zoom.current;
    if (!viewport || !target || !readout) return;
    // The transform sits on the wrapper holding both layers, so digital zoom applies to the replay stills as well as the live video.
    const instance = new Ptz(viewport, target, readout);
    ptz.current = instance;
    return () => {
      instance.destroy();
      ptz.current = null;
    };
  }, []);

  // A pan and zoom belongs to the picture it was framed on, so it goes back to 1x whenever the camera changes, and the stage forgets the old source's shape.
  useEffect(() => {
    ptz.current?.reset();
    ptz.current?.setSourceAspect(null);
    root.current?.style.removeProperty('--stage-aspect');
    setFrames([]);
    setScrub(0);
    setLive(true);
    setHasRing(true);
    setPlaying(false);
  }, [camera?.id]);

  const adoptSource = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    root.current?.style.setProperty('--stage-aspect', `${width} / ${height}`);
    ptz.current?.setSourceAspect(width / height);
  }, []);

  const loadFrames = useCallback(async () => {
    if (!camera || inFlight.current) return;
    inFlight.current = true;
    const res = await getFrames(camera.id).finally(() => {
      inFlight.current = false;
    });
    if (!res) {
      // A camera this run is not polling has no ring buffer, and asking again every ten seconds would be noise.
      setHasRing(false);
      return;
    }
    setFrames(res.frames);
    setScrub((current) => (live ? Math.max(0, res.frames.length - 1) : current));
  }, [camera, live]);

  useEffect(() => {
    if (!camera) return;
    void loadFrames();
  }, [camera, loadFrames]);

  useEffect(() => {
    if (!camera || !live || !hasRing) return;
    void loadFrames();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the poll tick is the trigger; re-running on loadFrames identity would refetch on every keystroke of state.
  }, [pollTick]);

  // A panel that closes while it is fullscreen would otherwise leave the browser fullscreen on a hidden element: a black screen that only Escape gets out of. Moving to another camera keeps it fullscreen, so a tour can run there.
  useEffect(() => {
    if (visible && camera) return;
    if (document.fullscreenElement && document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => undefined);
  }, [visible, camera]);

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('is-expanded', expanded);
    return () => document.body.classList.remove('is-expanded');
  }, [expanded]);

  const last = Math.max(0, frames.length - 1);

  // Every frame is fetched once up front, so the loop plays from the browser's cache rather than stuttering on the first pass.
  useEffect(() => {
    if (!playing || !camera) return;
    for (const item of frames) new Image().src = snapUrl(camera.id, item.k, item.ts);
    const timer = window.setInterval(() => setScrub((current) => (current >= last ? 0 : current + 1)), TIMELAPSE_MS);
    return () => window.clearInterval(timer);
  }, [playing, camera, frames, last]);
  const frame = frames[Math.min(scrub, last)];
  const showStill = !live || !streaming;

  // The still is the newest frame until the viewer scrubs, and the scrubbed one after that.
  const stillSrc = useMemo(() => {
    // Nothing to ask for until the camera has a frame. A server started without a named city polls nothing until one is opened, so a camera can be legitimately empty for its first minute, and requesting a snapshot then is a guaranteed 404.
    if (!camera || frames.length === 0) return '';
    if (live && focusPeriod !== null && focusTs !== null && focusTs >= (frame?.ts ?? 0)) return liveUrl(camera.id, focusTs);
    if (live || !frame) return snapUrl(camera.id, -1, frame?.ts ?? Date.now() / 1000);
    return snapUrl(camera.id, frame.k, frame.ts);
  }, [camera, live, frame, frames.length, focusPeriod, focusTs]);

  // A camera without video says so plainly: it is a live snapshot, and the badge says how often a new one arrives, so it is never mistaken for a video feed.
  const snapshotEvery = focusPeriod ?? pollPeriod;
  const snapshot = !streaming && mode === 'Snapshots only' && snapshotEvery !== null;
  const tuning = camera !== null && visible && live && ((camera.has_video && !streaming && mode === 'Loading') || frames.length === 0);
  // Two looks that cannot be confused at a glance: a red LIVE pill for a stream, a grey framed SNAPSHOT with its refresh for a still.
  const badge = !live ? 'Replay' : streaming ? 'Live' : snapshot ? `Snapshot · ${period(snapshotEvery)}` : mode;
  const badgeKey = !live ? 'replay' : streaming ? 'live' : snapshot ? 'snapshot' : mode.toLowerCase().replace(/\s+/g, '-');
  const shownTs = live && focusPeriod !== null && focusTs !== null ? Math.max(focusTs, frame?.ts ?? 0) : frame?.ts;
  const stamp = shownTs !== undefined
    ? `${new Date(shownTs * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} · ${
        live ? 'newest frame' : `${Math.max(0, Math.round(Date.now() / 1000 - shownTs))}s ago`
      }`
    : '';

  const className = ['hero', docked ? 'is-docked' : '', expanded ? 'is-expanded' : '', fullscreen ? 'is-fullscreen' : '', streaming ? 'is-live' : '', frames.length > 1 ? 'has-replay' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <section className={className} ref={root} hidden={!visible} data-mode={badgeKey}>
      <div className="hero-stage" ref={stage}>
        <div className="hero-media" ref={media}>
          <Crossfade
            className={`hero-still${showStill ? ' is-visible' : ''}`}
            src={stillSrc}
            fadeMs={live && !playing ? 700 : 120}
            onSize={(width, height) => {
              if (!video || video.videoWidth === 0) adoptSource(width, height);
            }}
          />
          <video
            className="hero-video"
            ref={setVideo}
            crossOrigin="anonymous"
            muted
            playsInline
            autoPlay
            onLoadedMetadata={(event) => adoptSource(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          />
        </div>
        {/* While a stream is being tuned in, or before a camera's first picture, a slow scan crosses the frame and a ring breathes in the middle, so the wait reads as something happening. It fades away when the picture arrives. */}
        <div className={`hero-tuning${tuning ? ' is-on' : ''}`} aria-hidden="true">
          <span className="hero-tuning-scan" />
          <span className="hero-tuning-ring" />
          <span className="hero-tuning-text">{camera?.has_video ? 'Tuning in' : 'Waiting for the first picture'}</span>
        </div>
        <div className="hero-badge">
          <span className="hero-mode">{badge}</span>
        </div>
        <div className="hero-zoom" ref={zoom} />
        <NightShift camera={camera} />
        {overlay}
      </div>
      <div className="hero-panel">
        <div className="hero-titles">
          <div className="hero-road">{camera ? (camera.direction ? `${camera.roadway} · ${camera.direction}` : camera.roadway) : ''}</div>
          <h1 className="hero-where">{camera?.location ?? ''}</h1>
          {source?.site_url && source.source_name && (
            <div className="hero-source">
              <a className="source-link" href={source.site_url} target="_blank" rel="noopener">Live conditions on {source.source_name}</a>
            </div>
          )}
          {source?.attribution && (
            <div className="hero-rights">
              {source.attribution}
              {source.license && ` · ${source.license}`}
              {source.terms_url && (
                <>
                  {' · '}
                  <a className="source-link" href={source.terms_url} target="_blank" rel="noopener">terms</a>
                </>
              )}
              {/* Repeated verbatim because the agency's terms require it wherever its cameras are credited. */}
              {source.notice && <p className="hero-notice">{source.notice}</p>}
            </div>
          )}
        </div>
        {incidents.length > 0 && (
          <div className="hero-incidents">
            {incidents.map((incident) => (
              <div className="hero-incident" key={incident.id}>
                <span className="hero-incident-code">{incident.type || 'incident'}</span>
                <span className="hero-incident-where">{incident.location}</span>
                <span className="hero-incident-when">{since(incident.reported_at)}</span>
              </div>
            ))}
          </div>
        )}
        {/* The live line needs pictures faster than the wall's own minute: a stream, or an agency that refreshes its snapshots every few seconds. A camera with neither has nothing to draw it from, so it is left out rather than left waiting. */}
        {camera && (camera.has_video || focusPeriod !== null) && (
          <LiveMotion
            key={camera.id}
            video={video}
            axes={axes}
            active={visible && live && streaming}
            still={!streaming && focusPeriod !== null && focusTs !== null && visible && live ? { src: liveUrl(camera.id, focusTs), periodS: focusPeriod } : null}
          />
        )}
        <dl className="hero-facts">
          <dt>Camera</dt>
          <dd>#{camera?.id ?? ''}</dd>
          <dt>Site</dt>
          <dd>{camera?.site ?? 'unplaced'}</dd>
          <dt>Class</dt>
          <dd>{camera ? (camera.is_freeway ? 'Freeway' : 'Surface street') : ''}</dd>
          <dt>Position</dt>
          <dd>{camera ? `${camera.lat.toFixed(4)}, ${camera.lon.toFixed(4)}` : ''}</dd>
        </dl>
        <div className="hero-keys">
          <span>
            <kbd>&larr;</kbd> <kbd>&rarr;</kbd> along the corridor
          </span>
          <span>scroll to zoom, drag to pan, double-click to reset</span>
          <span>
            <kbd>F</kbd> expand
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
        <div className="hero-replay">
          <label className="hero-legend" htmlFor="hero-scrub">
            Instant replay
          </label>
          <input
            className="hero-scrub"
            id="hero-scrub"
            type="range"
            min={0}
            max={last}
            step={1}
            value={Math.min(scrub, last)}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              setPlaying(false);
              setScrub(value);
              setLive(value >= last);
            }}
          />
          <div className="hero-stamp">{stamp}</div>
          {frames.length > 1 && (
            <button
              type="button"
              className={`hero-timelapse${playing ? ' is-on' : ''}`}
              aria-pressed={playing}
              onClick={() => {
                if (playing) {
                  setPlaying(false);
                  setLive(true);
                  setScrub(last);
                } else {
                  setLive(false);
                  setScrub(0);
                  setPlaying(true);
                }
              }}
            >
              {playing ? 'Stop timelapse' : `Timelapse · ${frames.length} frames`}
            </button>
          )}
        </div>
        <div className="hero-actions">
          <button type="button" className={`hero-expand${expanded ? ' is-on' : ''}`} onClick={() => onExpanded(!expanded)}>
            {expanded ? 'Collapse ' : 'Expand '}
            <kbd>F</kbd>
          </button>
          <button
            type="button"
            className="hero-full"
            onClick={() => {
              const element = root.current;
              if (!element) return;
              // Fullscreen can be refused (no gesture, or a policy); the in-page expand covers the same need.
              if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => undefined);
              else void element.requestFullscreen().catch(() => undefined);
            }}
          >
            Fullscreen
          </button>
          <button type="button" className="hero-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </section>
  );
}
