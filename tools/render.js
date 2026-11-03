// Renders a few scene states to PNG without a browser. Run: node tools/render.js [outDir]
'use strict';
const fs = require('fs');
const path = require('path');
const LPU = require(path.join(__dirname, '../src/core.js'));
const Scene = require(path.join(__dirname, '../src/scene.js'));
const { encode } = require('./png.js');

const out = process.argv[2] || path.join(__dirname, '../dist/snapshots');
fs.mkdirSync(out, { recursive: true });
const W = 800, H = 500, dt = 1 / 60;

function make(opts) {
  const eng = new LPU.Engine(W, H, opts);
  const s = Scene.create(eng, { seed: 5, autoRotate: false });
  eng.tick(dt);
  return { eng, s };
}
function save(name, eng, buf) {
  fs.writeFileSync(path.join(out, name + '.png'), encode(eng.W, eng.H, buf || eng.fb));
  console.log('wrote', name + '.png');
}

let { eng, s } = make();
save('01-rest', eng);

s.setAutoRotate(true);
for (let i = 0; i < 50; i++) eng.tick(dt);
s.setAutoRotate(false);
save('02-rotated', eng);

s.jump();
for (let i = 0; i < 24; i++) eng.tick(dt);
save('03-jump', eng);
for (let i = 0; i < 90; i++) eng.tick(dt);

s.boom();
for (let i = 0; i < 26; i++) eng.tick(dt);
save('04-boom', eng);
for (let i = 0; i < 70; i++) eng.tick(dt);
save('05-settled', eng);
for (let i = 0; i < 120; i++) eng.tick(dt);

s.setLight(W * 0.86, H * 0.3);
eng.tick(dt);
save('06-dusk', eng);

// Vector map: each unit colored by the node its one vector points at.
const ids = new Uint32Array(W * H);
const pal = new Map();
for (let i = 0; i < W * H; i++) {
  const uid = eng.own[i];
  if (!pal.has(uid)) {
    const h = ((uid * 2654435761) >>> 0) % 360 / 360, sat = 0.55, lig = 0.58;
    const f = (n) => { const k = (n + h * 12) % 12; return lig - sat * Math.min(lig, 1 - lig) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    pal.set(uid, (0xFF000000 | (Math.round(f(4) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(0) * 255)) >>> 0);
  }
  ids[i] = pal.get(uid);
}
save('07-vectors', eng, ids);

// Edge blending off: one vector, one color, jagged edges.
({ eng, s } = make({ aa: false }));
save('08-no-edge-blending', eng);
