// Behavioural checks for the core + scene. Run: node tools/test.js
'use strict';
const path = require('path');
const LPU = require(path.join(__dirname, '../src/core.js'));
const Scene = require(path.join(__dirname, '../src/scene.js'));

let failed = 0;
function check(name, ok, info) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : ''));
  if (!ok) failed++;
}
const W = 800, H = 500, N = W * H, dt = 1 / 60;
function fresh(opts) {
  const eng = new LPU.Engine(W, H);
  const s = Scene.create(eng, Object.assign({ seed: 3, autoRotate: false }, opts || {}));
  return { eng, s };
}
const byName = (eng, n) => eng.nodes.find(x => x.name === n);

{
  const { eng, s } = fresh();
  let st = eng.tick(dt);
  check('first frame computes every unit', st.units === N, st.units);
  let missing = 0;
  for (let i = 0; i < N; i++) if (eng.own[i] < 0 || !eng.nodeOfUid(eng.own[i])) missing++;
  check('every unit has exactly one valid vector', missing === 0, missing + ' without');
  check('the vector buffer is one Int32 per unit', eng.own.length === N && eng.own.BYTES_PER_ELEMENT === 4);

  st = eng.tick(dt);
  check('idle frame recomputes nothing', st.units === 0 && st.nodesEvaluated === 0, st.units + ' units, ' + st.nodesEvaluated + ' nodes');

  s.setAutoRotate(true);
  st = eng.tick(dt);
  const shadow = byName(eng, 'Shadow');
  check('rotation touches a small share of units', st.units > 0 && st.units < N * 0.15, (100 * st.units / N).toFixed(1) + '%');
  check('only pure functions and regions count as evaluable', eng.evaluableCount() === 15, eng.evaluableCount());
  check('shadow is evaluated but stops early when only the angle changes',
    shadow.evalFrame === eng.frame && shadow.changeFrame !== eng.frame);

  s.setAutoRotate(false);
  eng.tick(dt);
  const l = s.nodes.light.value;
  s.setLight(l.x + 60, l.y);
  st = eng.tick(dt);
  const sky = byName(eng, 'Sky');
  check('sideways light move skips sky and floor (cutoff)', sky.evalFrame === eng.frame && sky.changeFrame !== eng.frame && st.units < N,
    (100 * st.units / N).toFixed(1) + '%');
  s.setLight(l.x + 60, l.y + 40);
  st = eng.tick(dt);
  check('vertical light move recomputes every unit', st.units === N, (100 * st.units / N).toFixed(1) + '%');
}

{
  const { eng, s } = fresh();
  eng.tick(dt);
  // Find a unit owned by the BOOM button and click it: the event must travel up its vector.
  let bx = -1, by = -1;
  for (let i = 0; i < N && bx < 0; i++) {
    const n = eng.nodeOfUid(eng.own[i]);
    if (n && n.meta.role === 'boom') { bx = i % W; by = (i / W) | 0; }
  }
  check('BOOM button owns units in the bottom-left', bx >= 0 && bx < W / 3 && by > H * 0.8, bx + ',' + by);
  eng.emit({ type: 'down', x: bx + 0.5, y: by + 0.5 });
  eng.emit({ type: 'up', x: bx + 0.5, y: by + 0.5 });
  const st = eng.tick(dt);
  check('click on a far button reaches the cube through vectors', !s.nodes.cube.value.visible && s.nodes.debris.value && s.nodes.debris.value.frags.length >= 32,
    s.nodes.debris.value ? s.nodes.debris.value.frags.length + ' pieces' : 'none');
  // units between the button and the cube must not be recomputed for the click
  const mid = Math.round(H * 0.55) * W + Math.round(W * 0.3);
  check('units between the button and the cube stay untouched', eng.stamp[mid] !== eng.frame);
  let frames = 0;
  while (!s.nodes.cube.value.visible && frames < 400) { eng.tick(dt); frames++; }
  check('pieces gather and the cube returns', s.nodes.cube.value.visible && s.nodes.debris.value === null, frames + ' frames');
}

{
  const { eng, s } = fresh();
  eng.tick(dt);
  s.jump();
  let peak = 0, frames = 0;
  do { eng.tick(dt); peak = Math.max(peak, s.nodes.cube.value.h); frames++; } while ((s.nodes.cube.value.h > 0 || s.nodes.cube.value.v !== 0) && frames < 400);
  check('jump rises and lands again', peak > 100 && s.nodes.cube.value.h === 0, 'peak ' + peak.toFixed(1) + ', ' + frames + ' frames');
  const st = eng.tick(dt);
  check('after landing the scene is idle again', st.units === 0 || s.nodes.cube.value.omega !== 0, st.units);
}

{
  const { eng, s } = fresh();
  eng.tick(dt);
  const sh = s.nodes.shape.value;
  const hit = eng.unitAt(sh.top[0] * 0.5 + sh.top[4] * 0.5, sh.top[1] * 0.5 + sh.top[5] * 0.5);
  check('a unit in the middle of the top face points at Cube top', hit && hit.node && hit.node.name === 'Cube top', hit && hit.node && hit.node.name);
  const names = eng.trace(hit.node).map(n => n.name);
  check('provenance reaches the rules', ['Cube shape', 'Cube', 'Spin', 'Gravity', 'Lighting', 'Light'].every(n => names.includes(n)), names.join(' > '));
}

{
  // Full mode recomputes everything every frame, incremental only what changed.
  const a = fresh(), b = fresh();
  a.eng.tick(dt); b.eng.tick(dt);
  b.eng.full = true;
  const sa = a.eng.tick(dt), sb = b.eng.tick(dt);
  check('full redraw mode recomputes every unit', sb.units === N && sa.units === 0);
  // Both modes must produce identical pixels.
  a.s.setAutoRotate(true); b.s.setAutoRotate(true);
  for (let i = 0; i < 20; i++) { a.eng.tick(dt); b.eng.tick(dt); }
  let diff = 0;
  for (let i = 0; i < N; i++) if (a.eng.fb[i] !== b.eng.fb[i]) diff++;
  check('incremental and full redraw give identical images', diff === 0, diff + ' units differ');
}

console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
process.exit(failed ? 1 : 0);
