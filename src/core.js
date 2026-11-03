/* LPU core: logical spatial units, vectors, nodes, levels.
 *
 *   L0  units   One per screen position. A unit holds its final color and
 *               exactly ONE vector: an integer pointing at the region
 *               primitive that decides its color. The same vector carries
 *               input (a click on that position) back up the graph.
 *   L1+ nodes   Pure functions joined by vectors (inputs -> output).
 *               A node with two or more inputs is a connector.
 *               Levels are bands of nodes; a vector may skip levels.
 *   change      States change only inside rules (L3). A change marks the
 *               nodes that read it as dirty. A node whose output did not
 *               change stops the chain (early cutoff). A region whose output
 *               did change damages the screen groups (tiles) it touched, and
 *               only units inside damaged groups are recomputed.
 *
 * The core has no notion of 3D: no xyz space, no camera, no matrices and no
 * physics. The only geometry it knows is the 2D coverage of a screen position.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LPU = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PRIM = { RECT: 1, POLY: 2, ELLIPSE: 3, RRECT: 4, TEXT: 5 };
  var BLEND = { normal: 0, multiply: 1, add: 2 };
  var KIND = { STATE: 'state', DERIVED: 'derived', REGION: 'region', RULE: 'rule', UNITS: 'units' };
  var UID_SHIFT = 8;                 // uid = nodeId << 8 | primitive index
  var UID_MASK = (1 << UID_SHIFT) - 1;

  var now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  // 5x7 pixel font. Each row is 5 bits, most significant bit = left column.
  var FONT = {
    ' ': [0, 0, 0, 0, 0, 0, 0],
    'B': [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
    'D': [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
    'E': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
    'J': [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
    'M': [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
    'O': [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
    'P': [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
    'R': [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
    'S': [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
    'T': [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E]
  };

  // ---------------------------------------------------------------------------
  // Primitives: small 2D pixel programs. For any screen position a primitive
  // answers two questions: how much of this unit do I cover (0..1), and which
  // color do I give it. Every primitive has the same fields so the per-unit
  // loop stays monomorphic.
  // ---------------------------------------------------------------------------
  function Prim(type) {
    this.type = type;
    this.z = 0; this.zOff = 0; this.seq = 0;
    this.blend = 0; this.alpha = 1;
    this.crisp = true;          // hard edge that edge blending may soften
    this.ownable = true;        // may become the target of a unit's vector
    this.opaqueFull = false;    // covers its whole box with an opaque color
    this.bx0 = 0; this.by0 = 0; this.bx1 = 0; this.by1 = 0;
    this.r0 = 0; this.g0 = 0; this.b0 = 0;
    this.r1 = 0; this.g1 = 0; this.b1 = 0;
    this.grad = false; this.gx = 0; this.gy = 0; this.gdx = 0; this.gdy = 0;
    this.cx = 0; this.cy = 0; this.rx = 1; this.ry = 1; this.rad = 0;
    this.soft = 1; this.pow2 = false; this.dil = 0;
    this.edges = null; this.ne = 0;
    this.glyphs = null; this.scale = 1;
    this.fx = null; this.fxData = null; this.fxKey = '';
    this.pts = null; this.g = null;     // source geometry for other backends
    this.uid = -1;
    this.sig = '';
  }

  function q(v) { return Math.round(v * 100); }
  function qa(a) { var s = ''; for (var i = 0; i < a.length; i++) s += q(a[i]) + ','; return s; }

  function applyCommon(p, o) {
    p.alpha = o.alpha == null ? 1 : o.alpha;
    p.blend = typeof o.blend === 'string' ? BLEND[o.blend] : (o.blend || 0);
    p.zOff = o.zOff || 0;
    if (o.ownable === false) p.ownable = false;
    if (o.fx) { p.fx = o.fx; p.fxData = o.fxData || null; }
  }
  function setColors(p, c0, c1) {
    p.r0 = c0[0]; p.g0 = c0[1]; p.b0 = c0[2];
    var d = c1 || c0;
    p.r1 = d[0]; p.g1 = d[1]; p.b1 = d[2];
  }
  function setGradient(p, g) {          // g = [x0, y0, x1, y1]
    var dx = g[2] - g[0], dy = g[3] - g[1], l2 = dx * dx + dy * dy;
    if (l2 < 1e-9) return;
    p.grad = true; p.gx = g[0]; p.gy = g[1]; p.gdx = dx / l2; p.gdy = dy / l2;
  }
  function tail(p, o) {
    return '|' + qa([p.r0, p.g0, p.b0, p.r1, p.g1, p.b1, p.alpha, p.blend, p.zOff]) +
      (p.grad ? qa([p.gx, p.gy, p.gdx * 1e4, p.gdy * 1e4]) : '') + (o.key || '');
  }

  // Axis-aligned rectangle, optional gradient (vertical by default).
  function rect(x0, y0, x1, y1, c0, c1, o) {
    o = o || {};
    var p = new Prim(PRIM.RECT);
    p.bx0 = x0; p.by0 = y0; p.bx1 = x1; p.by1 = y1;
    setColors(p, c0, c1);
    if (c1) { p.g = o.grad || [0, y0, 0, y1]; setGradient(p, p.g); }
    applyCommon(p, o);
    p.fxKey = o.key || '';
    p.crisp = false;
    p.opaqueFull = p.alpha >= 1 && p.blend === 0;
    p.sig = 'R' + qa([x0, y0, x1, y1]) + tail(p, o);
    return p;
  }

  // Convex polygon given as a flat [x0, y0, x1, y1, ...] list.
  function poly(pts, c0, o) {
    o = o || {};
    var n = pts.length >> 1;
    if (n < 3) return null;
    var area = 0, mx = 0, my = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, i;
    for (i = 0; i < n; i++) {
      var ax = pts[2 * i], ay = pts[2 * i + 1], j = (i + 1) % n;
      area += ax * pts[2 * j + 1] - pts[2 * j] * ay;
      mx += ax; my += ay;
      if (ax < minx) minx = ax; if (ax > maxx) maxx = ax;
      if (ay < miny) miny = ay; if (ay > maxy) maxy = ay;
    }
    if (Math.abs(area) < 1) return null;
    mx /= n; my /= n;
    var p = new Prim(PRIM.POLY);
    var e = new Float64Array(n * 3);
    for (i = 0; i < n; i++) {
      var x0 = pts[2 * i], y0 = pts[2 * i + 1], k = (i + 1) % n;
      var dx = pts[2 * k] - x0, dy = pts[2 * k + 1] - y0, len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) { e[3 * i] = 0; e[3 * i + 1] = 0; e[3 * i + 2] = -1e9; continue; }
      var nx = dy / len, ny = -dx / len;
      if (nx * (mx - x0) + ny * (my - y0) < 0) { nx = -nx; ny = -ny; }
      e[3 * i] = nx; e[3 * i + 1] = ny; e[3 * i + 2] = nx * x0 + ny * y0;
    }
    p.edges = e; p.ne = n; p.pts = pts;
    p.dil = o.dil || 0;
    p.bx0 = minx - 1.5; p.by0 = miny - 1.5; p.bx1 = maxx + 1.5; p.by1 = maxy + 1.5;
    setColors(p, c0, o.c1);
    if (o.c1 && o.grad) { p.g = o.grad; setGradient(p, p.g); }
    applyCommon(p, o);
    p.sig = 'P' + qa(pts) + q(p.dil) + tail(p, o);
    return p;
  }

  // Ellipse. soft = width of the soft rim as a fraction of the radius.
  function ellipse(cx, cy, rx, ry, c0, o) {
    o = o || {};
    if (rx < 0.3 || ry < 0.3) return null;
    var p = new Prim(PRIM.ELLIPSE);
    p.cx = cx; p.cy = cy; p.rx = rx; p.ry = ry;
    var hard = 1.25 / Math.min(rx, ry);
    p.soft = Math.max(o.soft || 0, hard);
    p.crisp = !(o.soft > 0);
    p.pow2 = !!o.pow2;
    p.bx0 = cx - rx - 1; p.by0 = cy - ry - 1; p.bx1 = cx + rx + 1; p.by1 = cy + ry + 1;
    setColors(p, c0, null);
    applyCommon(p, o);
    p.sig = 'E' + qa([cx, cy, rx, ry, p.soft * 100]) + (p.pow2 ? 'p' : '') + tail(p, o);
    return p;
  }

  // Rounded rectangle with a vertical gradient; soft > 1 blurs the edge inward.
  function rrect(x0, y0, x1, y1, rad, c0, c1, o) {
    o = o || {};
    var p = new Prim(PRIM.RRECT);
    p.cx = (x0 + x1) / 2; p.cy = (y0 + y1) / 2; p.rx = (x1 - x0) / 2; p.ry = (y1 - y0) / 2;
    p.rad = Math.min(rad, p.rx, p.ry);
    p.soft = Math.max(1, o.soft || 1);
    p.crisp = p.soft <= 1;
    p.bx0 = x0 - 1; p.by0 = y0 - 1; p.bx1 = x1 + 1; p.by1 = y1 + 1;
    setColors(p, c0, c1);
    if (c1) { p.g = [0, y0, 0, y1]; setGradient(p, p.g); }
    applyCommon(p, o);
    p.sig = 'Q' + qa([x0, y0, x1, y1, p.rad, p.soft]) + tail(p, o);
    return p;
  }

  // Bitmap text in the 5x7 font, top-left at (x, y), integer scale.
  function text(x, y, scale, str, c0, o) {
    o = o || {};
    var p = new Prim(PRIM.TEXT);
    var glyphs = [];
    for (var i = 0; i < str.length; i++) glyphs.push(FONT[str[i]] || FONT[' ']);
    p.glyphs = glyphs; p.scale = scale; p.cx = x; p.cy = y;
    p.bx0 = x; p.by0 = y; p.bx1 = x + textWidth(str, scale); p.by1 = y + 7 * scale;
    setColors(p, c0, null);
    applyCommon(p, o);
    p.sig = 'T' + str + qa([x, y, scale]) + tail(p, o);
    return p;
  }
  function textWidth(str, scale) { return (str.length * 6 - 1) * scale; }

  // ---------------------------------------------------------------------------
  // Graph
  // ---------------------------------------------------------------------------
  function Node(name, level, kind) {
    this.id = -1; this.name = name; this.level = level; this.kind = kind;
    this.inputs = []; this.outputs = []; this.writers = []; this.up = [];
    this.value = null; this.fn = null; this.run = null; this.inbox = null;
    this.dirty = true; this.version = 0;
    this.evalFrame = -1; this.changeFrame = -1; this.evalCount = 0;
    this.meta = {};
  }

  function shallowSame(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (a.sig !== undefined && b.sig !== undefined) return a.sig === b.sig;
    var k;
    for (k in a) if (a[k] !== b[k]) return false;
    for (k in b) if (!(k in a)) return false;
    return true;
  }

  function Engine(W, H, opts) {
    opts = opts || {};
    this.W = W; this.H = H; this.N = W * H;
    this.T = opts.tile || 16;           // units per group side (L0 groups)
    this.G = opts.group || 4;           // groups per super-group side
    this.fb = opts.buffer || new Uint32Array(this.N);   // final colors
    this.own = new Int32Array(this.N);                  // the one vector per unit
    this.own.fill(-1);
    this.stamp = new Uint32Array(this.N);               // frame of last recompute
    this.tw = Math.ceil(W / this.T); this.th = Math.ceil(H / this.T);
    this.tileDirty = new Uint8Array(this.tw * this.th);
    this.tileStamp = new Uint32Array(this.tw * this.th);
    this.sw = Math.ceil(this.tw / this.G); this.sh = Math.ceil(this.th / this.G);
    this.superDirty = new Uint8Array(this.sw * this.sh);
    this.nodes = []; this.rules = []; this.prims = []; this._primsStale = true;
    this.frame = 0; this.time = 0;
    this.aa = opts.aa !== false;        // edge-blending connector on/off
    this.full = false;                  // true = recompute everything every frame
    this.raster = opts.raster !== false;  // false = run the graph and damage, but let another backend draw
    this.dirtyList = [];                // groups damaged this frame (tile indices)
    this.events = [];
    this.blit = null;
    this._cand = new Array(256); this._col = new Float64Array(3); this._args = [];
    this.stats = { nodesEvaluated: 0, cutoffs: 0, rulesRun: 0, units: 0, tiles: 0, supers: 0, ms: 0, msLogic: 0, msUnits: 0 };
    this.unitsNode = this._add(new Node('Units', 0, KIND.UNITS));
    this.unitsNode.meta = { desc: 'one per screen position: a color and one vector' };
    this.clock = this.state('Clock', 3, 0, { desc: 'time step for rules' });
    this.damageAll();
  }

  Engine.prototype._add = function (node) { node.id = this.nodes.length; this.nodes.push(node); return node; };

  // Nodes that can be evaluated (pure functions and regions); states and rules are not.
  Engine.prototype.evaluableCount = function () {
    var c = 0;
    for (var i = 0; i < this.nodes.length; i++) if (this.nodes[i].kind === KIND.DERIVED || this.nodes[i].kind === KIND.REGION) c++;
    return c;
  };

  // A vector: a plain input/output link between two nodes. It carries no logic.
  Engine.prototype.vector = function (from, to) {
    if (from.outputs.indexOf(to) < 0) from.outputs.push(to);
    if (to.inputs.indexOf(from) < 0) to.inputs.push(from);
  };
  // An upward vector used only to route input (units -> input rule).
  Engine.prototype.upVector = function (from, to) { if (from.up.indexOf(to) < 0) from.up.push(to); };

  Engine.prototype.state = function (name, level, value, meta) {
    var n = this._add(new Node(name, level, KIND.STATE)), eng = this;
    n.value = value; n.meta = meta || {}; n.dirty = false;
    n.set = function (v) { return eng._set(n, v); };
    return n;
  };
  Engine.prototype.derive = function (name, level, inputs, fn, meta) {
    var n = this._add(new Node(name, level, KIND.DERIVED));
    n.fn = fn; n.meta = meta || {};
    for (var i = 0; i < inputs.length; i++) this.vector(inputs[i], n);
    return n;
  };
  Engine.prototype.region = function (name, inputs, fn, meta) {
    var n = this._add(new Node(name, 1, KIND.REGION));
    n.fn = fn; n.value = []; n.meta = meta || {};
    if (n.meta.z == null) n.meta.z = 0;
    for (var i = 0; i < inputs.length; i++) this.vector(inputs[i], n);
    this.vector(n, this.unitsNode);
    return n;
  };
  Engine.prototype.rule = function (name, inputs, outputs, run, meta) {
    var n = this._add(new Node(name, 3, KIND.RULE)), i;
    n.run = run; n.meta = meta || {}; n.inbox = []; n.dirty = false;
    for (i = 0; i < inputs.length; i++) this.vector(inputs[i], n);
    for (i = 0; i < outputs.length; i++) { this.vector(n, outputs[i]); outputs[i].writers.push(n); }
    this.rules.push(n);
    return n;
  };

  Engine.prototype._markOutputs = function (node) {
    var o = node.outputs;
    for (var i = 0; i < o.length; i++) {
      var k = o[i].kind;
      if (k === KIND.DERIVED || k === KIND.REGION) o[i].dirty = true;
    }
  };
  Engine.prototype._set = function (node, v) {
    if (shallowSame(node.value, v)) return false;
    node.value = v; node.version++; node.changeFrame = this.frame;
    this._markOutputs(node);
    return true;
  };

  Engine.prototype.emit = function (ev) { this.events.push(ev); };

  // ---------------------------------------------------------------------------
  // Damage: which screen groups must be recomputed
  // ---------------------------------------------------------------------------
  Engine.prototype.damage = function (x0, y0, x1, y1) {
    var T = this.T, G = this.G, tw = this.tw;
    var tx0 = Math.max(0, Math.floor(x0 / T)), ty0 = Math.max(0, Math.floor(y0 / T));
    var tx1 = Math.min(tw - 1, Math.floor(x1 / T)), ty1 = Math.min(this.th - 1, Math.floor(y1 / T));
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        this.tileDirty[ty * tw + tx] = 1;
        this.superDirty[((ty / G) | 0) * this.sw + ((tx / G) | 0)] = 1;
      }
    }
  };
  Engine.prototype.damageAll = function () { this.tileDirty.fill(1); this.superDirty.fill(1); };

  // ---------------------------------------------------------------------------
  // One frame
  // ---------------------------------------------------------------------------
  Engine.prototype.tick = function (dt) {
    this.frame++;
    this.time += dt;
    var st = this.stats;
    st.nodesEvaluated = 0; st.cutoffs = 0; st.rulesRun = 0; st.units = 0; st.tiles = 0; st.supers = 0;
    var t0 = now();
    this.clock.value = this.time; this.clock.changeFrame = this.frame;   // rules read it; nothing derived does
    var events = this.events; this.events = [];
    for (var i = 0; i < this.rules.length; i++) {
      var r = this.rules[i];
      if (r.run.call(r, this, dt, events)) { r.evalFrame = this.frame; r.changeFrame = this.frame; r.evalCount++; st.rulesRun++; }
    }
    this._evaluate();
    var t1 = now();
    this._composite();
    var t2 = now();
    st.msLogic = t1 - t0; st.msUnits = t2 - t1; st.ms = t2 - t0;
    if (st.units > 0) { this.unitsNode.evalFrame = this.frame; this.unitsNode.changeFrame = this.frame; }
    return st;
  };

  // Down the graph: evaluate dirty nodes in creation (= topological) order.
  Engine.prototype._evaluate = function () {
    var nodes = this.nodes, full = this.full, st = this.stats, args = this._args;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.kind !== KIND.DERIVED && n.kind !== KIND.REGION) continue;
      if (!n.dirty && !full) continue;
      n.dirty = false;
      args.length = 0;
      for (var j = 0; j < n.inputs.length; j++) args.push(n.inputs[j].value);
      args.push(n.value);
      var v = n.fn.apply(null, args);
      n.evalFrame = this.frame; n.evalCount++; st.nodesEvaluated++;
      if (n.kind === KIND.DERIVED) {
        if (shallowSame(n.value, v)) { st.cutoffs++; continue; }
        n.value = v; n.version++; n.changeFrame = this.frame;
        this._markOutputs(n);
      } else {
        var arr = this._normalize(v, n);
        if (this._regionChanged(n.value, arr)) {
          n.value = arr; n.version++; n.changeFrame = this.frame; this._primsStale = true;
        } else {
          st.cutoffs++;
        }
      }
    }
  };

  Engine.prototype._normalize = function (v, node) {
    if (v == null) return [];
    if (!Array.isArray(v)) v = [v];
    var out = new Array(v.length), z = node.meta.z;
    for (var i = 0; i < v.length; i++) {
      var p = v[i] || null;
      if (p) { p.uid = (node.id << UID_SHIFT) | i; p.z = z + p.zOff; p.seq = node.id * 1024 + i; }
      out[i] = p;
    }
    return out;
  };

  Engine.prototype._regionChanged = function (old, neu) {
    var changed = old.length !== neu.length, m = Math.max(old.length, neu.length);
    for (var i = 0; i < m; i++) {
      var a = old[i], b = neu[i];
      if (a && b && a.sig === b.sig) continue;
      if (!a && !b) continue;
      changed = true;
      if (a) this.damage(a.bx0, a.by0, a.bx1, a.by1);
      if (b) this.damage(b.bx0, b.by0, b.bx1, b.by1);
    }
    return changed;
  };

  Engine.prototype._rebuildPrims = function () {
    var arr = [], nodes = this.nodes;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].kind !== KIND.REGION) continue;
      var v = nodes[i].value;
      for (var j = 0; j < v.length; j++) if (v[j]) arr.push(v[j]);
    }
    arr.sort(function (a, b) { return (a.z - b.z) || (a.seq - b.seq); });
    this.prims = arr;
    if (this._cand.length < arr.length) this._cand = new Array(arr.length * 2);
  };

  // L0: recompute the units of every damaged group, coarse groups first.
  Engine.prototype._composite = function () {
    if (this.full) this.damageAll();
    if (this._primsStale) { this._rebuildPrims(); this._primsStale = false; }
    var st = this.stats, T = this.T, G = this.G, tw = this.tw, th = this.th;
    var bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1, units = 0, tiles = 0, supers = 0, raster = this.raster;
    var list = this.dirtyList; list.length = 0;
    for (var sy = 0; sy < this.sh; sy++) {
      for (var sx = 0; sx < this.sw; sx++) {
        var si = sy * this.sw + sx;
        if (!this.superDirty[si]) continue;
        this.superDirty[si] = 0; supers++;
        var tyEnd = Math.min(th, (sy + 1) * G), txEnd = Math.min(tw, (sx + 1) * G);
        for (var ty = sy * G; ty < tyEnd; ty++) {
          for (var tx = sx * G; tx < txEnd; tx++) {
            var ti = ty * tw + tx;
            if (!this.tileDirty[ti]) continue;
            this.tileDirty[ti] = 0; tiles++; this.tileStamp[ti] = this.frame; list.push(ti);
            units += raster ? this._compositeTile(tx, ty)
              : (Math.min(this.W, (tx + 1) * T) - tx * T) * (Math.min(this.H, (ty + 1) * T) - ty * T);
            if (tx < bx0) bx0 = tx; if (tx > bx1) bx1 = tx;
            if (ty < by0) by0 = ty; if (ty > by1) by1 = ty;
          }
        }
      }
    }
    st.units = units; st.tiles = tiles; st.supers = supers;
    if (units) {
      var x = bx0 * T, y = by0 * T;
      this.blit = { x: x, y: y, w: Math.min(this.W, (bx1 + 1) * T) - x, h: Math.min(this.H, (by1 + 1) * T) - y };
    } else {
      this.blit = null;
    }
  };

  Engine.prototype._compositeTile = function (tx, ty) {
    var T = this.T, W = this.W;
    var x0 = tx * T, y0 = ty * T, x1 = Math.min(x0 + T, W), y1 = Math.min(y0 + T, this.H);
    var all = this.prims, list = this._cand, n = 0, k, p;
    for (k = 0; k < all.length; k++) {
      p = all[k];
      if (p.bx1 <= x0 || p.bx0 >= x1 || p.by1 <= y0 || p.by0 >= y1) continue;
      list[n++] = p;
    }
    // Everything below the top-most primitive that opaquely covers the whole
    // group cannot show through, so the group skips it.
    var start = 0;
    for (k = n - 1; k >= 0; k--) {
      p = list[k];
      if (p.opaqueFull && p.bx0 <= x0 && p.by0 <= y0 && p.bx1 >= x1 && p.by1 >= y1) { start = k; break; }
    }
    var fb = this.fb, own = this.own, stamp = this.stamp, frame = this.frame, aa = this.aa, col = this._col;
    for (var y = y0; y < y1; y++) {
      var py = y + 0.5, row = y * W;
      for (var x = x0; x < x1; x++) {
        var px = x + 0.5, r = 0, g = 0, b = 0, owner = -1;
        for (k = start; k < n; k++) {
          p = list[k];
          if (px < p.bx0 || px >= p.bx1 || py < p.by0 || py >= p.by1) continue;
          var cov;
          switch (p.type) {
            case 1: // RECT
              cov = 1;
              break;
            case 2: { // POLY: distance to the nearest edge, in units
              var e = p.edges, dmin = 1e9, m3 = p.ne * 3;
              for (var m = 0; m < m3; m += 3) {
                var d = e[m] * px + e[m + 1] * py - e[m + 2];
                if (d < dmin) { dmin = d; if (dmin < -1) break; }
              }
              cov = dmin + 0.5 + p.dil;
              if (cov > 1) cov = 1;
              break;
            }
            case 3: { // ELLIPSE
              var ex = (px - p.cx) / p.rx, ey = (py - p.cy) / p.ry;
              cov = (1 - Math.sqrt(ex * ex + ey * ey)) / p.soft;
              if (cov > 1) cov = 1;
              if (p.pow2 && cov > 0) cov *= cov;
              break;
            }
            case 4: { // RRECT: signed distance to a rounded box
              var qx = Math.abs(px - p.cx) - p.rx + p.rad, qy = Math.abs(py - p.cy) - p.ry + p.rad;
              var ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
              var sd = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - p.rad;
              cov = (0.5 - sd) / p.soft;
              if (cov > 1) cov = 1;
              break;
            }
            default: { // TEXT
              var gx = Math.floor((px - p.cx) / p.scale), gy = Math.floor((py - p.cy) / p.scale);
              cov = 0;
              if (gy >= 0 && gy < 7 && gx >= 0) {
                var ci = (gx / 6) | 0, cc = gx - ci * 6;
                if (ci < p.glyphs.length && cc < 5 && ((p.glyphs[ci][gy] >> (4 - cc)) & 1)) cov = 1;
              }
            }
          }
          if (cov <= 0) continue;
          if (!aa && p.crisp) { if (cov < 0.5) continue; cov = 1; }
          var cr = p.r0, cg = p.g0, cb = p.b0;
          if (p.grad) {
            var t = (px - p.gx) * p.gdx + (py - p.gy) * p.gdy;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            cr += (p.r1 - cr) * t; cg += (p.g1 - cg) * t; cb += (p.b1 - cb) * t;
          }
          if (p.fx !== null) { col[0] = cr; col[1] = cg; col[2] = cb; p.fx(p, px, py, col); cr = col[0]; cg = col[1]; cb = col[2]; }
          var a = cov * p.alpha;
          if (p.blend === 0) { r += (cr - r) * a; g += (cg - g) * a; b += (cb - b) * a; }
          else if (p.blend === 1) { r *= 1 - a + a * cr; g *= 1 - a + a * cg; b *= 1 - a + a * cb; }
          else { r += cr * a; g += cg * a; b += cb * a; }
          if (cov >= 0.5 && p.ownable) owner = p.uid;
        }
        var i = row + x;
        if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
        fb[i] = (0xFF000000 | (((b + 0.5) | 0) << 16) | (((g + 0.5) | 0) << 8) | ((r + 0.5) | 0)) >>> 0;
        own[i] = owner;
        stamp[i] = frame;
      }
    }
    return (x1 - x0) * (y1 - y0);
  };

  // ---------------------------------------------------------------------------
  // Up the graph: hit testing and provenance
  // ---------------------------------------------------------------------------
  Engine.prototype.nodeOfUid = function (uid) { return uid < 0 ? null : this.nodes[uid >> UID_SHIFT] || null; };

  Engine.prototype.unitAt = function (x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return null;
    var i = y * this.W + x, uid = this.own[i], node = this.nodeOfUid(uid);
    return { x: x, y: y, i: i, uid: uid, node: node, index: uid < 0 ? -1 : uid & UID_MASK,
      prim: node ? node.value[uid & UID_MASK] || null : null };
  };

  // Everything a node depends on: its inputs and, for states, the rules that write them.
  Engine.prototype.trace = function (node) {
    var seen = [], stack = [node];
    while (stack.length) {
      var n = stack.pop();
      if (!n || seen.indexOf(n) >= 0) continue;
      seen.push(n);
      for (var i = 0; i < n.inputs.length; i++) stack.push(n.inputs[i]);
      for (i = 0; i < n.writers.length; i++) stack.push(n.writers[i]);
    }
    return seen;
  };

  return {
    Engine: Engine, PRIM: PRIM, BLEND: BLEND, KIND: KIND, FONT: FONT,
    UID_SHIFT: UID_SHIFT, UID_MASK: UID_MASK, now: now,
    prim: { rect: rect, poly: poly, ellipse: ellipse, rrect: rrect, text: text, textWidth: textWidth }
  };
}));
