/* Demo scene for the LPU core: a cube that turns, jumps and explodes, a
 * draggable light, a floor and two buttons.
 *
 * Nothing here uses 3D math either. Every "3D" cue is a 2D rule:
 *   - Cube shape: four corners on an ellipse, plus the same four shifted down.
 *     (This is what an orthographic projection computes. It is written in 2D
 *     and holds only because the cube turns around one axis under a fixed view.)
 *   - Shading: a face's brightness follows the angle between its facing
 *     direction and the light direction, both plain 2D angles.
 *   - Shadow: an ellipse that shrinks and fades as the cube rises.
 *   - Depth: debris pieces carry a "ground line"; nearer lines draw on top and larger.
 *   - Floor: a per-unit grid function of (x, y), darker on the lines.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.LPUScene = factory(root.LPU);
}(typeof self !== 'undefined' ? self : this, function (LPU) {
  'use strict';
  var P = LPU.prim;
  var PI = Math.PI;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function mul(c, f) { return [c[0] * f, c[1] * f, c[2] * f]; }
  function assign(o, patch) { var r = {}, k; for (k in o) r[k] = o[k]; for (k in patch) r[k] = patch[k]; return r; }
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  function wrapAngle(a) { while (a > PI) a -= 2 * PI; while (a < -PI) a += 2 * PI; return a; }

  var PAINT = [236, 116, 62];      // cube paint

  function createScene(eng, opts) {
    opts = opts || {};
    var W = eng.W, H = eng.H, S = H / 500;
    var L = {
      horizon: Math.round(H * 0.40),
      ground: H * 0.74,                 // screen y of the cube's base center at rest
      cx: W * 0.60,
      side: 112 * S,
      tilt: 0.42,                       // vertical squash of anything lying on the floor
      g: 1500 * S,                      // fall rate, units per second squared
      hMax: 150 * S
    };
    L.R = L.side / Math.SQRT2;
    L.sideH = L.side * Math.sqrt(1 - L.tilt * L.tilt);
    var dy0 = L.ground - L.horizon, gf = dy0 / L.tilt, gE = dy0 / (64 * S);
    var GRID = { hz: L.horizon, vpx: L.cx, f: gf, FE: gf * gE, fade: 0.24 * (H - L.horizon) };

    var scene = {
      layout: L, S: S,
      autoRotate: opts.autoRotate !== false,
      random: rng(opts.seed || 7),
      spinDrag: null, lightDrag: null
    };

    // ---- L2 objects (state) -------------------------------------------------
    var cube = eng.state('Cube', 2, { theta: 0.42, h: 0, v: 0, omega: 0, visible: true },
      { desc: 'angle, height, speed, visible' });
    var light = eng.state('Light', 2, { x: W * 0.22, y: H * 0.12 }, { desc: 'position of the light handle' });
    var debris = eng.state('Debris', 2, null, { desc: 'pieces after BOOM' });
    var ui = eng.state('UI', 2, { hover: null, pressed: null }, { desc: 'hover and press highlights' });

    // ---- L2 abstractions (pure functions) -----------------------------------
    var shape = eng.derive('Cube shape', 2, [cube], function (c) {
      if (!c.visible) return { visible: false, sig: 'hidden' };
      var top = [], bot = [], us = [], ws = [], psi = [], vis = [];
      var yTop = L.ground - c.h - L.sideH, yBot = L.ground - c.h;
      for (var k = 0; k < 4; k++) {
        var a = c.theta + PI / 4 + k * PI / 2;
        var u = L.R * Math.cos(a), w = L.R * Math.sin(a);
        us.push(u); ws.push(w);
        top.push(L.cx + u, yTop + w * L.tilt);
        bot.push(L.cx + u, yBot + w * L.tilt);
        var face = c.theta + (k + 1) * PI / 2;          // direction the side faces
        psi.push(face); vis.push(Math.sin(face) > 0.015);
      }
      return { visible: true, top: top, bot: bot, u: us, w: ws, psi: psi, vis: vis, h: c.h,
        sig: 's' + Math.round(c.theta * 1e4) + ':' + Math.round(c.h * 100) };
    }, { desc: 'four corners on an ellipse, copied downward' });

    var lighting = eng.derive('Lighting', 2, [light], function (l) {
      var e = clamp(1 - (l.y - 14 * S) / (L.horizon - 34 * S), 0, 1);   // 1 = light high up
      var lu = clamp((l.x - L.cx) / (W * 0.5), -1.4, 1.4), lw = 0.8, len = Math.hypot(lu, lw);
      lu /= len; lw /= len;
      return {
        e: e, lu: lu, lw: lw, phi: Math.atan2(lw, lu),
        skyTop: mix([40, 44, 92], [66, 124, 204], e),
        skyHor: mix([240, 150, 100], [194, 220, 240], e),
        floorFar: mix([170, 124, 112], [178, 192, 198], e),
        floorNear: mix([56, 50, 66], [102, 112, 124], e),
        sun: mix([255, 172, 100], [255, 248, 228], e),
        tint: mix([1.10, 0.90, 0.80], [1, 1, 1], e),
        ambient: 0.30 + 0.12 * e, key: 0.80,
        sig: 'l' + Math.round(l.x * 100) + ':' + Math.round(l.y * 100)
      };
    }, { desc: 'light direction and sky colors' });

    function faceColor(lt, isTop, psi) {
      var f = isTop
        ? lt.ambient + lt.key * (0.32 + 0.68 * lt.e)
        : lt.ambient + lt.key * Math.max(0, Math.cos(psi - lt.phi)) * (1 - 0.45 * lt.e);
      return [PAINT[0] * f * lt.tint[0], PAINT[1] * f * lt.tint[1], PAINT[2] * f * lt.tint[2]];
    }
    function sideAO(h) { return 0.72 + 0.24 * Math.min(1, h / (50 * S)); }

    // ---- L1 regions ---------------------------------------------------------
    eng.region('Sky', [lighting], function (lt) {
      return P.rect(0, 0, W, L.horizon + 1, lt.skyTop, lt.skyHor);
    }, { z: 0, desc: 'vertical gradient' });

    eng.region('Floor', [lighting], function (lt) {
      return P.rect(0, L.horizon, W, H, lt.floorFar, lt.floorNear, { fx: floorGrid, fxData: GRID, key: 'grid' });
    }, { z: 1, desc: 'gradient plus a grid function of (x, y)' });

    eng.region('Light handle', [light, lighting, ui], function (l, lt, u) {
      var hov = u.hover === 'light';
      return [
        P.ellipse(l.x, l.y, 118 * S, 118 * S, mul(lt.sun, 0.40), { blend: 'add', soft: 1, pow2: true, ownable: false }),
        P.ellipse(l.x, l.y, 30 * S, 30 * S, [255, 255, 255], { alpha: hov ? 0.30 : 0 }),   // also the hit area
        P.ellipse(l.x, l.y, 15 * S, 15 * S, lt.sun, {})
      ];
    }, { z: 2, role: 'light', desc: 'glow, hit ring, disc' });

    eng.region('Shadow', [shape, lighting], function (s, lt) {
      if (!s.visible) return null;
      var h = s.h, e = lt.e;
      var len = (L.R * 0.55 + h * 0.55) * (1.35 - 0.9 * e);
      var ox = -lt.lu * len * 0.6, oy = -lt.lw * len * 0.6 * L.tilt;
      var rx = L.R * 1.1 + Math.abs(ox) * 0.55 + h * 0.06, ry = rx * L.tilt + Math.abs(oy) * 0.4;
      var dark = (0.42 + 0.18 * e) / (1 + h / (85 * S));
      var soft = Math.min(0.9, 0.38 + h / (320 * S));
      var cd = 0.30 / (1 + h / (18 * S));
      return [
        P.ellipse(L.cx + ox, L.ground + oy, rx, ry, [1 - dark * 0.92, 1 - dark * 0.88, 1 - dark * 0.76], { blend: 'multiply', soft: soft }),
        cd > 0.02 ? P.ellipse(L.cx, L.ground, L.R * 0.98, L.R * 0.98 * L.tilt, [1 - cd, 1 - cd, 1 - cd * 0.9], { blend: 'multiply', soft: 0.45, ownable: false }) : null
      ];
    }, { z: 3, connector: true, desc: 'connector: multiplies the floor under it' });

    eng.region('Debris shadows', [debris, lighting], function (d, lt) {
      if (!d) return null;
      var out = new Array(d.frags.length);
      for (var i = 0; i < d.frags.length; i++) {
        var f = d.frags[i];
        var dark = 0.34 * clamp(1 - f.hz / (240 * S), 0, 1) * (0.7 + 0.3 * lt.e);
        if (dark < 0.02) { out[i] = null; continue; }
        var sc = clamp((f.gy - L.horizon) / (f.home.gy - L.horizon), 0.5, 1.8), r = f.size * 0.62 * sc;
        out[i] = P.ellipse(f.x - lt.lu * f.hz * 0.2, f.gy - lt.lw * f.hz * 0.2 * L.tilt, r, r * L.tilt,
          [1 - dark, 1 - dark, 1 - dark * 0.85], { blend: 'multiply', soft: 0.7, ownable: false });
      }
      return out;
    }, { z: 4, connector: true, desc: 'connector: one soft ellipse per piece' });

    for (var k = 0; k < 4; k++) {
      (function (k) {
        eng.region('Cube side ' + (k + 1), [shape, lighting], function (s, lt) {
          if (!s.visible || !s.vis[k]) return null;
          var j = (k + 1) % 4;
          var pts = [s.top[2 * k], s.top[2 * k + 1], s.top[2 * j], s.top[2 * j + 1],
            s.bot[2 * j], s.bot[2 * j + 1], s.bot[2 * k], s.bot[2 * k + 1]];
          var c0 = faceColor(lt, false, s.psi[k]);
          var yA = (s.top[2 * k + 1] + s.top[2 * j + 1]) / 2, yB = (s.bot[2 * k + 1] + s.bot[2 * j + 1]) / 2;
          return P.poly(pts, c0, { c1: mul(c0, sideAO(s.h)), grad: [0, yA, 0, yB], dil: 0.35 });
        }, { z: 5, role: 'cube', group: 'Cube sides', desc: 'quad between two corners' });
      })(k);
    }

    eng.region('Cube top', [shape, lighting], function (s, lt) {
      if (!s.visible) return null;
      var c = faceColor(lt, true, 0), t = s.top;
      var y0 = Math.min(t[1], t[3], t[5], t[7]), y1 = Math.max(t[1], t[3], t[5], t[7]);
      return P.poly(t, mul(c, 0.93), { c1: mul(c, 1.04), grad: [0, y0, 0, y1], dil: 0.35 });
    }, { z: 6, role: 'cube', desc: 'the four top corners' });

    eng.region('Debris pieces', [debris], function (d) {
      if (!d) return null;
      var out = new Array(d.frags.length);
      for (var i = 0; i < d.frags.length; i++) {
        var f = d.frags[i];
        var sc = clamp((f.gy - L.horizon) / (f.home.gy - L.horizon), 0.5, 1.8);
        var ca = Math.cos(f.ang) * sc, sa = Math.sin(f.ang) * sc, X = f.x, Y = f.gy - f.hz, pts = [];
        for (var j = 0; j < f.local.length; j += 2) {
          var lx = f.local[j], ly = f.local[j + 1];
          pts.push(X + lx * ca - ly * sa, Y + lx * sa + ly * ca);
        }
        out[i] = P.poly(pts, f.color, { zOff: clamp((f.gy - L.horizon) / (H - L.horizon), 0, 0.999), dil: 0.25 });
      }
      return out;
    }, { z: 7, desc: 'one polygon per piece, nearer pieces on top' });

    function buttonPrims(u, role, x0, label, cA, cB) {
      var hov = u.hover === role, prs = u.pressed === role;
      var w = 112 * S, h = 44 * S, y0 = H - (20 + 44) * S + (prs ? 2 * S : 0);
      var f = prs ? 0.86 : hov ? 1.12 : 1;
      var sc = Math.max(1, Math.round(3 * S)), tw = P.textWidth(label, sc);
      return [
        P.rrect(x0, y0 + 3 * S, x0 + w, y0 + h + 4 * S, 10 * S, [0, 0, 0], null, { alpha: prs ? 0.16 : 0.28, soft: 5 * S, ownable: false }),
        P.rrect(x0, y0, x0 + w, y0 + h, 10 * S, mul(cA, f), mul(cB, f)),
        P.text(Math.round(x0 + (w - tw) / 2), Math.round(y0 + (h - 7 * sc) / 2), sc, label, [252, 250, 244], { ownable: false })
      ];
    }
    eng.region('BOOM button', [ui], function (u) {
      return buttonPrims(u, 'boom', 20 * S, 'BOOM', [214, 70, 62], [168, 42, 44]);
    }, { z: 9, role: 'boom', desc: 'rounded box and label' });
    eng.region('JUMP button', [ui], function (u) {
      return buttonPrims(u, 'jump', (20 + 124) * S, 'JUMP', [66, 98, 168], [42, 66, 126]);
    }, { z: 9, role: 'jump', desc: 'rounded box and label' });

    // ---- L3 rules -----------------------------------------------------------
    var targets = {};
    var uiRule, lightRule, spinRule, gravityRule, explodeRule, debrisRule;
    var capture = null;
    var HOVERABLE = { boom: 1, jump: 1, light: 1, cube: 1 };

    // Input arrives at a unit and travels up that unit's one vector:
    // unit -> region -> the rule that region names.
    var inputRule = eng.rule('Input', [], [], function (eng, dt, events) {
      if (!events.length) return false;
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var hit = ev.type === 'leave' ? null : eng.unitAt(ev.x, ev.y);
        ev.role = hit && hit.node ? (hit.node.meta.role || null) : null;
        ev.unit = hit;
        if (ev.type === 'down') { capture = targets[ev.role] || null; if (capture) capture.inbox.push(ev); }
        else if (ev.type === 'move') { if (capture) capture.inbox.push(ev); }
        else { if (capture) capture.inbox.push(ev); capture = null; }
        uiRule.inbox.push(ev);
      }
      return true;
    }, { desc: 'routes a pointer event up from the unit it hit' });

    uiRule = eng.rule('Highlight', [], [ui], function () {
      var box = this.inbox;
      if (!box.length) return false;
      var u = ui.value, hover = u.hover, pressed = u.pressed;
      for (var i = 0; i < box.length; i++) {
        var ev = box[i];
        if (ev.type === 'move') { if (!pressed) hover = HOVERABLE[ev.role] ? ev.role : null; }
        else if (ev.type === 'down') { pressed = (ev.role === 'boom' || ev.role === 'jump') ? ev.role : null; hover = HOVERABLE[ev.role] ? ev.role : null; }
        else if (ev.type === 'leave') { hover = null; pressed = null; }
        else pressed = null;
      }
      box.length = 0;
      return ui.set({ hover: hover, pressed: pressed });
    }, { desc: 'button and handle highlights' });

    lightRule = eng.rule('Light drag', [], [light], function () {
      var box = this.inbox;
      if (!box.length) return false;
      var l = light.value, nx = l.x, ny = l.y;
      for (var i = 0; i < box.length; i++) {
        var ev = box[i];
        if (ev.type === 'set') { nx = ev.x; ny = ev.y; }
        else if (ev.type === 'down') scene.lightDrag = { dx: l.x - ev.x, dy: l.y - ev.y };
        else if (ev.type === 'move') { if (scene.lightDrag) { nx = ev.x + scene.lightDrag.dx; ny = ev.y + scene.lightDrag.dy; } }
        else scene.lightDrag = null;
      }
      box.length = 0;
      nx = clamp(nx, 18 * S, W - 18 * S); ny = clamp(ny, 16 * S, L.horizon - 20 * S);
      light.set({ x: nx, y: ny });
      return true;
    }, { desc: 'moves the light handle' });

    spinRule = eng.rule('Spin', [eng.clock], [cube], function (eng, dt) {
      var box = this.inbox, had = box.length > 0, dth = 0;
      for (var i = 0; i < box.length; i++) {
        var ev = box[i];
        if (ev.type === 'down') scene.spinDrag = { x: ev.x };
        else if (ev.type === 'move') { if (scene.spinDrag) { dth += (ev.x - scene.spinDrag.x) * 0.011 / S; scene.spinDrag.x = ev.x; } }
        else scene.spinDrag = null;
      }
      box.length = 0;
      var c = cube.value;
      if (!c.visible) return had;
      var theta = c.theta, omega = c.omega;
      if (scene.spinDrag || dth !== 0) {
        theta += dth;
        omega = dt > 0 ? clamp(dth / dt, -14, 14) : 0;
      } else {
        var auto = scene.autoRotate ? 0.55 : 0;
        if (omega === 0 && auto === 0) return had;
        theta += (auto + omega) * dt;
        omega *= Math.exp(-2.4 * dt);
        if (Math.abs(omega) < 0.03) omega = 0;
      }
      if (theta === c.theta && omega === c.omega) return had;
      cube.set(assign(c, { theta: theta, omega: omega }));
      return true;
    }, { desc: 'drag, inertia, auto-rotate' });

    gravityRule = eng.rule('Gravity', [eng.clock], [cube], function (eng, dt) {
      var box = this.inbox, jump = false;
      for (var i = 0; i < box.length; i++) if (box[i].type === 'down') jump = true;
      box.length = 0;
      var c = cube.value;
      if (!c.visible) return jump;
      var h = c.h, v = c.v, omega = c.omega;
      if (jump && h < 6 * S) { v = Math.sqrt(2 * L.g * L.hMax); omega += 4.5; }
      if (h <= 0 && v === 0) { if (omega !== c.omega) cube.set(assign(c, { omega: omega })); return jump; }
      v -= L.g * dt; h += v * dt;
      if (h <= 0) { h = 0; v = -v > 140 * S ? -v * 0.42 : 0; }
      cube.set(assign(c, { h: h, v: v, omega: omega }));
      return true;
    }, { desc: 'height += speed; speed -= g' });

    explodeRule = eng.rule('Explode', [shape, lighting], [cube, debris], function () {
      var box = this.inbox, boom = false;
      for (var i = 0; i < box.length; i++) if (box[i].type === 'down') boom = true;
      box.length = 0;
      if (!boom) return false;
      var c = cube.value;
      if (!c.visible || debris.value) return true;
      var frags = makeDebris(shape.value, lighting.value);
      cube.set(assign(c, { visible: false, v: 0, omega: 0 }));
      debris.set({ phase: 'fly', t: 0, frags: frags });
      return true;
    }, { desc: 'cuts the visible faces into pieces' });

    debrisRule = eng.rule('Debris motion', [eng.clock], [debris, cube], function (eng, dt) {
      var d = debris.value;
      if (!d) return false;
      var t = d.t + dt, n = d.frags.length, frags = new Array(n), i, f, nf;
      if (d.phase === 'fly') {
        var g = L.g, fr = Math.exp(-7 * dt);
        for (i = 0; i < n; i++) {
          f = d.frags[i]; nf = assign(f, {});
          nf.vz -= g * dt; nf.hz += nf.vz * dt;
          nf.x += nf.vx * dt; nf.gy += nf.vg * dt; nf.ang += nf.w * dt;
          if (nf.hz <= 0) {
            nf.hz = 0;
            if (nf.vz < -70 * S) { nf.vz = -nf.vz * 0.36; nf.vx *= 0.62; nf.vg *= 0.62; nf.w *= 0.55; }
            else {
              nf.vz = 0; nf.vx *= fr; nf.vg *= fr; nf.w *= fr;
              if (Math.abs(nf.vx) < 0.5) nf.vx = 0;
              if (Math.abs(nf.vg) < 0.5) nf.vg = 0;
              if (Math.abs(nf.w) < 0.02) nf.w = 0;
            }
          }
          var gmin = L.horizon + 10 * S, gmax = H - 3 * S;
          if (nf.gy < gmin) { nf.gy = gmin; nf.vg = Math.abs(nf.vg) * 0.5; }
          if (nf.gy > gmax) { nf.gy = gmax; nf.vg = -Math.abs(nf.vg) * 0.5; }
          if (nf.x < 4 * S) { nf.x = 4 * S; nf.vx = Math.abs(nf.vx) * 0.5; }
          if (nf.x > W - 4 * S) { nf.x = W - 4 * S; nf.vx = -Math.abs(nf.vx) * 0.5; }
          frags[i] = nf;
        }
        if (t > 2.3) {
          for (i = 0; i < n; i++) frags[i].from = { x: frags[i].x, gy: frags[i].gy, hz: frags[i].hz, ang: wrapAngle(frags[i].ang) };
          debris.set({ phase: 'gather', t: 0, frags: frags });
        } else {
          debris.set({ phase: 'fly', t: t, frags: frags });
        }
        return true;
      }
      // Gather: a plain function of time, no simulation.
      var u = Math.min(1, t / 0.85), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      for (i = 0; i < n; i++) {
        f = d.frags[i]; var a = f.from, hm = f.home; nf = assign(f, {});
        nf.x = a.x + (hm.x - a.x) * e; nf.gy = a.gy + (hm.gy - a.gy) * e;
        nf.hz = a.hz + (hm.hz - a.hz) * e + Math.sin(PI * e) * 46 * S;
        nf.ang = a.ang * (1 - e);
        frags[i] = nf;
      }
      if (u >= 1) {
        debris.set(null);
        cube.set(assign(cube.value, { visible: true }));
      } else {
        debris.set({ phase: 'gather', t: t, frags: frags });
      }
      return true;
    }, { desc: 'pieces fly and settle, then gather back' });

    targets.cube = spinRule; targets.jump = gravityRule; targets.boom = explodeRule; targets.light = lightRule;
    eng.vector(inputRule, uiRule); eng.vector(inputRule, lightRule); eng.vector(inputRule, spinRule);
    eng.vector(inputRule, gravityRule); eng.vector(inputRule, explodeRule);
    eng.upVector(eng.unitsNode, inputRule);

    // Cut every visible face into 4 x 4 pieces that remember where they belong.
    function makeDebris(s, lt) {
      var frags = [], n = 4, rand = scene.random;
      if (!s || !s.visible) return frags;
      var zTop = s.h + L.sideH, zBot = s.h, k;
      function corner(arr, k, z) { return { X: arr[2 * k], Y: arr[2 * k + 1], u: s.u[k], w: s.w[k], z: z }; }
      var faces = [];
      var tc = faceColor(lt, true, 0), t = s.top;
      faces.push({ c: [corner(t, 0, zTop), corner(t, 1, zTop), corner(t, 2, zTop), corner(t, 3, zTop)],
        side: false, c0: mul(tc, 0.93), c1: mul(tc, 1.04),
        y0: Math.min(t[1], t[3], t[5], t[7]), y1: Math.max(t[1], t[3], t[5], t[7]) });
      for (k = 0; k < 4; k++) {
        if (!s.vis[k]) continue;
        var j = (k + 1) % 4, sc0 = faceColor(lt, false, s.psi[k]);
        faces.push({ c: [corner(s.top, k, zTop), corner(s.top, j, zTop), corner(s.bot, j, zBot), corner(s.bot, k, zBot)],
          side: true, c0: sc0, c1: mul(sc0, sideAO(s.h)) });
      }
      function lerpC(a, b, t) { return { X: a.X + (b.X - a.X) * t, Y: a.Y + (b.Y - a.Y) * t, u: a.u + (b.u - a.u) * t, w: a.w + (b.w - a.w) * t, z: a.z + (b.z - a.z) * t }; }
      function at(c, sa, tb) { return lerpC(lerpC(c[0], c[1], sa), lerpC(c[3], c[2], sa), tb); }
      for (var fi = 0; fi < faces.length; fi++) {
        var F = faces[fi];
        for (var b = 0; b < n; b++) {
          for (var a = 0; a < n; a++) {
            var qs = [at(F.c, a / n, b / n), at(F.c, (a + 1) / n, b / n), at(F.c, (a + 1) / n, (b + 1) / n), at(F.c, a / n, (b + 1) / n)];
            var cX = 0, cY = 0, cu = 0, cw = 0, cz = 0, m;
            for (m = 0; m < 4; m++) { cX += qs[m].X / 4; cY += qs[m].Y / 4; cu += qs[m].u / 4; cw += qs[m].w / 4; cz += qs[m].z / 4; }
            var local = [], size = 0;
            for (m = 0; m < 4; m++) {
              var lx = qs[m].X - cX, ly = qs[m].Y - cY;
              local.push(lx, ly);
              size = Math.max(size, Math.hypot(lx, ly));
            }
            var ar = 0;
            for (m = 0; m < 4; m++) { var m2 = (m + 1) % 4; ar += local[2 * m] * local[2 * m2 + 1] - local[2 * m2] * local[2 * m + 1]; }
            if (Math.abs(ar) < 4) continue;
            var tcol = F.side ? (b + 0.5) / n : clamp((cY - F.y0) / Math.max(1, F.y1 - F.y0), 0, 1);
            var gy0 = L.ground + cw * L.tilt, hz0 = gy0 - cY;
            var len = Math.hypot(cu, cw), du, dw;
            if (len < 4 * S) { var ang = rand() * 2 * PI; du = Math.cos(ang); dw = Math.sin(ang); }
            else { du = cu / len; dw = cw / len; }
            var sp = (0.6 + rand() * 0.9) * 210 * S;
            frags.push({
              local: local, color: mix(F.c0, F.c1, tcol), size: size,
              x: cX, gy: gy0, hz: hz0, ang: 0,
              vx: du * sp + (rand() - 0.5) * 60 * S,
              vg: dw * sp * L.tilt * 0.9 + (rand() - 0.5) * 30 * S,
              vz: (220 + rand() * 360) * S * (0.55 + 0.6 * cz / (L.sideH + s.h + 1)),
              w: (rand() - 0.5) * 16,
              home: { x: cX, gy: gy0, hz: hz0 }
            });
          }
        }
      }
      return frags;
    }

    function floorGrid(p, px, py, col) {
      var d = p.fxData, dy = py - d.hz;
      if (dy < 1) return;
      var z = d.FE / dy, X = (px - d.vpx) * z / d.f;
      var rz = z - Math.round(z), rx = X - Math.round(X);
      if (rz < 0) rz = -rz;
      if (rx < 0) rx = -rx;
      var spz = dy * dy / d.FE, spx = d.f / z;       // units between neighbouring lines
      var lz = 1 - rz * spz, lx = 1 - rx * spx;
      var az = (spz - 3) / 14, ax = (spx - 3) / 14;
      az = az < 0 ? 0 : az > 1 ? 1 : az; ax = ax < 0 ? 0 : ax > 1 ? 1 : ax;
      var line = lz > 0 ? lz * az : 0, l2 = lx > 0 ? lx * ax : 0;
      if (l2 > line) line = l2;
      if (line <= 0) return;
      var fd = dy / d.fade;                          // haze: lines fade toward the horizon
      if (fd < 1) line *= fd * fd;
      var kk = 1 - 0.15 * line;
      col[0] *= kk; col[1] *= kk; col[2] *= kk;
    }

    // ---- API for the page and the benchmark ----------------------------------
    scene.nodes = { cube: cube, light: light, debris: debris, ui: ui, shape: shape, lighting: lighting };
    scene.rules = { input: inputRule, highlight: uiRule, light: lightRule, spin: spinRule, gravity: gravityRule, explode: explodeRule, debris: debrisRule };
    scene.boom = function () { explodeRule.inbox.push({ type: 'down' }); };
    scene.jump = function () { gravityRule.inbox.push({ type: 'down' }); };
    scene.setLight = function (x, y) { lightRule.inbox.push({ type: 'set', x: x, y: y }); };
    scene.setAutoRotate = function (b) { scene.autoRotate = !!b; };
    scene.cursor = function () {
      if (scene.spinDrag || scene.lightDrag) return 'grabbing';
      var hv = ui.value.hover;
      return hv === 'cube' || hv === 'light' ? 'grab' : hv ? 'pointer' : 'default';
    };
    return scene;
  }

  // ---------------------------------------------------------------------------
  // Benchmark: the same scene and engine, incremental vs full redraw.
  // ---------------------------------------------------------------------------
  function scenarios(W, H) {
    return [
      { id: 'idle', name: 'Nothing changes', setup: function () {} },
      { id: 'rotate', name: 'Cube rotating', setup: function (s) { s.setAutoRotate(true); } },
      { id: 'jump', name: 'Cube jumping', setup: function (s) { s.jump(); } },
      { id: 'boom', name: 'Explosion, 96 moving regions', setup: function (s) { s.boom(); } },
      { id: 'lightx', name: 'Light moves sideways', step: function (s, f, n) { s.setLight(W * (0.12 + 0.5 * f / n), H * 0.12); } },
      { id: 'lighty', name: 'Light moves up and down', step: function (s, f, n) { s.setLight(W * 0.22, H * (0.06 + 0.24 * f / n)); } }
    ];
  }

  function runOne(W, H, sc, full, frames) {
    var eng = new LPU.Engine(W, H, { aa: true });
    var s = createScene(eng, { seed: 11, autoRotate: false });
    for (var i = 0; i < 3; i++) eng.tick(1 / 60);
    if (sc.setup) sc.setup(s);
    eng.full = full;
    var ms = 0, units = 0, nodes = 0, cut = 0;
    for (var f = 0; f < frames; f++) {
      if (sc.step) sc.step(s, f, frames);
      var st = eng.tick(1 / 60);
      ms += st.ms; units += st.units; nodes += st.nodesEvaluated; cut += st.cutoffs;
    }
    return { ms: ms / frames, share: units / frames / (W * H), nodes: nodes / frames, cutoffs: cut / frames, totalNodes: eng.evaluableCount() };
  }

  // Generator so a page can run it in slices without freezing. Each mode runs
  // `repeats` times and keeps the fastest run, which filters out interference.
  function* benchmark(W, H, opts) {
    opts = opts || {};
    var frames = opts.frames || 60, repeats = opts.repeats || 1, list = scenarios(W, H);
    runOne(W, H, list[3], true, 20);          // warm up the JIT on the busiest paths
    runOne(W, H, list[3], false, 20);
    for (var i = 0; i < list.length; i++) {
      var inc = null, full = null, r, k;
      for (k = 0; k < repeats; k++) {
        r = runOne(W, H, list[i], false, frames);
        if (!inc || r.ms < inc.ms) inc = r;
        yield null;
        r = runOne(W, H, list[i], true, frames);
        if (!full || r.ms < full.ms) full = r;
        yield null;
      }
      yield { id: list[i].id, name: list[i].name, share: inc.share, nodes: inc.nodes, cutoffs: inc.cutoffs,
        totalNodes: inc.totalNodes, incMs: inc.ms, fullMs: full.ms, speedup: full.ms / Math.max(inc.ms, 1e-3) };
    }
  }

  return { create: createScene, benchmark: benchmark, scenarios: scenarios };
}));
