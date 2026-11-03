// Same scene, same graph, two rasterizers, in headless Chromium:
//   LPU      the per-unit JavaScript loop (src/core.js) + putImageData
//   Canvas2D the browser's native 2D rasterizer drawing the same primitives
// Each in full-redraw and incremental mode. Also reports the cost of deciding
// what to recompute (rules + nodes + damage) separately from recomputing it.
// Run: node tools/race.js [WxH ...] [--png outDir]
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const pngAt = args.indexOf('--png');
const pngDir = pngAt >= 0 ? args[pngAt + 1] : null;
const sizes = args.filter((a, i) => /^\d+x\d+$/.test(a) && i !== pngAt + 1);
if (!sizes.length) sizes.push('800x500', '1920x1080');

function race({ W, H, frames, repeats, wantPng }) {
  const pick = ['rotate', 'boom', 'lighty'];
  const list = LPUScene.scenarios(W, H).filter(s => pick.includes(s.id));
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };

  function lpu(sc, full) {
    const cv = mk(), ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
    const eng = new LPU.Engine(W, H, { buffer: new Uint32Array(img.data.buffer) });
    const s = LPUScene.create(eng, { seed: 11, autoRotate: false });
    for (let i = 0; i < 3; i++) eng.tick(1 / 60);
    ctx.putImageData(img, 0, 0); ctx.getImageData(0, 0, 1, 1);
    if (sc.setup) sc.setup(s);
    eng.full = full;
    let ms = 0, decide = 0, share = 0;
    for (let f = 0; f < frames; f++) {
      if (sc.step) sc.step(s, f, frames);
      const st = eng.tick(1 / 60);
      const t0 = performance.now();
      if (eng.blit) ctx.putImageData(img, 0, 0, eng.blit.x, eng.blit.y, eng.blit.w, eng.blit.h);
      ctx.getImageData(0, 0, 1, 1);
      ms += st.msUnits + (performance.now() - t0);
      decide += st.msLogic; share += st.units / (W * H);
    }
    return { ms: ms / frames, decide: decide / frames, share: share / frames, cv };
  }
  function c2d(sc, full) {
    const cv = mk(), ctx = cv.getContext('2d');
    const eng = new LPU.Engine(W, H, { raster: false });
    const s = LPUScene.create(eng, { seed: 11, autoRotate: false });
    for (let i = 0; i < 3; i++) eng.tick(1 / 60);
    LPUCanvas2D.draw(ctx, eng, null); ctx.getImageData(0, 0, 1, 1);
    if (sc.setup) sc.setup(s);
    eng.full = full;
    let ms = 0;
    for (let f = 0; f < frames; f++) {
      if (sc.step) sc.step(s, f, frames);
      eng.tick(1 / 60);
      const t0 = performance.now();
      if (full) LPUCanvas2D.draw(ctx, eng, null);
      else if (eng.dirtyList.length) LPUCanvas2D.draw(ctx, eng, eng.dirtyList);
      ctx.getImageData(0, 0, 1, 1);          // wait until the pixels exist
      ms += performance.now() - t0;
    }
    return { ms: ms / frames, cv };
  }
  const best = (fn) => { let b = null; for (let r = 0; r < repeats; r++) { const x = fn(); if (!b || x.ms < b.ms) b = x; } return b; };

  best(() => lpu(list[1], true)); best(() => c2d(list[1], true));   // warm-up
  const rows = [];
  const pngs = {};
  for (const sc of list) {
    const lf = best(() => lpu(sc, true)), li = best(() => lpu(sc, false));
    const cf = best(() => c2d(sc, true)), ci = best(() => c2d(sc, false));
    rows.push({ name: sc.name, share: li.share, decide: li.decide, lpuFull: lf.ms, lpuInc: li.ms, cFull: cf.ms, cInc: ci.ms });
    if (wantPng && sc.id === 'boom') { pngs.lpu = lf.cv.toDataURL(); pngs.canvas2d = cf.cv.toDataURL(); }
  }
  return { rows, pngs };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  for (const f of ['core.js', 'scene.js', 'backend-canvas2d.js']) await page.addScriptTag({ path: path.join(root, 'src', f) });
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no WebGL2';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  console.log('Chromium ' + browser.version() + ' | WebGL renderer here: ' + gpu);
  for (const size of sizes) {
    const [W, H] = size.split('x').map(Number);
    const { rows, pngs } = await page.evaluate(race, { W, H, frames: 60, repeats: 3, wantPng: !!pngDir });
    console.log(`\n${W}x${H}, ms per frame to produce the pixels (best of 3 x 60 frames)`);
    console.log('scenario'.padEnd(30) + 'changed'.padStart(8) + 'decide'.padStart(8) + ' | ' + 'LPU full'.padStart(9) + 'LPU incr'.padStart(9) + ' | ' + 'C2D full'.padStart(9) + 'C2D incr'.padStart(9));
    for (const r of rows) {
      console.log(r.name.padEnd(30) + ((r.share * 100).toFixed(1) + '%').padStart(8) + r.decide.toFixed(2).padStart(8) + ' | ' +
        r.lpuFull.toFixed(2).padStart(9) + r.lpuInc.toFixed(2).padStart(9) + ' | ' + r.cFull.toFixed(2).padStart(9) + r.cInc.toFixed(2).padStart(9));
    }
    if (pngDir && pngs.lpu) {
      fs.mkdirSync(pngDir, { recursive: true });
      for (const k of ['lpu', 'canvas2d']) fs.writeFileSync(path.join(pngDir, `race-${W}x${H}-${k}.png`), Buffer.from(pngs[k].split(',')[1], 'base64'));
    }
  }
  console.log('\n"decide" = rules + nodes + damage marking in incremental mode (choosing what to recompute).');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
