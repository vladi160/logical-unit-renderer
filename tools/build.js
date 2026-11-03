// Builds the single-file page: inlines the scripts and embeds benchmark numbers
// measured here with Node. Writes dist/lpu-demo.html (page fragment for publishing)
// and dist/index.html (full document to open locally).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'src/core.js'));
const Scene = require(path.join(root, 'src/scene.js'));

let page = fs.readFileSync(path.join(root, 'src/page.html'), 'utf8');
for (const name of ['core.js', 'scene.js', 'app.js']) {
  const code = fs.readFileSync(path.join(root, 'src', name), 'utf8').replace(/<\/script/gi, '<\\/script');
  page = page.replace(`<script src="${name}"></script>`, () => `<script>\n${code}\n</script>`);
}

const rows = [];
if (!process.argv.includes('--no-bench')) {
  for (const r of Scene.benchmark(800, 500, { frames: 60, repeats: 5 })) if (r) rows.push(r);
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const data = rows.map(r => ({ id: r.id, name: r.name, share: round(r.share, 4), incMs: round(r.incMs, 2), fullMs: round(r.fullMs, 2), speedup: round(r.speedup, 2) }));
page = page.replace('<!--BENCH-->', () => `<script>window.LPU_BENCH_DEFAULT = ${JSON.stringify(data)};</script>`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/lpu-demo.html'), page);
fs.writeFileSync(path.join(root, 'dist/index.html'),
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  '<style>:root{color-scheme:light}body{margin:0}[hidden]{display:none!important}</style>\n</head>\n<body>\n' + page + '\n</body>\n</html>\n');
console.log('built dist/lpu-demo.html and dist/index.html' + (rows.length ? '' : ' (no benchmark numbers)'));
for (const r of data) console.log('  ' + r.name.padEnd(30) + (r.share * 100).toFixed(1).padStart(6) + '%  ' + String(r.incMs).padStart(6) + ' ms  ' + String(r.fullMs).padStart(6) + ' ms  ' + r.speedup + 'x');
