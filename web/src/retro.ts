/** The control-room palette for everything drawn on a canvas, kept beside the CSS tokens of the same names so a map and the page around it glow the same amber.
 *
 * One phosphor, in a few intensities, on near-black. Red is kept for two things only, a live stream and an incident, as it is in the stylesheet. */

export type Rgb = readonly [number, number, number];

export const PHOSPHOR = {
  hot: [255, 214, 140],
  bright: [255, 180, 60],
  mid: [230, 140, 30],
  dim: [150, 88, 22],
  deep: [58, 34, 10],
  ink: [10, 7, 3],
  red: [255, 84, 60],
} as const satisfies Record<string, Rgb>;

export function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha.toFixed(3)})`;
}

/** The same monospace stack as the stylesheet's `--font`, for text drawn on a canvas. */
export const MONO = '"IBM Plex Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
