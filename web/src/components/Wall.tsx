import { memo, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { snapUrl, type Camera, type CameraState } from '../api';
import { prefersReducedMotion } from '../motion';

export type Tier = 'big' | 'wide' | 'unit';

export interface TileRank {
  tier: Tier;
  top: boolean;
}

/** One camera. The cross-fade is deliberately outside React: the two layers swap classes when a new snapshot has decoded, which is a DOM detail on a ten-second cadence, not state anything else needs. Re-rendering a tile to change an image source would throw away the layer that is currently visible. */
const Tile = memo(function Tile({
  camera,
  state,
  rank,
  active,
  intervalS,
  observer,
  caption,
  follow,
  onSelect,
}: {
  caption?: string | undefined;
  /** Whether becoming active scrolls this tile into view. */
  follow: boolean;
  camera: Camera;
  state: CameraState | undefined;
  rank: TileRank;
  active: boolean;
  intervalS: number;
  /** Watches this tile so the server can be told which cameras are actually on screen. */
  observer: IntersectionObserver | null;
  onSelect: (id: number) => void;
}): ReactElement {
  const root = useRef<HTMLButtonElement>(null);
  const layers = useRef<[HTMLImageElement | null, HTMLImageElement | null]>([null, null]);
  const front = useRef<0 | 1>(0);
  const shownTs = useRef<number | null>(null);

  const lastTs = state?.last_ts ?? null;
  const hasFrames = (state?.frames ?? 0) > 0 && lastTs !== null;

  useEffect(() => {
    if (!hasFrames || lastTs === null || lastTs === shownTs.current) return;
    const back = layers.current[front.current === 0 ? 1 : 0];
    const face = layers.current[front.current];
    if (!back || !face) return;
    // Only fade once the new frame has decoded, so a slow or failed fetch never flashes an empty tile.
    back.onload = () => {
      back.classList.add('is-front');
      face.classList.remove('is-front');
      front.current = front.current === 0 ? 1 : 0;
      shownTs.current = lastTs;
      root.current?.classList.add('has-frame');
    };
    back.onerror = () => {
      back.onload = null;
    };
    back.src = snapUrl(camera.id, -1, lastTs);
  }, [camera.id, hasFrames, lastTs]);

  // The settle animation has to be restarted by hand when a tile changes tier twice in quick succession.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.classList.remove('is-resizing');
    void element.offsetWidth;
    element.classList.add('is-resizing');
  }, [rank.tier]);

  useEffect(() => {
    if (active && follow) root.current?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [active, follow]);

  useEffect(() => {
    const element = root.current;
    if (!observer || !element) return;
    observer.observe(element);
    return () => observer.unobserve(element);
  }, [observer]);

  const activity = state?.activity ?? null;
  // Judge staleness against this camera's own poll period. The wall-wide interval is the shortest across sources, which would call a 60 s camera stale on a 30 s clock.
  const stale = hasFrames && Date.now() / 1000 - (lastTs ?? 0) > 3 * (state?.period_s ?? intervalS);
  const className = [
    'tile',
    camera.is_freeway ? 'is-freeway' : '',
    hasFrames ? '' : 'is-empty',
    stale ? 'is-stale' : '',
    activity !== null && activity > 0.72 ? 'is-hot' : '',
    active ? 'is-active' : '',
    rank.top ? 'is-top' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      ref={root}
      className={className}
      data-id={camera.id}
      onClick={() => onSelect(camera.id)}
      style={{ '--col-span': rank.tier === 'unit' ? 1 : 2, '--row-span': rank.tier === 'big' ? 2 : 1 } as React.CSSProperties}
    >
      <div className="tile-frames">
        <img className="tile-layer is-front" alt="" decoding="async" ref={(el) => void (layers.current[0] = el)} />
        <img className="tile-layer" alt="" decoding="async" ref={(el) => void (layers.current[1] = el)} />
      </div>
      <div className="tile-label">
        {/* Every tile is a snapshot, so the ones that open onto a live stream say so. It sits in the label strip rather than on the picture, where agencies print their own captions. */}
        <span className="tile-where">
          {camera.has_video && <span className="tile-kind">Video</span>}
          {camera.location}
        </span>
        {caption && <span className="tile-city">{caption}</span>}
      </div>
      <div className="tile-pulse">
        <i style={{ transform: `scaleX(${activity === null ? 0 : Math.max(0.02, Math.min(1, activity))})` }} />
      </div>
    </button>
  );
});

export function Wall({
  highlights,
  cameras,
  captions,
  states,
  ranks,
  activeId,
  intervalS,
  visible,
  followActive = true,
  onSelect,
  onVisibleCameras,
}: {
  highlights?: ReactNode;
  /** Scroll the active camera's tile into view when it changes. Off during a road trip, where the camera panel above the wall is what is being watched. */
  followActive?: boolean;
  cameras: Camera[];
  captions?: Map<number, string> | undefined;
  states: Map<number, CameraState>;
  ranks: Map<number, TileRank>;
  activeId: number | null;
  intervalS: number;
  visible: boolean;
  onSelect: (id: number) => void;
  /** Reports which cameras are on screen, so the server polls those and lets the rest of the city idle. */
  onVisibleCameras: (ids: number[]) => void;
}): ReactElement {
  const grid = useRef<HTMLDivElement>(null);
  const rowHeight = useRef(0);
  const onScreen = useRef(new Set<number>());
  const [observer, setObserver] = useState<IntersectionObserver | null>(null);
  const report = useRef(onVisibleCameras);
  report.current = onVisibleCameras;

  /** One observer for the whole grid. The margin is half a screen above and below, which is about two rows of tiles: enough that a tile is warm by the time it scrolls in, and not so much that the fast tier quietly becomes the whole city again. */
  useEffect(() => {
    const seen = onScreen.current;
    const instance = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.id);
          if (!Number.isFinite(id)) continue;
          if (entry.isIntersecting) seen.add(id);
          else seen.delete(id);
        }
        report.current([...seen]);
      },
      { rootMargin: '50% 0px', threshold: 0 },
    );
    setObserver(instance);
    return () => {
      instance.disconnect();
      setObserver(null);
      seen.clear();
    };
  }, []);

  // Leaving the wall means nothing is on screen, which is a statement the server acts on rather than an absence it has to time out.
  useEffect(() => {
    if (visible) return;
    onScreen.current.clear();
    report.current([]);
  }, [visible]);

  /** The grid columns are fluid, so the row height is derived from the measured first track to keep tiles at roughly 3:2 whatever the viewport does. Writing the variable resizes the grid, which would feed the observer back into itself, so an unchanged value is never written. */
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    let frame = 0;
    const measure = (): void => {
      const tracks = getComputedStyle(element).gridTemplateColumns.split(' ');
      const first = Number.parseFloat(tracks[0] ?? '');
      if (!Number.isFinite(first) || first <= 0) return;
      const height = Math.round(first * 0.66);
      if (height === rowHeight.current) return;
      rowHeight.current = height;
      element.style.setProperty('--row-h', `${height}px`);
    };
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    });
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (visible) rowHeight.current = 0;
  }, [visible]);

  return (
    <main className="pane pane-wall wall-host" hidden={!visible}>
      {highlights}
      <div className="wall" ref={grid}>
        {cameras.map((camera) => (
          <Tile
            key={camera.id}
            camera={camera}
            caption={captions?.get(camera.id)}
            state={states.get(camera.id)}
            rank={ranks.get(camera.id) ?? { tier: 'unit', top: false }}
            active={activeId === camera.id}
            intervalS={intervalS}
            observer={observer}
            follow={followActive}
            onSelect={onSelect}
          />
        ))}
      </div>
    </main>
  );
}
