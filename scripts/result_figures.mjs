/** Draws the whitepaper's result figures, as plain SVG, from saved results rather than from numbers typed in again.
 *
 *     node scripts/result_figures.mjs --bench out/bench/synthetic-<stamp>.json --trace out/trace/a.json out/trace/b.json ...
 *
 * `--bench` is a run of `make bench-synthetic` with several picture rates, and `--trace` is one or more files written by `scripts/trace_summary.py --json`, drawn as bars in the order given. Each figure is drawn only when its input is given. The style follows scripts/figures.mjs, and the output goes to docs/figures beside the process figures. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'figures');

// The palette of scripts/figures.mjs.
const W = 900;
const INK = '#1d2530';
const MUTED = '#5d6b7d';
const LINE = '#96a4b5';
const ACCENT = '#1f6feb';
const WARM = '#b4541a';
const PAPER = '#ffffff';
const SERIES = [ACCENT, WARM, '#2f7d4f', '#7a4fb3'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, s, opts = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${opts.anchor ?? 'start'}" font-size="${opts.size ?? 12}"${opts.weight ? ` font-weight="${opts.weight}"` : ''} fill="${opts.fill ?? MUTED}">${esc(s)}</text>`;

function figure(name, caption, height, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">
<rect width="${W}" height="${height}" fill="${PAPER}"/>
<text x="28" y="34" font-size="15" font-weight="700" fill="${INK}">${esc(caption)}</text>
${body}
</svg>
`;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), svg);
  return name;
}

/** The benchmark's own median, the lower middle value, so the figure agrees with its tables. Quartiles are taken the same way. */
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;
};

const args = process.argv.slice(2);
const after = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const rest = args.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  return end < 0 ? rest : rest.slice(0, end);
};
const benchFile = after('--bench')[0];
const traceFiles = after('--trace');
if (!benchFile && traceFiles.length === 0) {
  console.error('nothing to draw: give --bench and/or --trace');
  process.exit(1);
}
const made = [];

/* 11. Benchmark: minutes until shown against the picture rate. */
if (benchFile) {
  const bench = JSON.parse(readFileSync(benchFile, 'utf8'));
  const cadences = bench.settings.CADENCES;
  if (!cadences || cadences.length < 2) throw new Error(`${benchFile} was run at one picture rate; the figure needs several`);
  const scenarios = bench.results[String(cadences[0])].map((s) => s.scenario);
  const label = { 'quiet-hour': 'Quiet hour, street', 'quiet-hour-freeway': 'Quiet hour, freeway', 'rush-hour': 'Rush hour', 'stopped-traffic': 'Stopped traffic', 'crash-report': 'Crash report' };
  const series = [];
  const never = [];
  for (const scenario of scenarios) {
    const points = cadences.map((c) => {
      const b = bench.results[String(c)].find((s) => s.scenario === scenario).rankers.equation;
      const tts = b.tts.filter((t) => t !== null);
      return { minutes: c / 60, shown: b.surfaced, runs: b.runs, median: quantile(tts, 0.5), low: quantile(tts, 0.25), high: quantile(tts, 0.75) };
    });
    if (points.every((p) => p.shown === 0)) never.push(label[scenario] ?? scenario);
    else series.push({ name: label[scenario] ?? scenario, points });
  }
  const x0 = 90, x1 = 640, y0 = 380, y1 = 70;
  const xMax = Math.max(...cadences) / 60;
  const yMax = Math.ceil(Math.max(xMax, ...series.flatMap((s) => s.points.map((p) => p.high ?? 0))));
  const sx = (m) => x0 + ((x1 - x0) * m) / xMax;
  const sy = (m) => y0 - ((y0 - y1) * m) / yMax;
  const parts = [];
  for (let m = 0; m <= yMax; m++) {
    parts.push(`<line x1="${x0}" y1="${sy(m)}" x2="${x1}" y2="${sy(m)}" stroke="#e6ebf0"/>`, text(x0 - 10, sy(m) + 4, String(m), { anchor: 'end' }));
  }
  for (const c of cadences) parts.push(text(sx(c / 60), y0 + 20, c < 60 ? `${c} s` : `${c / 60} min`, { anchor: 'middle' }));
  parts.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${LINE}"/>`, `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="${LINE}"/>`);
  parts.push(text((x0 + x1) / 2, y0 + 44, 'One picture per camera every', { anchor: 'middle', fill: INK }));
  parts.push(`<text transform="translate(${x0 - 46} ${(y0 + y1) / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="${INK}">Minutes until the target is shown</text>`);
  // One picture period: an event cannot be seen before the next picture arrives.
  parts.push(`<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(Math.min(xMax, yMax))}" y2="${sy(Math.min(xMax, yMax))}" stroke="${LINE}" stroke-dasharray="5 4"/>`);
  parts.push(text(sx(Math.min(xMax, yMax)) - 6, sy(Math.min(xMax, yMax)) - 8, 'one picture period', { anchor: 'end' }));
  series.forEach((s, i) => {
    const color = SERIES[i % SERIES.length];
    const dx = (i - (series.length - 1) / 2) * 7;
    const pts = s.points.filter((p) => p.median !== null);
    parts.push(`<polyline points="${pts.map((p) => `${sx(p.minutes) + dx},${sy(p.median)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.8"/>`);
    for (const p of pts) {
      parts.push(`<line x1="${sx(p.minutes) + dx}" y1="${sy(p.low)}" x2="${sx(p.minutes) + dx}" y2="${sy(p.high)}" stroke="${color}" stroke-width="1.4"/>`);
      parts.push(`<circle cx="${sx(p.minutes) + dx}" cy="${sy(p.median)}" r="3.6" fill="${color}"/>`);
    }
    const shown = s.points.map((p) => p.shown);
    const runs = s.points[0].runs;
    parts.push(`<rect x="672" y="${84 + i * 46}" width="14" height="3" fill="${color}"/>`);
    parts.push(text(694, 90 + i * 46, s.name, { fill: INK, size: 13 }));
    parts.push(text(694, 107 + i * 46, shown.every((n) => n === runs) ? `shown in all ${runs} runs at every rate` : `shown in ${shown.join(', ')} of ${runs} runs`));
  });
  const ny = 84 + series.length * 46 + 10;
  parts.push(text(672, ny, 'Dots are medians and bars the', { fill: MUTED }), text(672, ny + 16, 'middle half of runs, in minutes.', { fill: MUTED }));
  if (never.length) {
    parts.push(text(672, ny + 44, `${never.join(', ')}: shown in none of`, { fill: WARM }), text(672, ny + 60, 'the runs at any rate without a', { fill: WARM }), text(672, ny + 76, 'confirmed standstill.', { fill: WARM }));
  }
  made.push(figure('11-benchmark-picture-rate.svg', `Result 1. Synthetic benchmark. Time until the equation shows the target, by picture rate (${bench.settings.SEEDS} runs each)`, 450, parts.join('\n')));
}

/* 12. Live trace: what held the top places, as run and replayed. */
if (traceFiles.length) {
  const traces = traceFiles.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const kinds = [
    ['incident floor', 'Incident floor', WARM],
    ['queue floor', 'Queue floor', '#e3a77f'],
    ['stopped-traffic floor', 'Stopped-traffic floor', '#7a4fb3'],
    ['movement only', 'Movement alone', ACCENT],
  ];
  const x0 = 300, x1 = 860, barH = 34, gap = 22, top = 96;
  const parts = [];
  for (let p = 0; p <= 100; p += 25) {
    const x = x0 + ((x1 - x0) * p) / 100;
    parts.push(`<line x1="${x}" y1="${top - 8}" x2="${x}" y2="${top + traces.length * (barH + gap) - gap + 8}" stroke="#e6ebf0"/>`, text(x, top + traces.length * (barH + gap) - gap + 26, `${p}%`, { anchor: 'middle' }));
  }
  traces.forEach((t, i) => {
    const y = top + i * (barH + gap);
    const name = `${t.without_planned_work ? 'Replayed, planned work without a floor' : 'As run'}`;
    const limit = t.cap === null ? 'without the wall’s limit' : `limit of ${t.cap} held cameras`;
    parts.push(text(x0 - 14, y + 15, name, { anchor: 'end', fill: INK, size: 12.5 }), text(x0 - 14, y + 31, limit, { anchor: 'end' }));
    let x = x0;
    for (const [key, , color] of kinds) {
      const share = t.drivers[key] ?? 0;
      if (share <= 0) continue;
      const w = (x1 - x0) * share;
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${barH}" fill="${color}"/>`);
      if (w > 40) parts.push(text(x + w / 2, y + barH / 2 + 4, `${Math.round(share * 100)}%`, { anchor: 'middle', fill: PAPER, weight: 600 }));
      x += w;
    }
  });
  const ly = top + traces.length * (barH + gap) + 50;
  let lx = x0;
  for (const [key, name, color] of kinds) {
    if (!traces.some((t) => (t.drivers[key] ?? 0) > 0)) continue;
    parts.push(`<rect x="${lx}" y="${ly - 10}" width="12" height="12" fill="${color}"/>`, text(lx + 18, ly, name, { fill: INK }));
    lx += 150;
  }
  const t0 = traces[0];
  const certain = traces.find((t) => t.certain !== null)?.certain;
  const footnote = `${t0.region}, ${t0.since.replace('T', ' ')} to ${t0.until.slice(11)} local, ${t0.rankings} rankings, top ${t0.top} places.` + (certain ? ` ${Math.round(certain * 100)}% of replayed places are certain against cameras below the logged top 30.` : '');
  parts.push(text(28, ly + 34, footnote));
  made.push(figure('12-live-trace.svg', 'Result 2. Live trace. What put each of the top places on the wall, as run and with the planned-work rule', ly + 56, parts.join('\n')));
}

console.log(`${made.length} figures written to docs/figures`);
for (const name of made) console.log(`  ${name}`);
