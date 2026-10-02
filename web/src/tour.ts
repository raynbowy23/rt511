import type { Camera } from './api';
import type { Topology } from './graph';

const MIN_DWELL_S = 4.5;
const MAX_DWELL_S = 11;
// Free-flow travel time between freeway cameras is far too slow to watch, so it is divided down while keeping the relative pacing.
const PACE_DIVISOR = 11;

/** Auto-tours the graph downstream along a corridor, promoting each successive camera into the hero slot. */
export class Tour {
  private timer: number | null = null;
  private currentId: number | null = null;
  private seedIndex = 0;

  constructor(
    private readonly topo: Topology,
    private readonly promote: (camera: Camera) => void,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  toggle(fromCameraId?: number): void {
    if (this.running) this.stop();
    else this.start(fromCameraId);
  }

  start(fromCameraId?: number): void {
    this.stop();
    const seed = fromCameraId !== undefined ? this.topo.cameras.get(fromCameraId) ?? null : this.nextSeed();
    if (!seed) return;
    this.currentId = seed.id;
    this.promote(seed);
    this.schedule(MIN_DWELL_S);
  }

  stop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Keeps the tour in step when the hero is moved by hand, so resuming continues from where the viewer left off. */
  follow(cameraId: number): void {
    this.currentId = cameraId;
  }

  private nextSeed(): Camera | null {
    const starts = this.topo.freewayStarts();
    if (starts.length === 0) return null;
    const site = starts[this.seedIndex % starts.length];
    this.seedIndex++;
    return site ? this.topo.cameraAt(site.id) : null;
  }

  private schedule(seconds: number): void {
    this.timer = window.setTimeout(() => this.advance(), seconds * 1000);
  }

  private advance(): void {
    if (this.currentId === null) {
      this.start();
      return;
    }
    const next = this.topo.hop(this.currentId, 'down');
    if (!next) {
      // End of the corridor: pick up the next one rather than stopping, so the wall keeps moving unattended.
      this.currentId = null;
      this.start();
      return;
    }
    this.currentId = next.camera.id;
    this.promote(next.camera);
    const dwell = Math.max(MIN_DWELL_S, Math.min(MAX_DWELL_S, next.edge.tt_s / PACE_DIVISOR));
    this.schedule(dwell);
  }
}
