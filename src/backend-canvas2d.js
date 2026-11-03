/* Canvas 2D backend: draws the same L1 primitives with the browser's native
 * 2D rasterizer (Skia in Chrome) instead of the per-unit JavaScript loop.
 * The graph, rules, regions and damage are shared; only L0 execution differs.
 * Used to compare rasterizers fairly. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LPUCanvas2D = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var OP = ['source-over', 'multiply', 'lighter'];

  function css(r, g, b, a) { return 'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' + a + ')'; }
  function paint(ctx, p, a) {
    var k = p.blend === 1 ? 255 : 1;           // multiply primitives store a 0..1 factor
    if (!p.g) return css(p.r0 * k, p.g0 * k, p.b0 * k, a);
    var gr = ctx.createLinearGradient(p.g[0], p.g[1], p.g[2], p.g[3]);
    gr.addColorStop(0, css(p.r0 * k, p.g0 * k, p.b0 * k, a));
    gr.addColorStop(1, css(p.r1 * k, p.g1 * k, p.b1 * k, a));
    return gr;
  }

  function ellipse(ctx, p) {
    var k = p.blend === 1 ? 255 : 1, r = p.r0 * k, g = p.g0 * k, b = p.b0 * k;
    ctx.save();
    ctx.translate(p.cx, p.cy);
    ctx.scale(p.rx, p.ry);
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    if (p.crisp) ctx.fillStyle = css(r, g, b, p.alpha);
    else {
      var gr = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      if (p.pow2) {
        gr.addColorStop(0, css(r, g, b, p.alpha));
        gr.addColorStop(0.5, css(r, g, b, p.alpha * 0.25));
        gr.addColorStop(1, css(r, g, b, 0));
      } else {
        gr.addColorStop(Math.max(0, 1 - p.soft), css(r, g, b, p.alpha));
        gr.addColorStop(1, css(r, g, b, 0));
      }
      ctx.fillStyle = gr;
    }
    ctx.fill();
    ctx.restore();
  }

  function grid(ctx, p) {
    var d = p.fxData;
    if (!d) return;
    var yStart = d.hz + d.fade * 0.35, y, z, k;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (z = 1; z < 400; z++) {
      y = d.hz + d.FE / z;
      if (y < yStart) break;
      if (y > p.by1) continue;
      ctx.moveTo(p.bx0, y); ctx.lineTo(p.bx1, y);
    }
    var zFar = d.FE / (yStart - d.hz), zNear = d.FE / (p.by1 - d.hz);
    var kMin = Math.floor((p.bx0 - d.vpx) * zFar / d.f), kMax = Math.ceil((p.bx1 - d.vpx) * zFar / d.f);
    for (k = kMin; k <= kMax; k++) {
      ctx.moveTo(d.vpx + k * d.f / zFar, yStart);
      ctx.lineTo(d.vpx + k * d.f / zNear, p.by1);
    }
    ctx.stroke();
    ctx.restore();
  }

  function text(ctx, p) {
    var s = p.scale;
    ctx.fillStyle = css(p.r0, p.g0, p.b0, p.alpha);
    ctx.beginPath();
    for (var i = 0; i < p.glyphs.length; i++) {
      for (var row = 0; row < 7; row++) {
        var bits = p.glyphs[i][row];
        for (var c = 0; c < 5; c++) if ((bits >> (4 - c)) & 1) ctx.rect(p.cx + (i * 6 + c) * s, p.cy + row * s, s, s);
      }
    }
    ctx.fill();
  }

  // Draw every current primitive back to front. `tiles` (optional) limits
  // drawing to the damaged 16x16 groups, the canvas version of incremental.
  function draw(ctx, eng, tiles) {
    var prims = eng.prims, T = eng.T, i;
    ctx.save();
    if (tiles) {
      ctx.beginPath();
      for (i = 0; i < tiles.length; i++) {
        var ti = tiles[i], tx = ti % eng.tw, ty = (ti / eng.tw) | 0;
        ctx.rect(tx * T, ty * T, T, T);
      }
      ctx.clip();
    }
    for (i = 0; i < prims.length; i++) {
      var p = prims[i];
      if (p.alpha <= 0) continue;
      ctx.globalCompositeOperation = OP[p.blend];
      switch (p.type) {
        case 1:
          ctx.fillStyle = paint(ctx, p, p.alpha);
          ctx.fillRect(p.bx0, p.by0, p.bx1 - p.bx0, p.by1 - p.by0);
          if (p.fxKey === 'grid') grid(ctx, p);
          break;
        case 2: {
          var pts = p.pts;
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          for (var j = 2; j < pts.length; j += 2) ctx.lineTo(pts[j], pts[j + 1]);
          ctx.closePath();
          ctx.fillStyle = paint(ctx, p, p.alpha);
          ctx.fill();
          break;
        }
        case 3: ellipse(ctx, p); break;
        case 4:
          ctx.beginPath();
          ctx.roundRect(p.cx - p.rx, p.cy - p.ry, 2 * p.rx, 2 * p.ry, p.rad);
          ctx.fillStyle = paint(ctx, p, p.alpha);
          ctx.fill();
          break;
        default: text(ctx, p);
      }
    }
    ctx.restore();
  }

  return { draw: draw };
}));
