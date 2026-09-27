import { useEffect, useRef, useState, type ReactElement } from 'react';
import { latOfLonLat, lonOfLonLat, solarElevation, type LonLat, type NationalResponse, type NationalSource } from '@rt511/shared';
import { AlbersUsa, groupForState, groupForStates } from '../albers';
import { prefersReducedMotion } from '../motion';
import { period } from '../format';

/** The front page: every camera in the country as a point of light, coloured by where the sun is on it right now, and a single way in. Clicking anywhere on the picture opens the map. The sources and their terms are one quiet click away, and the disclaimer is in the footer as on every page. */
export function Landing({
  national,
  disclaimer,
  onMap,
  onBoard,
  onRelay,
}: {
  national: NationalResponse;
  disclaimer: string;
  onMap: () => void;
  onBoard: () => void;
  onRelay: () => void;
}): ReactElement {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const cameras = Object.values(national.sources).reduce((sum, source) => sum + source.cameras.ids.length, 0);

  return (
    <main className="landing">
      <CameraSky national={national} onClick={onMap} />
      <div className="landing-copy">
        <h1 className="landing-title">rt511</h1>
        <p className="landing-lede">
          Live traffic cameras from coast to coast, {cameras.toLocaleString()} of them, each glowing with its own time of day. Step in and watch the roads breathe.
        </p>
        <div className="landing-actions">
          <button type="button" className="landing-cta" onClick={onMap}>
            Open the map
          </button>
          <button type="button" className="landing-link" onClick={onRelay}>
            Follow the sunset
          </button>
          <button type="button" className="landing-link" onClick={onBoard}>
            Busiest now
          </button>
          <button type="button" className={`landing-link${sourcesOpen ? ' is-on' : ''}`} aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((open) => !open)}>
            Sources and terms
          </button>
        </div>
        <p className="landing-legend">
          <i className="is-day" /> day <i className="is-dusk" /> sunset and sunrise <i className="is-night" /> night
        </p>
      </div>
      {sourcesOpen && <Sources national={national} disclaimer={disclaimer} onClose={() => setSourcesOpen(false)} />}
    </main>
  );
}

/** Colours for the three kinds of light, and the sun elevation that separates them. Civil twilight, six degrees either side of the horizon, is the band that reads as sunset. */
const LIGHT = {
  day: [248, 212, 138],
  dusk: [242, 118, 58],
  night: [120, 150, 236],
  DUSK_DEG: 6,
} as const;

/** The picture itself. Positions are projected once and colour is re-read from the sun once a minute. Between those the lights breathe in a dozen groups, each on its own slow cycle, so the country looks alive rather than printed. */
function CameraSky({ national, onClick }: { national: NationalResponse; onClick: () => void }): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  /** Whether the pointer is over the country, which is the only place a click opens the map. */
  const overRef = useRef(false);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;

    // The same Albers projection the country map uses, fitted to the lower 48, which is where every source is today.
    const outline: LonLat[] = [];
    for (const [code, state] of Object.entries(national.states)) {
      if (groupForState(code) !== 'conus') continue;
      for (const ring of state.polygons) for (const point of ring) outline.push(point);
    }
    const projection = new AlbersUsa({ conus: outline, alaska: [], hawaii: [] });
    const points: { x: number; y: number; lat: number; lon: number }[] = [];
    for (const source of Object.values(national.sources)) {
      const group = groupForStates(source.states);
      if (group !== 'conus') continue;
      const { lat, lon } = source.cameras;
      for (let i = 0; i < lat.length; i++) {
        const [x, y] = projection.project(lon[i] as number, lat[i] as number, group);
        points.push({ x, y, lat: lat[i] as number, lon: lon[i] as number });
      }
    }
    const states: [number, number][][] = [];
    for (const [code, state] of Object.entries(national.states)) {
      if (groupForState(code) !== 'conus') continue;
      for (const ring of state.polygons) states.push(ring.map((point) => projection.project(lonOfLonLat(point), latOfLonLat(point), 'conus')));
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of states) {
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    // One soft dot per colour, drawn once and stamped thousands of times, which is far cheaper than a gradient per point.
    const sprite = (rgb: readonly number[]): HTMLCanvasElement => {
      const size = 32;
      const dot = document.createElement('canvas');
      dot.width = size;
      dot.height = size;
      const g = dot.getContext('2d');
      if (g) {
        const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        gradient.addColorStop(0, `rgba(${rgb.join(',')},1)`);
        gradient.addColorStop(0.18, `rgba(${rgb.join(',')},0.85)`);
        gradient.addColorStop(0.45, `rgba(${rgb.join(',')},0.18)`);
        gradient.addColorStop(1, `rgba(${rgb.join(',')},0)`);
        g.fillStyle = gradient;
        g.fillRect(0, 0, size, size);
      }
      return dot;
    };
    const sprites = { day: sprite(LIGHT.day), dusk: sprite(LIGHT.dusk), night: sprite(LIGHT.night) };
    let kinds: ('day' | 'dusk' | 'night')[] = [];
    const readSun = (): void => {
      const now = Date.now() / 1000;
      kinds = points.map((point) => {
        const elevation = solarElevation(point.lat, point.lon, now);
        return elevation > LIGHT.DUSK_DEG ? 'day' : elevation > -LIGHT.DUSK_DEG ? 'dusk' : 'night';
      });
    };
    readSun();

    let width = 0;
    let height = 0;
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    // The lights are soft, so they need no more than one and a half device pixels each, and every layer below is that much cheaper to blend.
    const ratio = Math.min(1.5, window.devicePixelRatio || 1);

    // Every light belongs to one of a dozen layers, drawn once and then only blended each frame with its own slowly changing brightness. Twelve full-canvas blends a frame is a small fixed cost whatever the number of cameras, where stamping seven and a half thousand sprites a frame was what made it stutter.
    const LAYERS = 12;
    const layerOf = points.map(() => Math.floor(Math.random() * LAYERS));
    const rhythm = Array.from({ length: LAYERS }, (_, k) => ({ phase: (k / LAYERS) * Math.PI * 2, speed: 0.00045 + (k % 4) * 0.00012 }));
    const base = document.createElement('canvas');
    const layers = Array.from({ length: LAYERS }, () => document.createElement('canvas'));

    const build = (): void => {
      const pixelW = Math.max(1, Math.round(width * ratio));
      const pixelH = Math.max(1, Math.round(height * ratio));
      for (const layer of [base, ...layers]) {
        layer.width = pixelW;
        layer.height = pixelH;
      }
      const outline = base.getContext('2d');
      if (outline) {
        outline.setTransform(ratio, 0, 0, ratio, 0, 0);
        // The states as the faintest of lines, just enough to say "this is a country".
        outline.strokeStyle = 'rgba(255,255,255,0.1)';
        outline.lineWidth = 1;
        outline.beginPath();
        for (const ring of states) {
          ring.forEach(([x, y], i) => {
            const sx = x * scale + offsetX;
            const sy = y * scale + offsetY;
            if (i === 0) outline.moveTo(sx, sy);
            else outline.lineTo(sx, sy);
          });
          outline.closePath();
        }
        outline.stroke();
      }
      // The glow scales with the picture, so a phone and a wall-sized screen both read as a field of lights rather than dust or blobs.
      const size = Math.max(5, Math.min(11, width / 170));
      const contexts = layers.map((layer) => {
        const g = layer.getContext('2d');
        g?.setTransform(ratio, 0, 0, ratio, 0, 0);
        if (g) g.globalCompositeOperation = 'lighter';
        return g;
      });
      for (let i = 0; i < points.length; i++) {
        const point = points[i]!;
        const kind = kinds[i] ?? 'night';
        const g = contexts[layerOf[i]!];
        if (!g) continue;
        // Low enough that a city of hundreds of cameras glows rather than burning out to white, since the lights add up where they overlap.
        g.globalAlpha = kind === 'night' ? 0.42 : kind === 'dusk' ? 0.72 : 0.36;
        g.drawImage(sprites[kind], point.x * scale + offsetX - size / 2, point.y * scale + offsetY - size / 2, size, size);
      }
    };

    const resize = (): void => {
      const box = element.getBoundingClientRect();
      width = box.width;
      height = box.height;
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      // On a wide screen the country is a smaller picture on the right, clear of the words on the left; on a narrow one it takes the top.
      const wide = width > 900;
      const boxW = wide ? width * 0.5 : width * 0.92;
      const boxH = wide ? height * 0.72 : height * 0.5;
      scale = Math.min(boxW / (maxX - minX), boxH / (maxY - minY));
      offsetX = (wide ? width * 0.46 : width * 0.04) + (boxW - (maxX - minX) * scale) / 2 - minX * scale;
      offsetY = (wide ? (height - (maxY - minY) * scale) / 2.2 : height * 0.06) - minY * scale;
      build();
      outlinePath();
    };

    // Hover: the pointer over the country lifts it a little and turns the lights up, and only a click there opens the map. `lift` eases towards `over` each frame, so it glides rather than jumps.
    const still = prefersReducedMotion();
    const hit = document.createElement('canvas').getContext('2d');
    let country = new Path2D();
    let over = false;
    let lift = 0;
    const outlinePath = (): void => {
      country = new Path2D();
      for (const ring of states) {
        ring.forEach(([x, y], i) => {
          const sx = x * scale + offsetX;
          const sy = y * scale + offsetY;
          if (i === 0) country.moveTo(sx, sy);
          else country.lineTo(sx, sy);
        });
        country.closePath();
      }
    };
    const onMove = (event: PointerEvent): void => {
      const box = element.getBoundingClientRect();
      over = hit?.isPointInPath(country, event.clientX - box.left, event.clientY - box.top) ?? false;
      element.style.cursor = over ? 'pointer' : 'default';
      overRef.current = over;
      if (still) {
        lift = over ? 1 : 0;
        draw(0);
      }
    };
    const onLeave = (): void => {
      over = false;
      overRef.current = false;
      element.style.cursor = 'default';
      if (still) {
        lift = 0;
        draw(0);
      }
    };
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerleave', onLeave);

    const draw = (t: number): void => {
      lift += ((over ? 1 : 0) - lift) * 0.1;
      // Grown about its own centre and raised a few pixels, both in device pixels since the layers are drawn at that resolution.
      const grow = 1 + 0.03 * (still ? 0 : lift);
      const cx = (minX + maxX) / 2 * scale + offsetX;
      const cy = (minY + maxY) / 2 * scale + offsetY;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      context.clearRect(0, 0, element.width, element.height);
      context.setTransform(grow, 0, 0, grow, cx * ratio * (1 - grow), cy * ratio * (1 - grow) - 6 * ratio * (still ? 0 : lift));
      context.drawImage(base, 0, 0);
      // The outlines drawn a second time, as much as the hover has risen, so the country's edges firm up under the pointer.
      if (lift > 0.01) {
        context.globalAlpha = lift;
        context.drawImage(base, 0, 0);
      }
      context.globalCompositeOperation = 'lighter';
      for (let k = 0; k < LAYERS; k++) {
        const { phase, speed } = rhythm[k]!;
        // Never fully out: each group dims to about a third and back, so the country breathes without going dark. Hovering turns every group up.
        context.globalAlpha = Math.min(1, (0.65 + 0.35 * Math.sin(t * speed + phase)) * (1 + 0.45 * lift));
        context.drawImage(layers[k]!, 0, 0);
      }
    };

    resize();
    let frame = 0;
    const loop = (t: number): void => {
      draw(t);
      frame = window.requestAnimationFrame(loop);
    };
    if (still) draw(0);
    else frame = window.requestAnimationFrame(loop);
    const sun = window.setInterval(() => {
      readSun();
      build();
      if (still) draw(0);
    }, 60_000);
    const observer = new ResizeObserver(() => {
      resize();
      if (still) draw(0);
    });
    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(sun);
      observer.disconnect();
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerleave', onLeave);
    };
  }, [national]);

  return <canvas ref={canvas} className="landing-sky" aria-label="Map of every camera. Click the country to open the map." onClick={() => overRef.current && onClick()} />;
}

/** The agencies behind the pictures, with their 511 sites, what they publish and under what terms, and the disclaimer in full. */
function Sources({ national, disclaimer, onClose }: { national: NationalResponse; disclaimer: string; onClose: () => void }): ReactElement {
  const sources = Object.entries(national.sources).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return (
    <section className="landing-sources" aria-label="Sources and terms">
      <header>
        <h2>Sources and terms</h2>
        <button type="button" className="landing-link" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="landing-note">
        Only agencies whose published terms let a viewer like this show their cameras. <span className="kind-chip is-video">Live</span> means some cameras stream video; <span className="kind-chip is-snapshot">Snapshot</span> means a still picture the agency refreshes on its own clock.
      </p>
      <div className="landing-table-wrap">
        <table className="landing-table">
          <thead>
            <tr>
              <th>Agency and 511 site</th>
              <th>States</th>
              <th className="is-number">Cameras</th>
              <th>Kind</th>
              <th>New picture</th>
              <th>Terms</th>
            </tr>
          </thead>
          <tbody>
            {sources.map(([key, source]) => (
              <tr key={key}>
                <td>
                  <a href={source.site_url} target="_blank" rel="noopener">
                    {source.name}
                  </a>
                  <span className="landing-site">{host(source.site_url)}</span>
                </td>
                <td>{source.states.join(', ')}</td>
                <td className="is-number">{source.cameras.ids.length.toLocaleString()}</td>
                <td>{source.has_video ? <span className="kind-chip is-video">Live and snapshot</span> : <span className="kind-chip is-snapshot">Snapshot</span>}</td>
                <td>{refresh(source)}</td>
                <td>
                  {source.license && <span className="landing-license">{source.license}</span>}
                  {source.terms_url && (
                    <a href={source.terms_url} target="_blank" rel="noopener">
                      terms
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="landing-note landing-disclaimer">{disclaimer}</p>
    </section>
  );
}

/** How often a new picture arrives, as the wall actually fetches it: the panel's faster rate first where the agency refreshes faster than the wall polls. */
function refresh(source: NationalSource): string {
  const poll = source.poll_period_s;
  if (poll === undefined) return '';
  const focus = source.focus_period_s ?? null;
  return focus !== null ? `every ${period(focus)} when open, ${period(poll)} on the wall` : `every ${period(poll)}`;
}

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
