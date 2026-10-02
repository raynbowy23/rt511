import { useEffect, useRef, type ReactElement } from 'react';
import type { RegionMeta } from '../api';

/** Road data is served under the Open Database License and the line is fixed by that license; the map frame shows the same string, which `/api/roads` returns with the geometry. */
const ROADS_CREDIT = 'Road data © OpenStreetMap contributors (ODbL)';

export interface CameraCredit {
  attribution: string;
  /** The terms the agency publishes its cameras under, and where they are written down. */
  license: string;
  terms_url: string;
  /** Text the agency requires to be repeated wherever its cameras are credited. */
  notice: string;
}

export interface Credits {
  /** One entry per agency whose cameras are being served. */
  cameras: CameraCredit[];
  /** Published traffic counts joined to the cities being served, with where their license is written down. */
  counts: { attribution: string; terms_url: string }[];
  /** Natural Earth, for the state outlines on the country map. */
  states: string;
  services: { name: string; site_url: string }[];
}

/** One quiet line at the end of the page.
 *
 * The credits are an obligation rather than decoration, so they are all reachable, behind a control that is closed until someone wants them. */
export function Footer({ context, credits, source, disclaimer }: { context: string; credits: Credits; source: RegionMeta | undefined; disclaimer: string }): ReactElement {
  const total = credits.cameras.length + credits.counts.length + (credits.states ? 1 : 0) + 1;
  const root = useRef<HTMLElement>(null);
  // The disclaimer wraps to a different height at every width and the credits open upwards, so the footer publishes its height for what is pinned above it.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const publish = (): void => document.documentElement.style.setProperty('--footer-h', `${String(Math.ceil(element.getBoundingClientRect().height))}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <footer className="footer" ref={root}>
      <div className="footer-line">
        <span className="footer-context">{context}</span>
        {source?.site_url && source.source_name && (
          <a className="source-link" href={source.site_url} target="_blank" rel="noopener">Traffic information from {source.source_name}</a>
        )}
        <details className="footer-credits">
          <summary>Credits ({total})</summary>
          <div className="footer-credit-list">
            {credits.cameras.map((credit) => (
              <span key={credit.attribution}>
                {credit.attribution}
                {credit.license && ` · ${credit.license}`}
                {credit.terms_url && (
                  <>
                    {' · '}
                    <a className="source-link" href={credit.terms_url} target="_blank" rel="noopener">terms</a>
                  </>
                )}
                {credit.notice && <span className="footer-notice">{credit.notice}</span>}
              </span>
            ))}
            {credits.counts.map((credit) => (
              <span key={credit.attribution}>
                {credit.attribution}
                {credit.terms_url && (
                  <>
                    {' · '}
                    <a className="source-link" href={credit.terms_url} target="_blank" rel="noopener">terms</a>
                  </>
                )}
              </span>
            ))}
            <span>{ROADS_CREDIT}</span>
            {credits.states && <span>{credits.states}</span>}
            {credits.services.length > 0 && (
              <section className="footer-services" aria-label="Official 511 services">
                <span>Official live traffic information</span>
                <div className="footer-state-links">
                  {credits.services.map((service) => (
                    <a className="source-link" key={service.name} href={service.site_url} target="_blank" rel="noopener">{service.name}</a>
                  ))}
                </div>
              </section>
            )}
          </div>
        </details>
        <span className="footer-note">
          <a className="source-link" href="https://github.com/raynbowy23/rt511" target="_blank" rel="noopener">github.com/raynbowy23/rt511</a>
        </span>
      </div>
      {/* Always on screen, never folded into the credits: it is the condition every camera on the page is shown under. */}
      <p className="footer-disclaimer">{disclaimer}</p>
    </footer>
  );
}
