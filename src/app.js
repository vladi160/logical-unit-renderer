/* Page glue: runs the engine, shows the debug views, draws the vector graph,
 * traces a unit up its vector, and runs the benchmark. */
(function () {
  'use strict';
  var LPU = window.LPU, Scene = window.LPUScene;
  function $(id) { return document.getElementById(id); }

  var canvas = $('scene'), overlay = $('overlay'), sparkEl = $('spark'), svg = $('graph');
  var ctx = canvas.getContext('2d', { alpha: false }), octx = overlay.getContext('2d');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var RES = { '480x300': [480, 300], '800x500': [800, 500], '1280x800': [1280, 800], '1920x1200': [1920, 1200] };
  var ui = { mode: 'incremental', view: 'image', aa: true, rotate: !reduceMotion, tapTrace: false, res: null };
  var eng, scene, img, dbg, dbg32, graph, needFull = true, traceHit = null, benchRunning = false;
  var hist = { units: [], nodes: [], cut: [], tiles: [], ms: [], logic: [], unitsMs: [] }, share = [];
  var nf = new Intl.NumberFormat('en-US');

  // ---------------------------------------------------------------- setup
  function build(res) {
    ui.res = res;
    var W = RES[res][0], H = RES[res][1];
    canvas.width = W; canvas.height = H; overlay.width = W; overlay.height = H;
    img = ctx.createImageData(W, H);
    dbg = ctx.createImageData(W, H);
    dbg32 = new Uint32Array(dbg.data.buffer);
    eng = new LPU.Engine(W, H, { buffer: new Uint32Array(img.data.buffer), aa: ui.aa });
    eng.full = ui.mode === 'full';
    scene = Scene.create(eng, { autoRotate: ui.rotate, seed: 7 });
    needFull = true; traceHit = null; share.length = 0;
    for (var k in hist) hist[k].length = 0;
    graph = buildGraph(eng);
    $('benchRes').textContent = W + '×' + H;
    clearTrace();
  }

  // --------------------------------------------------------------- pointer
  function toUnits(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * eng.W, y: (e.clientY - r.top) / r.height * eng.H };
  }
  canvas.addEventListener('pointerdown', function (e) {
    var p = toUnits(e);
    if (ui.tapTrace) { traceAt(p); return; }
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not critical */ }
    eng.emit({ type: 'down', x: p.x, y: p.y });
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = toUnits(e);
    if (!ui.tapTrace) eng.emit({ type: 'move', x: p.x, y: p.y });
    if (e.pointerType === 'mouse' || ui.tapTrace) traceAt(p);
  });
  canvas.addEventListener('pointerup', function (e) {
    var p = toUnits(e);
    if (!ui.tapTrace) eng.emit({ type: 'up', x: p.x, y: p.y });
  });
  canvas.addEventListener('pointercancel', function () { eng.emit({ type: 'cancel', x: -1, y: -1 }); });
  canvas.addEventListener('pointerleave', function (e) {
    if (e.pointerType !== 'mouse') return;
    eng.emit({ type: 'leave', x: -1, y: -1 });
    if (!ui.tapTrace) clearTrace();
  });
  document.addEventListener('keydown', function (e) {
    if (e.target && /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
    if (e.key === 'b' || e.key === 'B') scene.boom();
    if (e.key === 'j' || e.key === 'J') scene.jump();
  });

  // ---------------------------------------------------------------- trace
  var SHORT = { 'BOOM button': 'BOOM', 'JUMP button': 'JUMP' };
  function label(n) { return n.meta.group || SHORT[n.name] || n.name; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function traceAt(p) {
    var hit = eng.unitAt(p.x, p.y);
    if (!hit || !hit.node) { clearTrace(); return; }
    traceHit = hit;
    var chain = eng.trace(hit.node).sort(function (a, b) { return a.id - b.id; }), levels = { 1: [], 2: [], 3: [] };
    chain.forEach(function (n) {
      if (n.kind === 'units' || !levels[n.level]) return;
      var l = label(n);
      if (levels[n.level].indexOf(l) < 0) levels[n.level].push(l);
    });
    var own = label(hit.node);
    if (hit.node.name === 'Debris pieces') own = 'Debris piece ' + (hit.index + 1);
    var html = '<span class="tr-unit">Unit ' + hit.x + ',' + hit.y + '</span>' +
      '<span class="tr-arrow" aria-hidden="true">→</span><span class="tr-lv" style="--lc:var(--l1)">L1</span><span class="tr-names">' + esc(own) +
      (hit.node.meta.connector ? ' <em>(connector)</em>' : '') + '</span>';
    [2, 3].forEach(function (lv) {
      if (!levels[lv].length) return;
      html += '<span class="tr-arrow" aria-hidden="true">→</span><span class="tr-lv" style="--lc:var(--l' + lv + ')">L' + lv + '</span><span class="tr-names">' +
        levels[lv].map(esc).join(' · ') + '</span>';
    });
    $('trace').innerHTML = html;
    graph.setTraced(chain);
  }
  function clearTrace() {
    traceHit = null;
    $('trace').innerHTML = '<span class="tr-hint">' + (ui.tapTrace ? 'Tap the scene to trace a unit up its vector.' : 'Hover the scene to trace a unit up its vector. Drag the cube or the light, press the buttons.') + '</span>';
    if (graph) graph.setTraced(null);
  }

  // ---------------------------------------------------------------- views
  var idCache = new Map();
  function hsl(h, s, l) {
    function f(n) { var k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }
    return (0xFF000000 | (Math.round(f(4) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(0) * 255)) >>> 0;
  }
  function idColor(uid) {
    var c = idCache.get(uid);
    if (c === undefined) {
      if (uid < 0) c = 0xFF000000;
      else {
        var node = uid >> LPU.UID_SHIFT, idx = uid & LPU.UID_MASK;
        c = hsl((node * 0.61803398875 + idx * 0.0917) % 1, 0.58, 0.60);
      }
      idCache.set(uid, c);
    }
    return c;
  }
  function viewVectors() {
    var own = eng.own, W = eng.W, N = eng.N;
    for (var i = 0; i < N; i++) {
      var u = own[i], c = idColor(u);
      if ((i % W !== 0 && own[i - 1] !== u) || (i >= W && own[i - W] !== u)) {
        c = (0xFF000000 | ((((c >> 16) & 255) * 0.45) << 16) | ((((c >> 8) & 255) * 0.45) << 8) | ((c & 255) * 0.45)) >>> 0;
      }
      dbg32[i] = c;
    }
  }
  function viewRecomputed() {
    var fb = eng.fb, st = eng.stamp, f = eng.frame, N = eng.N;
    for (var i = 0; i < N; i++) {
      var c = fb[i];
      var y = ((c & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + ((c >> 16) & 255) * 0.11) * 0.38 + 16;
      var r = y, g = y, b = y, age = f - st[i];
      if (age < 30) {
        var t = 1 - age / 30; t *= t;
        r += (255 - r) * t; g += (122 - g) * t; b += (48 - b) * t;
      }
      dbg32[i] = (0xFF000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)) >>> 0;
    }
  }

  function present() {
    if (ui.view === 'image') {
      if (needFull) { ctx.putImageData(img, 0, 0); needFull = false; }
      else if (eng.blit) ctx.putImageData(img, 0, 0, eng.blit.x, eng.blit.y, eng.blit.w, eng.blit.h);
    } else {
      if (ui.view === 'vectors') viewVectors(); else viewRecomputed();
      ctx.putImageData(dbg, 0, 0);
      needFull = true;
    }
    drawOverlay();
  }

  function drawOverlay() {
    var W = eng.W, H = eng.H, s = W / 800;
    octx.clearRect(0, 0, W, H);
    if (ui.view === 'recomputed') {
      var T = eng.T, G = eng.G, x, y;
      octx.lineWidth = Math.max(1, s);
      octx.strokeStyle = 'rgba(255,255,255,0.07)';
      octx.beginPath();
      for (x = T; x < W; x += T) { octx.moveTo(x, 0); octx.lineTo(x, H); }
      for (y = T; y < H; y += T) { octx.moveTo(0, y); octx.lineTo(W, y); }
      octx.stroke();
      octx.strokeStyle = 'rgba(255,255,255,0.2)';
      octx.beginPath();
      for (x = T * G; x < W; x += T * G) { octx.moveTo(x, 0); octx.lineTo(x, H); }
      for (y = T * G; y < H; y += T * G) { octx.moveTo(0, y); octx.lineTo(W, y); }
      octx.stroke();
      octx.strokeStyle = 'rgba(255,150,70,0.9)';
      for (var ty = 0; ty < eng.th; ty++) {
        for (var tx = 0; tx < eng.tw; tx++) {
          if (eng.tileStamp[ty * eng.tw + tx] === eng.frame) octx.strokeRect(tx * T + 0.5, ty * T + 0.5, T - 1, T - 1);
        }
      }
    }
    if (traceHit && traceHit.prim) {
      var p = traceHit.prim;
      octx.setLineDash([5 * s, 4 * s]);
      octx.lineWidth = 1.5 * s;
      octx.strokeStyle = 'rgba(255,255,255,0.9)';
      octx.strokeRect(Math.max(0, p.bx0), Math.max(0, p.by0), Math.min(W, p.bx1) - Math.max(0, p.bx0), Math.min(H, p.by1) - Math.max(0, p.by0));
      octx.setLineDash([]);
      octx.fillStyle = 'rgba(255,255,255,0.95)';
      octx.fillRect(traceHit.x - 3 * s, traceHit.y - 0.5 * s, 7 * s, 1.5 * s);
      octx.fillRect(traceHit.x - 0.5 * s, traceHit.y - 3 * s, 1.5 * s, 7 * s);
    }
  }

  // ----------------------------------------------------------- vector graph
  var SVGNS = 'http://www.w3.org/2000/svg';
  function el(name, attrs, parent) {
    var e = document.createElementNS(SVGNS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  var ORDER = { 3: ['Input', 'Highlight', 'Light drag', 'Spin', 'Gravity', 'Explode', 'Debris motion', 'Clock'] };
  var LEVEL_NAME = { 3: 'L3 rules', 2: 'L2 objects', 1: 'L1 regions', 0: 'L0 units' };

  function buildGraph(eng) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var cols = { 3: [], 2: [], 1: [], 0: [] }, byKey = {}, map = new Map(), all = [];
    eng.nodes.forEach(function (n) {
      var name = n.meta.group || n.name, id = n.level + ':' + name, d = byKey[id];
      if (!d) { d = byKey[id] = { key: name, level: n.level, members: [], s: '', traced: false }; cols[n.level].push(d); all.push(d); }
      d.members.push(n); map.set(n, d);
    });
    if (ORDER[3]) cols[3].sort(function (a, b) { return ORDER[3].indexOf(a.key) - ORDER[3].indexOf(b.key); });
    var BW = 96, BH = 21, GAP = 27, X = { 3: 18, 2: 122, 1: 226, 0: 330 }, TOP = 30;
    var rowsMax = Math.max(cols[3].length, cols[2].length, cols[1].length);
    var VH = TOP + rowsMax * GAP + 24, VW = 430;
    svg.setAttribute('viewBox', '0 0 ' + VW + ' ' + VH);
    [3, 2, 1, 0].forEach(function (lv) {
      el('text', { x: X[lv], y: 14, 'class': 'gh', style: '--lc:var(--l' + lv + ')' }, svg).textContent = LEVEL_NAME[lv];
      cols[lv].forEach(function (d, i) {
        d.x = X[lv]; d.y = lv === 0 ? TOP + ((cols[1].length - 1) * GAP) / 2 : TOP + i * GAP;
      });
    });
    var edgeLayer = el('g', {}, svg), nodeLayer = el('g', {}, svg), edges = [], seen = {};
    function addEdge(a, b, cls, srcNode) {
      var id = a.key + '>' + b.key;
      if (a === b || seen[id]) return;
      seen[id] = 1;
      var d, x1, y1 = a.y + BH / 2, x2, y2 = b.y + BH / 2;
      if (a.x < b.x) { x1 = a.x + BW; x2 = b.x; d = 'M' + x1 + ',' + y1 + ' C' + (x1 + 22) + ',' + y1 + ' ' + (x2 - 22) + ',' + y2 + ' ' + x2 + ',' + y2; }
      else if (a.x > b.x) { x1 = a.x; x2 = b.x + BW; d = 'M' + x1 + ',' + y1 + ' C' + (x1 - 26) + ',' + y1 + ' ' + (x2 + 26) + ',' + y2 + ' ' + x2 + ',' + y2; cls += ' back'; }
      else { x1 = a.x; var bulge = 10 + Math.abs(y2 - y1) * 0.12; d = 'M' + x1 + ',' + y1 + ' C' + (x1 - bulge) + ',' + y1 + ' ' + (x1 - bulge) + ',' + y2 + ' ' + x1 + ',' + y2; }
      var path = el('path', { d: d, 'class': 'ge ' + cls, style: '--lc:var(--l' + a.level + ')' }, edgeLayer);
      edges.push({ el: path, src: a, on: false });
    }
    eng.nodes.forEach(function (n) {
      n.outputs.forEach(function (o) { addEdge(map.get(n), map.get(o), ''); });
    });
    // Return path: input travels from the units back up to the Input rule.
    var u = map.get(eng.unitsNode), inp = byKey['3:Input'];
    if (u && inp) {
      var ry = VH - 8;
      el('path', { d: 'M' + (u.x + BW / 2) + ',' + (u.y + BH) + ' L' + (u.x + BW / 2) + ',' + ry + ' L8,' + ry + ' L8,' + (inp.y + BH / 2) + ' L' + inp.x + ',' + (inp.y + BH / 2),
        'class': 'ge ret' }, edgeLayer);
      el('text', { x: (u.x + BW / 2) - 4, y: ry - 4, 'class': 'gr', 'text-anchor': 'end' }, svg).textContent = 'input goes back up the same vector';
    }
    all.forEach(function (d) {
      var g = el('g', { 'class': 'gn', style: '--lc:var(--l' + d.level + ')' }, nodeLayer);
      var n = d.members.length, lab = (SHORT[d.key] || d.key) + (n > 1 ? ' ×' + n : '');
      var title = el('title', {}, g);
      var m0 = d.members[0];
      title.textContent = lab + (m0.meta.desc ? ': ' + m0.meta.desc : '');
      el('rect', { x: d.x, y: d.y, width: BW, height: BH, rx: 4 }, g);
      el('text', { x: d.x + 6, y: d.y + 14.5 }, g).textContent = lab;
      d.g = g;
      d.isClock = d.key === 'Clock';
    });
    return {
      update: function (frame) {
        for (var i = 0; i < all.length; i++) {
          var d = all[i], s = '';
          if (!d.isClock) {
            for (var j = 0; j < d.members.length; j++) {
              var m = d.members[j];
              if (frame - m.changeFrame < 6) { s = 'hot'; break; }
              if (frame - m.evalFrame < 6) s = 'cut';
            }
          }
          if (s !== d.s) { d.s = s; d.g.setAttribute('data-s', s); }
        }
        for (i = 0; i < edges.length; i++) {
          var e = edges[i], on = e.src.s === 'hot';
          if (on !== e.on) { e.on = on; e.el.classList.toggle('hot', on); }
        }
      },
      setTraced: function (chain) {
        var set = new Set();
        if (chain) chain.forEach(function (n) { set.add(map.get(n)); });
        all.forEach(function (d) {
          var t = set.has(d);
          if (t !== d.traced) { d.traced = t; d.g.classList.toggle('traced', t); }
        });
      }
    };
  }

  // ------------------------------------------------------------- readouts
  function push(arr, v, n) { arr.push(v); if (arr.length > n) arr.shift(); }
  function avg(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return arr.length ? s / arr.length : 0; }
  function readouts() {
    var N = eng.N, units = avg(hist.units);
    $('rUnits').textContent = nf.format(Math.round(units));
    $('rUnitsSub').textContent = (100 * units / N).toFixed(1) + '% of ' + nf.format(N);
    $('rNodes').textContent = avg(hist.nodes).toFixed(1);
    $('rNodesSub').textContent = 'of ' + eng.evaluableCount() + ' · ' + avg(hist.cut).toFixed(1) + ' stopped early';
    $('rTiles').textContent = nf.format(Math.round(avg(hist.tiles)));
    $('rTilesSub').textContent = 'of ' + nf.format(eng.tw * eng.th) + ' · ' + eng.T + '×' + eng.T + ' units each';
    $('rMs').textContent = avg(hist.ms).toFixed(2) + ' ms';
    $('rMsSub').textContent = 'rules + nodes ' + avg(hist.logic).toFixed(2) + ' · units ' + avg(hist.unitsMs).toFixed(2);
    drawSpark();
  }
  function drawSpark() {
    var dpr = window.devicePixelRatio || 1, w = sparkEl.clientWidth, h = sparkEl.clientHeight;
    if (!w || !h) return;
    if (sparkEl.width !== Math.round(w * dpr)) { sparkEl.width = Math.round(w * dpr); sparkEl.height = Math.round(h * dpr); }
    var c = sparkEl.getContext('2d'), cs = getComputedStyle(document.documentElement);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.strokeStyle = cs.getPropertyValue('--rule').trim();
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, 2.5); c.lineTo(w, 2.5); c.moveTo(0, h - 0.5); c.lineTo(w, h - 0.5); c.stroke();
    var n = 180, top = 3, bot = h - 1, x0 = w - share.length * (w / n);
    if (!share.length) return;
    var col = cs.getPropertyValue('--signal').trim();
    c.beginPath();
    c.moveTo(x0, bot);
    for (var i = 0; i < share.length; i++) c.lineTo(x0 + i * (w / n), bot - share[i] * (bot - top));
    c.lineTo(x0 + (share.length - 1) * (w / n), bot);
    c.closePath();
    c.globalAlpha = 0.16; c.fillStyle = col; c.fill(); c.globalAlpha = 1;
    c.beginPath();
    for (i = 0; i < share.length; i++) {
      var X = x0 + i * (w / n), Y = bot - share[i] * (bot - top);
      if (i) c.lineTo(X, Y); else c.moveTo(X, Y);
    }
    c.strokeStyle = col; c.lineWidth = 1.5; c.stroke();
    var last = share[share.length - 1];
    c.fillStyle = col;
    c.beginPath(); c.arc(x0 + (share.length - 1) * (w / n), bot - last * (bot - top), 2.5, 0, 6.3); c.fill();
  }

  // ------------------------------------------------------------------ loop
  var last = performance.now(), frameNo = 0;
  function frame(t) {
    var dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
    last = t;
    if (!benchRunning) {
      eng.full = ui.mode === 'full';
      var st = eng.tick(dt);
      present();
      canvas.style.cursor = ui.tapTrace ? 'crosshair' : scene.cursor();
      push(hist.units, st.units, 12); push(hist.nodes, st.nodesEvaluated, 12); push(hist.cut, st.cutoffs, 12);
      push(hist.tiles, st.tiles, 12); push(hist.ms, st.ms, 12); push(hist.logic, st.msLogic, 12); push(hist.unitsMs, st.msUnits, 12);
      push(share, st.units / eng.N, 180);
      graph.update(eng.frame);
      if (++frameNo % 6 === 0) readouts();
    }
    requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------- controls
  function setPressed(groupSel, attr, val) {
    document.querySelectorAll(groupSel).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute(attr) === val)); });
  }
  document.querySelectorAll('[data-mode]').forEach(function (b) {
    b.addEventListener('click', function () { ui.mode = b.getAttribute('data-mode'); setPressed('[data-mode]', 'data-mode', ui.mode); });
  });
  document.querySelectorAll('[data-view]').forEach(function (b) {
    b.addEventListener('click', function () { ui.view = b.getAttribute('data-view'); needFull = true; setPressed('[data-view]', 'data-view', ui.view); });
  });
  $('optRotate').checked = ui.rotate;
  $('optRotate').addEventListener('change', function (e) { ui.rotate = e.target.checked; scene.setAutoRotate(ui.rotate); });
  $('optAA').addEventListener('change', function (e) { ui.aa = e.target.checked; eng.aa = ui.aa; eng.damageAll(); });
  $('optTrace').addEventListener('change', function (e) { ui.tapTrace = e.target.checked; clearTrace(); });
  $('optRes').addEventListener('change', function (e) { build(e.target.value); });

  // ------------------------------------------------------------- benchmark
  function renderBench(rows, sourceText) {
    var maxMs = 0;
    rows.forEach(function (r) { maxMs = Math.max(maxMs, r.fullMs, r.incMs); });
    $('benchBody').innerHTML = rows.map(function (r) {
      var ratio = r.speedup > 100 ? 'over 100×' : r.speedup.toFixed(1) + '×';
      var tone = r.speedup >= 2 ? 'good' : r.speedup >= 1.2 ? 'mid' : 'none';
      return '<tr><th scope="row">' + esc(r.name) + '</th>' +
        '<td class="num">' + (r.share * 100).toFixed(1) + '%</td>' +
        '<td class="num">' + r.incMs.toFixed(2) + '</td>' +
        '<td class="num">' + r.fullMs.toFixed(2) + '</td>' +
        '<td class="bars" aria-hidden="true"><span class="bar full" style="width:' + (100 * r.fullMs / maxMs).toFixed(1) + '%"></span>' +
        '<span class="bar inc" style="width:' + Math.max(0.6, 100 * r.incMs / maxMs).toFixed(1) + '%"></span></td>' +
        '<td class="num"><span class="pill ' + tone + '">' + ratio + '</span></td></tr>';
    }).join('');
    if (sourceText) $('benchSource').textContent = sourceText;
  }
  $('benchRun').addEventListener('click', function () {
    if (benchRunning) return;
    benchRunning = true;
    var btn = $('benchRun'), W = eng.W, H = eng.H, rows = [];
    btn.disabled = true; btn.textContent = 'Running…';
    $('benchSource').textContent = 'Running in this browser at ' + W + '×' + H + '. The live scene pauses meanwhile.';
    var it = Scene.benchmark(W, H, { frames: 60, repeats: 2 });
    function step() {
      var r = it.next();
      if (r.done) {
        benchRunning = false; btn.disabled = false; btn.textContent = 'Run again';
        renderBench(rows, 'Measured in this browser at ' + W + '×' + H + ', 60 frames per scenario, best of 2 runs, single thread.');
        return;
      }
      if (r.value) { rows.push(r.value); renderBench(rows); }
      setTimeout(step, 16);
    }
    setTimeout(step, 50);
  });

  // ------------------------------------------------------------------ start
  var start = defaultRes();
  function defaultRes() { return Math.min(window.innerWidth || 1024, (window.screen && window.screen.width) || 9999) < 720 ? '480x300' : '800x500'; }
  $('optRes').value = start;
  build(start);
  renderBench(window.LPU_BENCH_DEFAULT || [], null);
  requestAnimationFrame(function (t) { last = t; frame(t); });
})();
