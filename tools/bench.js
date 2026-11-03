// Incremental vs full redraw on the same engine and scene.
// Run: node tools/bench.js [WxH ...]      e.g. node tools/bench.js 800x500 1920x1080
'use strict';
const path = require('path');
require(path.join(__dirname, '../src/core.js'));
const Scene = require(path.join(__dirname, '../src/scene.js'));

const sizes = process.argv.slice(2).length ? process.argv.slice(2) : ['800x500', '1920x1080'];
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

for (const size of sizes) {
  const [W, H] = size.split('x').map(Number);
  console.log(`\n${W}x${H} (${(W * H).toLocaleString('en-US')} units), 60 frames per scenario, Node ${process.version}`);
  console.log(pad('scenario', 32) + lpad('units', 9) + lpad('nodes', 9) + lpad('incr ms', 10) + lpad('full ms', 10) + lpad('ratio', 9));
  for (const r of Scene.benchmark(W, H, { frames: 60, repeats: 3 })) {
    if (!r) continue;
    console.log(pad(r.name, 32) + lpad((r.share * 100).toFixed(1) + '%', 9) +
      lpad(r.nodes.toFixed(1) + '/' + r.totalNodes, 9) + lpad(r.incMs.toFixed(2), 10) + lpad(r.fullMs.toFixed(2), 10) +
      lpad(r.speedup > 100 ? '>100x' : r.speedup.toFixed(1) + 'x', 9));
  }
}
