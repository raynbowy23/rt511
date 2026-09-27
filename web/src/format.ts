/** Small wording helpers shared by the camera panel, the live line and the front page, kept in one place so the three say a period the same way. */

/** A refresh period as a person would say it: seconds under a minute, whole minutes from there. "5 s", "1 min", "5 min". */
export function period(seconds: number): string {
  return seconds < 60 ? `${String(Math.round(seconds))} s` : `${String(Math.round(seconds / 60))} min`;
}
