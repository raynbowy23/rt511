import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import type { AttentionFlow } from '../flows';
import { getPulse, getSky, type CameraState, type Graph, type Incident, type NationalResponse } from '../api';
import { MapView } from '../map';
import { Minimap } from '../minimap';
import { NationalView } from '../national';

/** The canvas views stay imperative. React owns where they live and when they are told things; the drawing stays where it was, because putting thousands of paths through the virtual DOM would be strictly worse.
 *
 * Each wrapper builds its view once per mount and destroys it on cleanup, which is what makes React's double-invoked development effects harmless. */

export function NationalPane({
  data,
  visible,
  states,
  onRegion,
}: {
  data: NationalResponse;
  visible: boolean;
  states: CameraState[];
  onRegion: (key: string) => void;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<NationalView | null>(null);
  const onRegionRef = useRef(onRegion);
  onRegionRef.current = onRegion;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const instance = new NationalView(data, (key) => onRegionRef.current(key));
    element.appendChild(instance.root);
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
  }, [data]);

  // A canvas sized while its container was hidden comes back as zero by zero, so it is measured again the moment the level shows it.
  useEffect(() => {
    if (visible) view.current?.resize();
  }, [visible]);

  useEffect(() => {
    view.current?.setStates(states);
  }, [states]);

  // The sunset wave moves on the scale of minutes, so a minute between reads is plenty, and nothing is read while the map is hidden.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const run = async (): Promise<void> => {
      const [sky, pulse] = await Promise.all([getSky(), getPulse()]);
      if (!cancelled && sky) view.current?.setSky(sky.regions);
      if (!cancelled && pulse) view.current?.setPulse(pulse.regions);
    };
    void run();
    const timer = window.setInterval(() => void run(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visible, data]);

  return <div className="pane pane-national" ref={host} hidden={!visible} />;
}

export function RegionMapPane({
  graph,
  visible,
  region,
  states,
  activeSite,
  incidents,
  activeIncident,
  flows = [],
  onCamera,
  onIncident,
  children,
}: {
  graph: Graph;
  visible: boolean;
  region: string | null;
  states: Map<number, CameraState>;
  /** Attention spreading along the roads right now, drawn as pulses. */
  flows?: AttentionFlow[];
  activeSite: string | null;
  incidents: Incident[];
  activeIncident: string | null;
  onCamera: (cameraId: number) => void;
  onIncident: (id: string) => void;
  /** Chrome drawn over the canvas, such as the city strip. It belongs to React, not to the drawing. */
  children?: ReactNode;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<MapView | null>(null);
  const onCameraRef = useRef(onCamera);
  onCameraRef.current = onCamera;
  const onIncidentRef = useRef(onIncident);
  onIncidentRef.current = onIncident;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const instance = new MapView(
      graph,
      (_siteId, cameraId) => onCameraRef.current(cameraId),
      (id) => onIncidentRef.current(id),
    );
    element.appendChild(instance.root);
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
  }, [graph]);

  useEffect(() => {
    if (region) void view.current?.show(region);
  }, [region]);

  useEffect(() => {
    if (visible) view.current?.resize();
  }, [visible, region]);

  useEffect(() => {
    view.current?.setStates(states);
  }, [states]);

  useEffect(() => {
    view.current?.setActive(activeSite);
  }, [activeSite]);

  useEffect(() => {
    view.current?.setIncidents(incidents);
  }, [incidents]);

  useEffect(() => {
    view.current?.setFlows(flows);
  }, [flows]);

  useEffect(() => {
    view.current?.setActiveIncident(activeIncident);
  }, [activeIncident]);

  return (
    <div className="pane pane-map" hidden={!visible}>
      <div className="map-mount" ref={host} />
      {children}
    </div>
  );
}

export function MinimapPane({
  graph,
  visible,
  region,
  activeSite,
  compact = false,
  onOpen,
}: {
  graph: Graph;
  visible: boolean;
  region: string | null;
  activeSite: string | null;
  /** Folded down to its label, for while a camera is open and the panel needs the corner. It unfolds on hover. */
  compact?: boolean;
  /** Opens the full city map. The minimap is a thumbnail of it, so clicking the thumbnail is the obvious way there. */
  onOpen?: () => void;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<Minimap | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const instance = new Minimap(graph);
    element.appendChild(instance.root);
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
  }, [graph]);

  useEffect(() => {
    view.current?.showRegion(region);
  }, [region]);

  useEffect(() => {
    view.current?.setActive(activeSite);
  }, [activeSite]);

  // The drawn minimap is a fixed-position child of this host, so clicks on it bubble here and the cursor inherits from here. That keeps the whole affordance on the host, with no stylesheet change, and a keyboard user reaches it as a button.
  const open = onOpen
    ? {
        role: 'button' as const,
        tabIndex: 0,
        title: 'Open the map',
        'aria-label': 'Open the map',
        style: { cursor: 'pointer' },
        onClick: onOpen,
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onOpen();
        },
      }
    : {};
  return <div className={`minimap-host${compact ? ' is-compact' : ''}`} ref={host} hidden={!visible} {...open} />;
}
