import { incidentFloor } from './attention.js';
import { promotionTrigger } from './corridor.js';
import { ago, JEV, picture } from './jev.js';
/** Five events give an ambient wall a short ribbon that can be read without competing with its pictures. */
export const HIGHLIGHTS_SIZE = 5;
/** An event below this attention is not a highlight. The first live run ranked a three-hour-old record at 0.015 into the ribbon because nothing else was happening, which is exactly when the ribbon should stay empty. A road-relevant record's floor falls to this level about forty minutes after its report, and a closure's about fifty, so the ribbon holds events from roughly the last hour. */
export const HIGHLIGHT_MIN_ATTENTION = 0.25;
/** A queue is mentioned only through an upstream camera whose queue floor reaches this. The formula always admits some floor once the wave could have arrived, and on a decayed record that let a brief claim a queue 4.9 km back behind a score of 0.015. The sentence must not claim more than the number supports. */
export const QUEUE_MENTION_MIN = 0.1;
const DIRECTIONS = { NB: 'northbound', SB: 'southbound', EB: 'eastbound', WB: 'westbound' };
/** Dispatch feeds and camera catalogues write in capitals and shorthand. Route designators and ordinals are kept recognisable, direction codes are spelled out, and everything else becomes ordinary capitalisation, so "I-95 NB x[US-1/DOWNTOWN]" reads as "I-95 northbound at US-1 / Downtown". */
const SMALL_WORDS = new Set(['at', 'and', 'of', 'the', 'to', 'on', 'in', 'near', 'by', 'from']);
function word(raw) {
    // Brackets and trailing commas are kept around the word rather than letting them hide it, so "(SR-874 NB)" still reads "(SR-874 northbound)".
    const [, open, token, close] = /^([([]*)(.*?)([)\],]*)$/.exec(raw) ?? ['', '', raw, ''];
    return `${open}${core(token)}${close}`;
}
function core(token) {
    if (DIRECTIONS[token.toUpperCase()])
        return DIRECTIONS[token.toUpperCase()];
    if (SMALL_WORDS.has(token.toLowerCase()))
        return token.toLowerCase();
    if (/^\d+(ST|ND|RD|TH)$/i.test(token))
        return token.toLowerCase();
    if (/\d/.test(token) || /^(US|SR|CR|I|NW|NE|SW|SE)$/i.test(token))
        return token.toUpperCase();
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}
/** Only text that arrives in capitals is rewritten. A name that already reads naturally, such as "I-4 at Ivanhoe Blvd", is left as its owner wrote it apart from spacing around slashes. */
function tidy(value) {
    const spaced = value.replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').trim();
    if (/[a-z]/.test(spaced))
        return spaced;
    return spaced.split(' ').map((token) => (token === '/' ? token : word(token))).join(' ');
}
/** "ROAD DIR x[CROSS]" is the Florida dispatch shape. Anything else is tidied as it stands rather than guessed at. */
export function placeName(raw) {
    const match = /^(.+?)\s+(NB|SB|EB|WB)?\s*x\[(.+)\]\s*$/i.exec(raw.trim());
    if (!match)
        return tidy(raw);
    const [, road, dir, cross] = match;
    return `${tidy(road)}${dir ? ` ${DIRECTIONS[dir.toUpperCase()]}` : ''} at ${tidy(cross)}`;
}
/** Camera names often lead with the agency's own device number, which means nothing to a reader. */
export function cameraName(raw) {
    return tidy(raw.replace(/^\d+\s+/, ''));
}
/** Dispatch labels arrive in capitals. "VEHICLE CRASH W/INJURIES" becomes "Vehicle crash with injuries". */
export function labelText(raw) {
    if (/[a-z]/.test(raw))
        return raw.trim();
    const lower = raw.replace(/\bW\//gi, 'with ').toLowerCase().replace(/\s+/g, ' ').trim();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}
/** Feed labels are plain text, but their punctuation must not turn a short brief into a dispatch-style list. */
function plain(value) {
    return value.replace(/[:;—]/g, ',').replace(/\s+/g, ' ').replace(/[,. ]+$/, '').trim();
}
/** Picture descriptions share the exact thresholds used in Jev's evidence, without treating motion in pixels as a measured road speed. */
export function composeBrief(event, now) {
    const { state, camera, incident, verdict } = event;
    const view = picture({ diff: state.diff, baseline: state.axes?.baseline ?? null });
    const where = plain(cameraName(camera.location || camera.roadway));
    if (event.kind === 'stopped')
        return `Traffic stopped near ${where}, where this hour usually moves. Confirmed from the picture ${ago(Math.max(0, now - event.at))}.`;
    if (event.kind === 'movement') {
        const ratio = view.times_usual;
        return `Unusual movement near ${where}. ${ratio === null ? `The picture is ${view.summary}` : `The picture shows about ${ratio.toFixed(1)} times its usual movement for this hour`}.`;
    }
    const report = incident;
    const age = report.reported_at === null ? '' : `, reported ${ago(Math.max(0, now - report.reported_at))}`;
    const answers = [];
    if (verdict && verdict.cleared >= JEV.NOUL_THRESHOLD)
        answers.push('Likely already cleared');
    if (verdict && verdict.supported >= JEV.NOUL_THRESHOLD)
        answers.push('Cameras support the report');
    const observation = state.diff === null ? 'No camera picture yet' : `The camera picture is ${view.summary}`;
    const evidence = answers.length ? `${answers.join(' and ')} and ${observation.charAt(0).toLowerCase()}${observation.slice(1)}` : observation;
    const queue = event.queue ? ` A queue could now reach ${plain(cameraName(event.queue.location))}, ${(event.queue.length_m / 1000).toFixed(1)} km back.` : '';
    return `${plain(labelText(report.label || report.type))} on ${plain(placeName(report.location))}${age}. ${evidence}.${queue}`;
}
/** All inputs are cached facts. Checking each record's deterministic floor keeps overlapping dispatch records separate even when only one wins a camera's axes. */
export function selectHighlights(states, catalog, incidents, verdicts, gateTimes, now, region = null, corridor = new Map()) {
    const eligible = states.filter((state) => state.polls > 0 && state.attention !== null && state.axes !== null && catalog.has(state.id) && (region === null || catalog.get(state.id).region === region));
    const events = [];
    for (const report of new Map(incidents.map((record) => [record.id, record])).values()) {
        const named = eligible.filter((state) => report.cameras.includes(state.id));
        if (!named.some((state) => state.axes.incident_floor > 0 && incidentFloor({ uid: state.id, ...catalog.get(state.id), now }, [report]).value > 0))
            continue;
        const best = named.sort((a, b) => b.attention - a.attention || a.id - b.id)[0];
        const upstream = states.filter((state) => state.axes?.queue?.source === 'incident' && state.axes.queue.incident === `${report.type} at ${report.location}` && state.axes.queue_floor >= QUEUE_MENTION_MIN && catalog.has(state.id) && corridor.get(state.axes.queue.anchor)?.some((neighbour) => neighbour.uid === state.id && neighbour.side === 'upstream')).sort((a, b) => b.axes.queue.length_m - a.axes.queue.length_m)[0];
        const verdict = verdicts.get(report.id);
        events.push({ kind: 'incident', state: best, camera: catalog.get(best.id), at: report.reported_at ?? best.last_ts ?? now, incident: report, ...(verdict ? { verdict } : {}), ...(upstream ? { queue: { location: catalog.get(upstream.id).location, length_m: upstream.axes.queue.length_m } } : {}) });
    }
    for (const state of eligible) {
        const camera = catalog.get(state.id);
        if ((state.axes.gate?.floor ?? 0) > 0) {
            const at = gateTimes.get(state.id);
            if (at !== undefined)
                events.push({ kind: 'stopped', state, camera, at });
        }
        else if (state.axes.incident_floor === 0 && promotionTrigger(state)?.reason === 'movement' && state.last_ts !== null) {
            events.push({ kind: 'movement', state, camera, at: state.last_ts });
        }
    }
    return events.filter((event) => event.state.attention >= HIGHLIGHT_MIN_ATTENTION).sort((a, b) => b.state.attention - a.state.attention || a.state.id - b.state.id).slice(0, HIGHLIGHTS_SIZE).map((event) => ({ kind: event.kind, brief: composeBrief(event, now), camera: event.state.id, region: event.camera.region, attention: event.state.attention, at: event.at }));
}
//# sourceMappingURL=highlights.js.map