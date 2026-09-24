/** Draws one figure per process in the attention pipeline, as plain SVG.
 *
 * Generated rather than drawn so that a number in a figure and the number in `TUNING` or `JEV` cannot drift apart. Every quantity below is read from the built server rather than typed in again. Run `node scripts/figures.mjs` after changing either table and commit what changes.
 *
 * Output goes to docs/figures, one file per process, named in pipeline order. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'figures');
const { TUNING } = await import(join(ROOT, 'server/dist/server/src/attention.js'));
const { CORRIDOR } = await import(join(ROOT, 'server/dist/server/src/corridor.js'));
const { JEV } = await import(join(ROOT, 'server/dist/server/src/jev.js'));
const { MARGIN_S, DIFF_HISTORY, DEFAULT_RING } = await import(join(ROOT, 'server/dist/server/src/poller.js'));

/** A constant that stops being exported reads as `undefined` in a label and the figure still renders, which is exactly the drift these figures exist to prevent. */
for (const [name, value] of Object.entries({ MARGIN_S, DIFF_HISTORY, DEFAULT_RING })) {
  if (value === undefined) throw new Error(`${name} is not exported from the built poller`);
}
for (const [table, values] of [['TUNING', TUNING], ['JEV', JEV], ['CORRIDOR', CORRIDOR]]) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) throw new Error(`${table}.${name} is undefined`);
  }
}

const W = 900;
const INK = '#1d2530';
const MUTED = '#5d6b7d';
const LINE = '#96a4b5';
const FILL = '#f4f7fa';
const ACCENT = '#1f6feb';
const WARM = '#b4541a';
const PAPER = '#ffffff';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A rounded box with a bold title and any number of quieter lines under it. */
function box(x, y, w, h, title, lines = [], opts = {}) {
  const stroke = opts.stroke ?? LINE;
  const fill = opts.fill ?? FILL;
  const dash = opts.dash ? ' stroke-dasharray="5 4"' : '';
  const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="${stroke}"${dash}/>`];
  const cx = x + w / 2;
  let ty = y + (lines.length === 0 ? h / 2 + 5 : 25);
  parts.push(`<text x="${cx}" y="${ty}" text-anchor="middle" font-size="14" font-weight="600" fill="${opts.titleFill ?? INK}">${esc(title)}</text>`);
  for (const line of lines) {
    ty += 17;
    parts.push(`<text x="${cx}" y="${ty}" text-anchor="middle" font-size="12" fill="${MUTED}">${esc(line)}</text>`);
  }
  return parts.join('\n');
}

function diamond(cx, cy, w, h, title, opts = {}) {
  const pts = `${cx},${cy - h / 2} ${cx + w / 2},${cy} ${cx},${cy + h / 2} ${cx - w / 2},${cy}`;
  return [
    `<polygon points="${pts}" fill="${opts.fill ?? '#fff6ec'}" stroke="${opts.stroke ?? WARM}"/>`,
    `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="13" font-weight="600" fill="${INK}">${esc(title)}</text>`,
  ].join('\n');
}

function arrow(x1, y1, x2, y2, label, opts = {}) {
  const colour = opts.colour ?? LINE;
  const dash = opts.dash ? ' stroke-dasharray="5 4"' : '';
  const path = opts.path ?? `M ${x1} ${y1} L ${x2} ${y2}`;
  const marker = colour === WARM ? 'headWarm' : 'head';
  const parts = [`<path d="${path}" fill="none" stroke="${colour}" stroke-width="1.6" marker-end="url(#${marker})"${dash}/>`];
  if (label) {
    const lx = opts.lx ?? (x1 + x2) / 2;
    const ly = opts.ly ?? (y1 + y2) / 2 - 7;
    const anchor = opts.anchor ?? 'middle';
    parts.push(`<text x="${lx}" y="${ly}" text-anchor="${anchor}" font-size="11.5" fill="${opts.labelFill ?? MUTED}">${esc(label)}</text>`);
  }
  return parts.join('\n');
}

/** Wraps to a character count rather than to measured text, which is enough at one font size and keeps this file free of a metrics table. */
function wrap(line, width) {
  if (line.length <= width) return [line];
  const out = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current === '') current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

function note(x, y, lines, opts = {}) {
  const anchor = opts.anchor ?? 'start';
  const width = opts.width ?? 118;
  const wrapped = lines.flatMap((line) => (line === '' ? [''] : wrap(line, width)));
  return wrapped
    .map((line, i) => `<text x="${x}" y="${y + i * 16}" text-anchor="${anchor}" font-size="12" fill="${opts.fill ?? MUTED}">${esc(line)}</text>`)
    .join('\n');
}

function formula(x, y, text, opts = {}) {
  return `<text x="${x}" y="${y}" text-anchor="${opts.anchor ?? 'middle'}" font-size="${opts.size ?? 13.5}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" fill="${opts.fill ?? INK}">${esc(text)}</text>`;
}

function figure(name, caption, height, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">
<defs>
  <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${LINE}"/>
  </marker>
  <marker id="headWarm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${WARM}"/>
  </marker>
</defs>
<rect width="${W}" height="${height}" fill="${PAPER}"/>
<text x="28" y="34" font-size="15" font-weight="700" fill="${INK}">${esc(caption)}</text>
${body}
</svg>
`;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), svg);
  return name;
}

const made = [];
const add = (...args) => made.push(figure(...args));

/* 1. Ingest and polling. */
add(
  '01-polling.svg',
  'Process 1. Polling. One request per camera per period, scheduled off the picture that came back',
  330,
  [
    box(28, 70, 190, 80, '511 snapshot host', ['14 hosts, 17 states', 'one JPEG per camera']),
    arrow(218, 110, 300, 110, 'HTTP GET'),
    box(300, 70, 200, 80, 'Per-source client', ['If-Modified-Since', 'token handshake for HLS']),
    arrow(500, 110, 582, 110, 'fresh, 304, gone', { lx: 526, ly: 96 }),
    box(582, 70, 290, 80, 'Camera slot', [`newest frame plus ${DIFF_HISTORY} differences`, `${DEFAULT_RING} frames kept for replay`]),
    arrow(727, 150, 727, 196, ''),
    box(582, 196, 290, 76, 'Next poll time', [`Last-Modified + period + ${MARGIN_S} s margin`], { stroke: ACCENT }),
    arrow(582, 234, 400, 234, 'schedule', { path: 'M 582 234 L 420 234' }),
    box(180, 196, 240, 76, 'Three tiers', ['on screen, watched, idle'], { stroke: ACCENT }),
    arrow(180, 234, 118, 234, '', { path: 'M 180 234 L 130 234 L 130 150' }),
    note(28, 300, ['A fixed clock returns the same picture twice. The host regenerates a snapshot on demand, so the next request is timed off the Last-Modified the last one carried.']),
  ].join('\n'),
);

/* 2. Frame differencing. */
add(
  '02-difference.svg',
  'Process 2. Frame difference. The only number computed on every frame of every camera',
  300,
  [
    box(28, 70, 170, 74, 'Frame at t', ['full-size JPEG']),
    box(28, 160, 170, 74, 'Frame at t-1', ['the one before it']),
    arrow(198, 107, 268, 130, ''),
    arrow(198, 197, 268, 174, ''),
    box(268, 112, 200, 80, 'Downscale to 64 x 48', ['greyscale', 'one thumbnail per frame']),
    arrow(468, 152, 540, 152, ''),
    box(540, 112, 330, 80, 'Mean absolute difference', ['one scalar in 0..1']),
    formula(705, 232, 'diff = (1/WH) * SUM |I_t(x,y) - I_t-1(x,y)|'),
    note(28, 262, [`A camera returning its first frame has no difference at all. Identical bytes are not a difference of zero. They are recorded as unchanged and never folded into a baseline.`]),
  ].join('\n'),
);

/* 3. Baseline. */
add(
  '03-baseline.svg',
  'Process 3. Baseline. What this camera usually does at this hour, usable from the first poll',
  382,
  [
    box(28, 70, 250, 92, 'Hour-of-week cell', ['168 cells, day x hour', 'running mean and count N']),
    box(28, 186, 250, 84, 'Rolling median', [`median of the last ${DIFF_HISTORY} differences`, 'available immediately']),
    arrow(278, 116, 372, 150, 'weight N/(N+K)'),
    arrow(278, 228, 372, 194, 'weight K/(N+K)'),
    box(372, 130, 230, 84, 'Shrinkage blend', [`K = ${TUNING.SHRINKAGE_K}`], { stroke: ACCENT }),
    arrow(602, 172, 676, 172, ''),
    box(676, 130, 196, 84, 'Baseline mu', ['what anomaly divides by']),
    formula(450, 304, 'mu = (N/(N+K)) * cellMean + (K/(N+K)) * rollingMedian'),
    note(28, 340, ['At N = 0 the blend returns the rolling median exactly, so a cold process ranks cameras the way the older activity measure did. The hourly profile takes over as its own cell fills, with no warm-up period and no reindexing.']),
  ].join('\n'),
);

/* 4. Zero-motion gate. */
add(
  '04-gate.svg',
  'Process 4. Zero-motion gate. The one question the arithmetic cannot answer',
  380,
  [
    box(28, 74, 200, 76, 'This poll', ['frame difference', 'and the cell it fell in']),
    arrow(228, 112, 300, 112, ''),
    diamond(410, 112, 220, 84, 'diff <= floor ?'),
    arrow(520, 112, 592, 112, 'yes'),
    diamond(712, 112, 216, 84, 'hour moves ?'),
    arrow(410, 154, 410, 226, 'no', { lx: 420, anchor: 'start' }),
    arrow(712, 154, 712, 226, 'no', { lx: 722, anchor: 'start' }),
    box(300, 226, 220, 66, 'Ordinary poll', ['scored on its own terms']),
    box(602, 226, 220, 66, 'Ordinary poll', ['a quiet hour is allowed']),
    arrow(820, 112, 872, 112, 'yes', { path: 'M 820 112 L 872 112 L 872 322 L 520 322', lx: 845, ly: 104 }),
    box(190, 300, 330, 46, 'AMBIGUOUS_ZERO recorded, then asked about', [], { stroke: WARM, fill: '#fff6ec' }),
    note(28, 366, [`The cell must hold at least ${TUNING.AMBIGUOUS_MIN_SAMPLES} frames and average more than ${TUNING.AMBIGUOUS_EXPECT_DIFF} before it is allowed to expect anything, or the flag measures how new the profile is rather than anything about the road.`]),
  ].join('\n'),
);

/* 5. Incident floor. */
add(
  '05-floor.svg',
  'Process 5. Incident floor. A dispatch record as a lower bound rather than another weight',
  384,
  [
    box(28, 70, 200, 88, 'Dispatch record', ['agency code', 'location and time']),
    arrow(228, 114, 296, 114, ''),
    box(296, 70, 174, 88, 'Code level', [`closure ${TUNING.FLOOR_CLOSURE}`, `road-relevant ${TUNING.FLOOR_ROAD_RELEVANT}`, `otherwise ${TUNING.FLOOR_OTHER}`]),
    arrow(470, 114, 528, 114, 'x'),
    box(528, 70, 156, 88, 'Distance taper', [`1 within ${TUNING.INCIDENT_NEAR_KM} km`, `${TUNING.INCIDENT_FAR_FACTOR} at the edge`]),
    arrow(684, 114, 742, 114, 'x'),
    box(742, 70, 130, 88, 'Age decay', [`half-life`, `${TUNING.INCIDENT_HALF_LIFE_S / 60} min`]),
    formula(450, 202, 'Floor = level(code) * taper(distance) * 0.5 ^ (age / halfLife)'),
    arrow(450, 216, 450, 252, ''),
    box(240, 252, 420, 50, 'The floor under every camera the record names', [], { stroke: ACCENT }),
    note(28, 340, ['Without the decay term an open record pins a camera to the wall for as long as the dispatcher leaves it open. One Florida record in the sample had been open for 171 days.']),
  ].join('\n'),
);

/* 6. Attention combination. */
add(
  '06-attention.svg',
  'Process 6. Combination. Two visual axes amplified by road scale, held up by a floor',
  440,
  [
    box(28, 70, 214, 78, 'Anomaly A', ['difference over baseline', `${TUNING.ANOMALY_AT_BASELINE} at the baseline`]),
    box(28, 164, 214, 78, 'Spectacle S', ['movement term only', `alpha = ${TUNING.ALPHA_ABSOLUTE} until counts exist`]),
    arrow(242, 109, 316, 140, `w = ${TUNING.WEIGHT_ANOMALY}`),
    arrow(242, 203, 316, 172, `w = ${TUNING.WEIGHT_SPECTACLE}`),
    box(316, 122, 176, 68, 'Weighted sum', []),
    arrow(492, 156, 556, 156, 'x'),
    box(556, 122, 180, 68, 'Scale amplifier', [`${TUNING.SCALE_AMPLIFIER_MIN} to ${TUNING.SCALE_AMPLIFIER_MAX}`], { stroke: ACCENT }),
    box(28, 244, 214, 62, 'Incident floor', ['from process 5'], { stroke: WARM }),
    box(28, 318, 214, 62, 'Gate floor', ['from process 8'], { stroke: WARM }),
    box(316, 318, 240, 62, 'Queue floor', [`anchor floor x ${TUNING.UPSTREAM_SHARE} x falloff x reach`], { stroke: WARM }),
    arrow(556, 349, 700, 290, '', { path: 'M 556 349 L 650 349 L 650 290 L 700 290' }),
    arrow(736, 156, 800, 156, '', { path: 'M 736 156 L 790 156 L 790 250 L 700 250' }),
    arrow(242, 275, 700, 275, '', { path: 'M 242 275 L 560 275 L 560 262 L 700 262' }),
    arrow(242, 349, 700, 349, '', { path: 'M 242 349 L 600 349 L 600 278 L 700 278' }),
    box(700, 228, 172, 72, 'max, then clamp', ['result in 0..1'], { stroke: ACCENT }),
    formula(450, 416, 'Attn = clamp( max( P * (wa*A + ws*S), Floor, QueueFloor, GateFloor ), 0, 1 )'),
  ].join('\n'),
);

/* 7. Incident arbitration. */
add(
  '07-arbiter.svg',
  'Process 7. Incident arbitration. Four typed questions, asked once per record',
  420,
  [
    box(28, 70, 210, 96, 'One dispatch record', ['its cameras and their pictures', 'the corridor around them']),
    arrow(238, 118, 316, 118, 'state, as text'),
    box(316, 70, 190, 96, 'Jev, one call', [`at most ${JEV.MAX_CALLS_PER_MINUTE} a minute`, `${JEV.MAX_IN_FLIGHT} in flight`], { stroke: ACCENT }),
    arrow(506, 118, 584, 118, 'four answers'),
    box(584, 60, 288, 46, 'supported (noul)', []),
    box(584, 114, 288, 46, 'cleared (noul)', []),
    box(584, 168, 288, 46, 'screen (score, 0 to 3)', []),
    box(584, 222, 288, 46, 'camera (choice)', []),
    arrow(728, 268, 728, 306, ''),
    box(528, 306, 344, 62, 'Multiplier on the floor', ['an answer below its gate does nothing'], { stroke: WARM }),
    note(28, 210, [
      `Gates: a noul must reach ${JEV.NOUL_THRESHOLD},`,
      `a score or choice must reach ${JEV.ACT_CONFIDENCE} confidence.`,
      '',
      'Only "cleared" may take a floor away, and it',
      `leaves ${JEV.CLEARED_RESIDUE} of it rather than nothing.`,
      '',
      `A record is re-read every ${JEV.REASK_AFTER_S} s, but only`,
      'once one of its cameras has a new frame,',
      'and at once if the dispatcher edits it.',
    ]),
  ].join('\n'),
);

/* 8. Gate arbitration. */
add(
  '08-gate-arbiter.svg',
  'Process 8. Gate arbitration. Telling stopped traffic from an empty road and a dead picture',
  400,
  [
    box(28, 74, 210, 80, 'A flagged camera', ['still, in an hour that moves'], { stroke: WARM }),
    arrow(238, 114, 312, 114, 'state'),
    box(312, 74, 190, 80, 'Jev, one call', ['two nouls'], { stroke: ACCENT }),
    arrow(502, 96, 576, 96, ''),
    arrow(502, 132, 576, 132, ''),
    box(576, 66, 296, 46, 'frozen: the feed has stopped', []),
    box(576, 124, 296, 46, 'standstill: traffic has stopped', []),
    arrow(724, 170, 724, 208, ''),
    diamond(724, 240, 250, 62, 'frozen confident ?'),
    arrow(724, 271, 724, 306, 'no', { lx: 734, anchor: 'start' }),
    arrow(599, 240, 500, 240, 'yes', { lx: 550, ly: 232 }),
    box(576, 306, 296, 48, `Floor of ${JEV.GRIDLOCK_FLOOR}, held ${JEV.GATE_HOLD_S / 60} min`, [], { stroke: ACCENT }),
    box(200, 216, 300, 48, 'Nothing, and the standstill answer with it', [], { dash: true }),
    note(28, 196, [`At most ${JEV.MAX_GATE_PER_PASS} cameras per pass,`, `and one camera at most every ${JEV.GATE_REASK_AFTER_S / 60} minutes.`]),
  ].join('\n'),
);

/* 9. Corridor. */
add(
  '09-corridor.svg',
  'Process 9. Corridor. Upstream candidates from the directed graph rather than from a radius',
  360,
  [
    `<line x1="60" y1="150" x2="840" y2="150" stroke="${LINE}" stroke-width="2"/>`,
    ...[
      [110, 'C-3', '3 hops'],
      [280, 'C-2', '2 hops'],
      [450, 'C-1', '1 hop'],
      [640, 'incident', ''],
      [800, 'C+1', 'downstream'],
    ].map(([x, label, sub]) => [
      `<circle cx="${x}" cy="150" r="9" fill="${label === 'incident' ? WARM : PAPER}" stroke="${label === 'incident' ? WARM : LINE}" stroke-width="2"/>`,
      `<text x="${x}" y="130" text-anchor="middle" font-size="12.5" font-weight="600" fill="${INK}">${esc(label)}</text>`,
      `<text x="${x}" y="176" text-anchor="middle" font-size="11.5" fill="${MUTED}">${esc(sub)}</text>`,
    ].join('\n')),
    `<text x="360" y="108" text-anchor="middle" font-size="12" fill="${MUTED}">traffic travels this way</text>`,
    arrow(200, 96, 560, 96, '', { path: 'M 200 96 L 560 96' }),
    `<text x="360" y="222" text-anchor="middle" font-size="12" fill="${WARM}">the queue tail travels this way, at ${CORRIDOR.WAVE_SPEED_KMH} km/h</text>`,
    arrow(560, 210, 200, 210, '', { path: 'M 560 210 L 200 210', colour: WARM }),
    box(28, 250, 400, 76, 'Candidate set', [`up to ${CORRIDOR.MAX_UPSTREAM_HOPS} hops and ${CORRIDOR.MAX_UPSTREAM_M / 1000} km of road`, `offered to the choice, ${JEV.MAX_NEIGHBOURS} at a time`], { stroke: ACCENT }),
    box(456, 250, 416, 76, 'What each candidate carries', ['road distance, driving time, hops', 'pictures and when a tail would reach it']),
  ].join('\n'),
);

/* 10. Wall. */
add(
  '10-wall.svg',
  'Process 10. The wall. A ranking, a fixed number of tiles, and hysteresis to keep them still',
  330,
  [
    box(28, 70, 210, 80, 'Every scored camera', ['attention in 0..1']),
    arrow(238, 110, 306, 110, 'sort'),
    box(306, 70, 200, 80, 'Ranking', [`top ${TUNING.LOG_TOP_N} written to the log`]),
    arrow(506, 110, 574, 110, ''),
    box(574, 70, 298, 80, 'Tiles', ['size follows attention', 'filterable by state and city']),
    arrow(406, 150, 406, 196, ''),
    box(276, 196, 260, 62, 'Four-rank hysteresis', ['a tile holds until clearly beaten'], { stroke: ACCENT }),
    note(28, 292, ['Without hysteresis, cameras sitting either side of the cut swap places on noise alone, and the wall flickers. A tile has to be beaten by four ranks before it gives up its place.']),
  ].join('\n'),
);

console.log(`${made.length} figures written to docs/figures`);
for (const name of made) console.log(`  ${name}`);
