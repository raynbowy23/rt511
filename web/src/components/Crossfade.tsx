import { useState, type ReactElement } from 'react';

/** The panel's still picture, on two layers so that a new snapshot fades in over the old one instead of replacing it with a jump.
 *
 * The incoming picture loads into the hidden layer and only takes the front once the browser has it, so a slow fetch never shows a blank or half-drawn frame. The layer it replaces stays opaque underneath, which avoids a dip in brightness. */
export function Crossfade({
  src,
  className,
  fadeMs,
  onSize,
}: {
  src: string;
  className: string;
  /** How long a new picture takes to fade in. Short while scrubbing or playing the timelapse, longer for a live picture arriving every few seconds. */
  fadeMs: number;
  onSize: (width: number, height: number) => void;
}): ReactElement {
  const [layers, setLayers] = useState<[string, string]>([src, '']);
  /** What each layer has finished loading. A layer takes the front only once this matches, including when the viewer scrubs back to a picture the hidden layer already holds, which fires no second load event. */
  const [loaded, setLoaded] = useState<[string, string]>(['', '']);
  const [front, setFront] = useState(0);

  // Derived during render rather than in an effect, so there is never a render with the new picture asked for and nothing done about it.
  const back = 1 - front;
  if (src && src !== layers[front]) {
    if (layers[back] !== src) {
      const next: [string, string] = [layers[0], layers[1]];
      next[back] = src;
      setLayers(next);
    } else if (loaded[back] === src) {
      setFront(back);
    }
  }

  return (
    <div className={className} style={{ ['--still-fade' as string]: `${String(fadeMs)}ms` }}>
      {layers.map((layer, i) =>
        layer ? (
          <img
            key={i}
            className={`hero-still-layer${i === front ? ' is-front' : ''}`}
            src={layer}
            alt=""
            decoding="async"
            draggable={false}
            onLoad={(event) => {
              onSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
              const done = event.currentTarget.getAttribute('src') ?? '';
              setLoaded((old) => (i === 0 ? [done, old[1]] : [old[0], done]));
            }}
          />
        ) : null,
      )}
    </div>
  );
}
