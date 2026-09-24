import type { ReactElement } from 'react';
import type { NationalResponse, NationalSource } from '@rt511/shared';

/** The front page: what rt511 is, the two kinds of live picture, where the pictures come from, and the disclaimer, with the map one click away. It is its own page rather than the country map with words on top, so the map stays a map. */
export function Landing({
  national,
  disclaimer,
  onMap,
  onCity,
  onBoard,
  onRelay,
}: {
  national: NationalResponse;
  disclaimer: string;
  onMap: () => void;
  onCity: (key: string) => void;
  onBoard: () => void;
  onRelay: () => void;
}): ReactElement {
  const sources = Object.entries(national.sources).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const cameras = sources.reduce((sum, [, source]) => sum + source.cameras.ids.length, 0);
  const served = national.regions.filter((region) => region.served);
  const videoSources = sources.filter(([, source]) => source.has_video).map(([, source]) => shortName(source));

  return (
    <main className="landing">
      <section className="landing-hero">
        <p className="landing-eyebrow">
          Live traffic cameras · {national.covered_states.length} states · {cameras.toLocaleString()} cameras
        </p>
        <h1 className="landing-title">Thousands of traffic cameras. One wall that knows where to look.</h1>
        <p className="landing-lede">
          rt511 reads the public cameras that state transportation agencies publish, notices which ones are actually moving, and puts those first. Rush hour on I-70, an empty interstate at 3 AM, the sunset sliding west from Maine to Oregon. Pull up a chair.
        </p>
        <div className="landing-actions">
          <button type="button" className="landing-cta" onClick={onMap}>
            Open the map
          </button>
          <button type="button" className="landing-secondary" onClick={onRelay}>
            Follow the sunset
          </button>
          <button type="button" className="landing-secondary" onClick={onBoard}>
            Busiest cameras right now
          </button>
        </div>
        {served.length > 0 && (
          <div className="landing-cities">
            <span className="landing-cities-label">Jump into a city</span>
            {served.map((region) => (
              <button key={region.key} type="button" className="landing-city" onClick={() => onCity(region.key)}>
                {region.name}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="landing-section">
        <h2 className="landing-heading">Things to do</h2>
        <div className="landing-features">
          <Feature title="The wall">Every camera in a city on one screen, busiest first. When something happens on a road, its tile grows.</Feature>
          <Feature title="Road trip">Pick a numbered route and ride it camera by camera, turning around at the end of the road.</Feature>
          <Feature title="Sun relay">Chase the sunset from city to city as it rolls west, or the sunrise as it rolls back.</Feature>
          <Feature title="City pulse">A little line under each city on the map: how much it moved, minute by minute, since midnight.</Feature>
          <Feature title="Night shift">After dark, a vehicle count on the camera you are watching. “3:12 AM · 2 cars.” Needs the optional detector.</Feature>
          <Feature title="Diary">What the wall noticed today, written down: highlights, sunsets, murky skies, the first snow. Words only.</Feature>
        </div>
      </section>

      <section className="landing-section">
        <h2 className="landing-heading">Two kinds of live</h2>
        <div className="landing-kinds">
          <div className="landing-kind">
            <span className="kind-chip is-video">Live video</span>
            <p>A real stream, straight from the agency, playing in the camera panel. {videoSources.length > 0 ? `${list(videoSources)} publish${videoSources.length === 1 ? 'es' : ''} video on many of ${videoSources.length === 1 ? 'its' : 'their'} cameras.` : ''} On the wall these tiles carry a small Video tag.</p>
          </div>
          <div className="landing-kind">
            <span className="kind-chip is-snapshot">Live snapshot</span>
            <p>A still picture the agency refreshes on its own clock, from every 5 seconds in Ohio to every 5 minutes in California. The panel fades from one picture to the next and says how often a new one lands, as in “Live snapshot (1 min)”.</p>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <h2 className="landing-heading">Where the pictures come from</h2>
        <p className="landing-note">Only agencies whose published terms let a viewer like this show their cameras. Each one is credited on every camera, and each links back to its own 511 site.</p>
        <div className="landing-table-wrap">
          <table className="landing-table">
            <thead>
              <tr>
                <th>Agency and site</th>
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
                  <td>{source.has_video ? <span className="kind-chip is-video">Video and snapshots</span> : <span className="kind-chip is-snapshot">Snapshots</span>}</td>
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
      </section>

      <section className="landing-section landing-fine">
        <h2 className="landing-heading">The fine print</h2>
        <p>{disclaimer}</p>
      </section>
    </main>
  );
}

function Feature({ title, children }: { title: string; children: string }): ReactElement {
  return (
    <div className="landing-feature">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/** How often a new picture arrives, as the wall actually fetches it: the panel's faster rate first where the agency refreshes faster than the wall polls. */
function refresh(source: NationalSource): string {
  const poll = source.poll_period_s;
  if (poll === undefined) return '';
  const focus = source.focus_period_s ?? null;
  return focus !== null ? `every ${seconds(focus)} when open, ${seconds(poll)} on the wall` : `every ${seconds(poll)}`;
}

function seconds(value: number): string {
  return value < 60 ? `${String(Math.round(value))} s` : `${String(Math.round(value / 60))} min`;
}

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The agency as a reader would say it in a sentence, which is the state it serves when it serves one. */
function shortName(source: NationalSource): string {
  const names: Record<string, string> = { CA: 'California', IA: 'Iowa', KY: 'Kentucky', OH: 'Ohio', OR: 'Oregon' };
  return source.states.length === 1 ? (names[source.states[0] ?? ''] ?? source.name) : source.name;
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}
