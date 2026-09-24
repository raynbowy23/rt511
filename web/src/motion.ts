/** One place asks the media query, because several components need the same answer and the wall used to export it from an unrelated module. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
