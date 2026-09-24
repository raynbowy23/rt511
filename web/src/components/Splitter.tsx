import { useRef, type ReactElement } from 'react';
import { capture, release } from '../ptz';

export const DOCK_DEFAULT = 460;
const MIN_DOCK = 300;
const MIN_MAP = 340;
const KEY_STEP = 24;
const KEY_STEP_LARGE = 96;
/** Matches the grid column in the stylesheet. */
const TRACK_PX = 10;

/** The divider between the map and the camera. A real control: it takes focus, answers the arrow keys and carries a separator role, and the width it sets is React state so everything else in the layout simply follows it. */
export function Splitter({
  width,
  onWidth,
  onCommit,
  hidden,
}: {
  width: number;
  onWidth: (width: number) => void;
  onCommit: (width: number) => void;
  hidden: boolean;
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const frame = useRef(0);
  const pending = useRef(width);

  const clampTo = (value: number): number => {
    const layout = root.current?.parentElement;
    const available = layout?.getBoundingClientRect().width ?? 0;
    const track = root.current?.offsetWidth || TRACK_PX;
    const max = available > 0 ? Math.max(MIN_DOCK, available - MIN_MAP - track) : Math.max(MIN_DOCK, value);
    return Math.round(Math.min(max, Math.max(MIN_DOCK, value)));
  };

  /** Coalesces a drag onto an animation frame: the map re-fits and redraws on every width change, and a raw pointermove stream would do that several times per frame. */
  const queue = (value: number): void => {
    pending.current = value;
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      onWidth(clampTo(pending.current));
    });
  };

  return (
    <div
      className="map-splitter"
      ref={root}
      hidden={hidden}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the camera panel"
      aria-valuenow={width}
      aria-valuemin={MIN_DOCK}
      aria-valuetext={`Camera panel ${width} pixels wide`}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging.current = true;
        capture(event.currentTarget, event.pointerId);
        event.currentTarget.classList.add('is-dragging');
        document.body.classList.add('is-resizing');
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const layout = root.current?.parentElement?.getBoundingClientRect();
        if (!layout) return;
        // The camera is anchored to the right edge, so its width is whatever lies between the pointer and that edge.
        queue(layout.right - event.clientX - (root.current?.offsetWidth ?? TRACK_PX) / 2);
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        release(event.currentTarget, event.pointerId);
        event.currentTarget.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing');
        onCommit(clampTo(pending.current));
      }}
      onPointerCancel={(event) => {
        dragging.current = false;
        release(event.currentTarget, event.pointerId);
        event.currentTarget.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing');
      }}
      onDoubleClick={() => onCommit(clampTo(DOCK_DEFAULT))}
      onKeyDown={(event) => {
        const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
        let next: number | null = null;
        if (event.key === 'ArrowLeft') next = width + step;
        else if (event.key === 'ArrowRight') next = width - step;
        else if (event.key === 'Home' || event.key === 'Enter') next = DOCK_DEFAULT;
        if (next === null) return;
        // The arrows also step the hero along the graph, so a focused splitter keeps them for itself.
        event.preventDefault();
        event.stopPropagation();
        onCommit(clampTo(next));
      }}
    />
  );
}
