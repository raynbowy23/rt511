import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

export interface City {
  key: string;
  name: string;
  /** [lat, lon] from the national index, which is what makes "nearest" a computation rather than a guess. */
  center: [number, number] | null;
  served: boolean;
}

/** How many cities fit as tabs at a given pane width. The rest live in the menu, which holds all of them. */
function slotsFor(width: number): number {
  if (width < 640) return 2;
  if (width < 860) return 3;
  if (width < 1100) return 4;
  return 5;
}

function distanceKm(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = p2 - p1;
  const dl = toRad(lon2 - lon1);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

/** The city strip over the map: the city you are in, then its nearest neighbors, then a menu holding every city.
 *
 * Nearest rather than alphabetical because the cities you are most likely to want next are the ones near the one you are looking at. */
export function CitySwitcher({
  cities,
  current,
  onSelect,
}: {
  cities: City[];
  current: string | null;
  onSelect: (key: string) => void;
}): ReactElement | null {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const [slots, setSlots] = useState(5);

  useEffect(() => {
    const element = root.current?.parentElement;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setSlots(slotsFor(width));
      });
    });
    observer.observe(element);
    setSlots(slotsFor(element.getBoundingClientRect().width));
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  // Close the menu when the pointer goes elsewhere.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const element = menu.current;
      if (!element?.open) return;
      if (!element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const { tabs, all } = useMemo(() => {
    const here = cities.find((city) => city.key === current) ?? cities[0];
    const center = here?.center ?? null;
    const others = cities.filter((city) => city.key !== here?.key);
    const ranked =
      center === null
        ? others
        : [...others].sort((a, b) => {
            // A city with no center sorts last rather than pretending to be at the equator.
            const da = a.center ? distanceKm(center, a.center) : Number.POSITIVE_INFINITY;
            const db = b.center ? distanceKm(center, b.center) : Number.POSITIVE_INFINITY;
            return da - db;
          });
    const withDistance = [...cities]
      .map((city) => ({ city, km: center && city.center && city.key !== here?.key ? distanceKm(center, city.center) : null }))
      .sort((a, b) => a.city.name.localeCompare(b.city.name));
    return { tabs: here ? [here, ...ranked].slice(0, Math.max(1, slots)) : [], all: withDistance };
  }, [cities, current, slots]);

  if (cities.length < 2) return null;

  const choose = (key: string): void => {
    if (menu.current) menu.current.open = false;
    onSelect(key);
  };

  return (
    <div className="map-switcher" ref={root}>
      {tabs.map((city) => (
        <button
          key={city.key}
          type="button"
          className={`map-region${city.key === current ? ' is-on' : ''}`}
          data-region={city.key}
          onClick={() => choose(city.key)}
        >
          {city.name}
        </button>
      ))}
      <details
        className="city-menu"
        ref={menu}
        onKeyDown={(event) => {
          // The application listens for Escape and the arrow keys on the window; while this menu is open they belong to it.
          if (event.key === 'Escape' && menu.current?.open) {
            menu.current.open = false;
            menu.current.querySelector('summary')?.focus();
            event.stopPropagation();
            event.preventDefault();
          } else if (event.key.startsWith('Arrow')) {
            event.stopPropagation();
          }
        }}
      >
        <summary className="map-region city-menu-summary" aria-label={`All ${cities.length} cities`}>
          All {cities.length} cities
        </summary>
        <div className="city-menu-list" role="listbox" aria-label="Cities">
          {all.map(({ city, km }) => (
            <button
              key={city.key}
              type="button"
              role="option"
              aria-selected={city.key === current}
              className={`city-menu-item${city.key === current ? ' is-on' : ''}`}
              onClick={() => choose(city.key)}
            >
              <span className="city-menu-name">{city.name}</span>
              <span className="city-menu-note">{city.key === current ? 'showing' : km === null ? '' : `${Math.round(km)} km`}</span>
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}
