// Renders a scripted terminal session as an animated SVG (CSS keyframes, no scripts, no fonts to load).
// node render.mjs <script.json> <out.svg>
// script.json: { "title": "...", "rows": 24, "cols": 92, "steps": [
//   { "type": "type", "text": "quorum review ...", "ms": 1600 },        // typed at the prompt
//   { "type": "out", "lines": ["..."], "ms": 900, "each": 60 },          // output lines, appended one by one
//   { "type": "note", "text": "… 1 min 40 s later (sped up) …", "ms": 1200 },
//   { "type": "pause", "ms": 2500 },
//   { "type": "clear" } ] }
import { readFileSync, writeFileSync } from 'node:fs';

const [scriptFile, out] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
const rows = script.rows ?? 24;
const cols = script.cols ?? 92;
const charW = 8.4, lineH = 18, padX = 16, padTop = 44, padBottom = 14;
const width = Math.round(cols * charW + padX * 2);
const height = padTop + rows * lineH + padBottom;
const prompt = '$ ';

const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = text => (text.length > cols ? text.slice(0, cols - 1) + '…' : text);

// Build frames: each frame is a full screen (array of {text, cls}) shown for `ms`.
const frames = [];
let screen = [];
const push = (ms) => frames.push({ lines: screen.slice(-rows), ms });
for (const step of script.steps) {
  if (step.type === 'clear') { screen = []; continue; }
  if (step.type === 'pause') { push(step.ms); continue; }
  if (step.type === 'type') {
    const text = step.text;
    const parts = Math.min(12, text.length);
    const base = [...screen];
    for (let i = 1; i <= parts; i++) {
      screen = [...base, { text: prompt + text.slice(0, Math.ceil((text.length * i) / parts)), cls: 'cmd' }];
      push(Math.round(step.ms / parts));
    }
    continue;
  }
  if (step.type === 'note') { screen = [...screen, { text: step.text, cls: 'note' }]; push(step.ms); continue; }
  if (step.type === 'out') {
    const each = step.each ?? 0;
    for (const line of step.lines) {
      screen = [...screen, typeof line === 'string' ? { text: line, cls: classify(line) } : line];
      if (each) push(each);
    }
    push(step.ms ?? 600);
  }
}

function classify(line) {
  if (/BLOCKER|IMPORTANT/.test(line) && /^#|^\s*###|Severity/.test(line)) return 'warn';
  if (/^#{1,3} /.test(line)) return 'head';
  if (/exit 0|COMPLETE|passed/.test(line)) return 'ok';
  if (/^quorum:/.test(line)) return 'dim';
  return '';
}

const total = frames.reduce((sum, frame) => sum + frame.ms, 0);
let at = 0;
const pct = ms => ((ms / total) * 100).toFixed(4);
let css = '';
let groups = '';
frames.forEach((frame, index) => {
  const start = at, end = at + frame.ms;
  at = end;
  // Visible only inside [start, end): steps() keeps transitions instant.
  css += `@keyframes f${index}{0%,${pct(start)}%{visibility:hidden}${pct(start)}%,${pct(end)}%{visibility:visible}${index === frames.length - 1 ? '' : `${pct(end)}%,`}100%{visibility:${index === frames.length - 1 ? 'visible' : 'hidden'}}}\n`;
  groups += `<g style="animation:f${index} ${total}ms steps(1,end) infinite">`;
  frame.lines.forEach((line, row) => {
    if (!line.text) return;
    groups += `<text x="${padX}" y="${padTop + (row + 1) * lineH - 4}" class="${line.cls}">${esc(clip(line.text))}</text>`;
  });
  groups += '</g>\n';
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(script.title)}">
<title>${esc(script.title)}</title>
<style>
text{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;fill:#d6deeb;white-space:pre}
.cmd{fill:#ffffff;font-weight:600}.dim{fill:#7f8ea3}.note{fill:#f2c94c;font-style:italic}.ok{fill:#7ee787}.warn{fill:#ffa657;font-weight:600}.head{fill:#79c0ff;font-weight:600}
g{visibility:hidden}
${css}</style>
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<rect width="${width}" height="30" rx="10" fill="#161b22"/><rect y="20" width="${width}" height="10" fill="#161b22"/>
<circle cx="18" cy="15" r="5.5" fill="#ff5f56"/><circle cx="36" cy="15" r="5.5" fill="#ffbd2e"/><circle cx="54" cy="15" r="5.5" fill="#27c93f"/>
<text x="${width / 2}" y="19" text-anchor="middle" class="dim">${esc(script.title)}</text>
${groups}</svg>
`;
writeFileSync(out, svg);
console.error(`frames=${frames.length} seconds=${(total / 1000).toFixed(1)} bytes=${svg.length} size=${width}x${height}`);
