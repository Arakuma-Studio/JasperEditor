// The expression runtime's prelude: After Effects' expression object model and global functions, evaluated once
// per QuickJS context. Ported and adapted from EffectCraft `crates/expr/src/prelude.js` (MIT OR Apache-2.0,
// Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors; see licenses/ported/expressions.md), which was
// written from Adobe's public Expression Language Reference.
//
// Differences from EffectCraft: host requests are synchronous (`__host(op, json) → json`; the host may evaluate
// other expressions re-entrantly) instead of the abort-and-rerun "pending" protocol; per-evaluation state is a
// stack (`__run` saves and restores it) so nested evaluations of other properties are exact; random numbers,
// noise and wiggle are computed here with 32-bit integer hashing (Math.imul), so they are identical in every
// QuickJS build; the object model maps a Premiere sequence onto AE's comp (layers = clips, see world.ts).
//
// This text is NOT passed through the array-maths rewrite, so it uses plain JS operators. It must not contain
// backticks or dollar-brace sequences (it is a String.raw template).
export const PRELUDE = String.raw`
var time = 0;
var value = 0;
var __S = null;
var __memo = {};
var textIndex = 1;
var textTotal = 1;
var selectorValue = [100, 100, 100];

var __COMP = 0, __COMPNAME = 1, __LAYER = 2, __LINFO = 3, __CHILD = 4, __PINFO = 5, __VALUE = 6, __XFORM = 7,
  __RECT = 8, __MARKERS = 9, __TEXT = 10, __SAMPLE = 11, __PROJ = 12;

// Deterministic environment: no wall clock, no unseeded randomness.
(function () {
  var D = Date;
  function FixedDate() {
    if (arguments.length === 0) return new D(0);
    var a = Array.prototype.slice.call(arguments);
    return new (Function.prototype.bind.apply(D, [null].concat(a)))();
  }
  FixedDate.prototype = D.prototype;
  FixedDate.now = function () { return 0; };
  FixedDate.UTC = D.UTC;
  FixedDate.parse = D.parse;
  globalThis.Date = FixedDate;
  Math.random = function () { return random(); };
})();

function __h(op) {
  var args = Array.prototype.slice.call(arguments, 1);
  var key = op + ':' + JSON.stringify(args);
  if (Object.prototype.hasOwnProperty.call(__memo, key)) return __memo[key];
  var r = JSON.parse(__host(op, JSON.stringify(args)));
  __memo[key] = r;
  return r;
}

function __err(msg) {
  throw new Error(msg);
}

// One evaluation: install the state, call the compiled function, convert the result, restore the caller's state
// (nested evaluations of other properties run inside the host's request handler).
function __run(fn, json) {
  var st = JSON.parse(json);
  var saved = [time, value, __S, textIndex, textTotal, selectorValue];
  if (st.top) __memo = {};
  try {
    time = st.time;
    value = st.value;
    textIndex = st.textIndex;
    textTotal = st.textTotal;
    selectorValue = st.selectorValue;
    __S = {
      seq: st.seq, owner: st.owner, path: st.path, seed: st.seed, fd: st.fd, kind: st.kind,
      comp: null, layer: null, prop: null, vars: {}, rc: 0, user: 0, timeless: false,
    };
    var r = fn();
    return JSON.stringify({ r: __result(r) }, __json);
  } finally {
    time = saved[0];
    value = saved[1];
    __S = saved[2];
    textIndex = saved[3];
    textTotal = saved[4];
    selectorValue = saved[5];
  }
}

function __json(k, v) {
  if (typeof v === 'number' && !isFinite(v)) return { __nonFinite: String(v) };
  return v;
}

function __result(r) {
  r = __v(r);
  if (r !== null && typeof r === 'object' && r.__isLayer) return { __layer: r.__o };
  if (r !== null && typeof r === 'object' && r.__isTextStyle) return r.text;
  if (Array.isArray(r)) return r.map(function (x) { return __v(x); });
  if (typeof r === 'function') return String(r);
  if (r !== null && typeof r === 'object' && !Array.isArray(r)) {
    if (r.__isProp || r.__isGroup || r.__isComp) return String(r);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Array maths (targets of the operator rewrite).

function __v(x) {
  if (x !== null && typeof x === 'object' && x.__isProp === true) return x.value;
  if (typeof x === 'function' && x.__isProp === true) return x.value;
  return x;
}

function __bin(a, b, f) {
  a = __v(a);
  b = __v(b);
  var aa = Array.isArray(a), ba = Array.isArray(b), i, r;
  if (aa && ba) {
    var n = Math.max(a.length, b.length);
    r = new Array(n);
    for (i = 0; i < n; i++) r[i] = f(i < a.length ? a[i] : 0, i < b.length ? b[i] : 0);
    return r;
  }
  if (aa && (typeof b === 'number' || typeof b === 'boolean')) {
    r = new Array(a.length);
    for (i = 0; i < a.length; i++) r[i] = f(a[i], b);
    return r;
  }
  if (ba && (typeof a === 'number' || typeof a === 'boolean')) {
    r = new Array(b.length);
    for (i = 0; i < b.length; i++) r[i] = f(a, b[i]);
    return r;
  }
  return f(a, b);
}

function __fadd(x, y) { return x + y; }
function __fsub(x, y) { return x - y; }
function __fmul(x, y) { return x * y; }
function __fdiv(x, y) { return x / y; }

function __add(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  var x = __v(a), y = __v(b);
  if (typeof x === 'string' || typeof y === 'string') return x + y;
  return __bin(x, y, __fadd);
}
function __sub(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return __bin(a, b, __fsub);
}
function __mul(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a * b;
  return __bin(a, b, __fmul);
}
function __div(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a / b;
  return __bin(a, b, __fdiv);
}
function __neg(a) {
  if (typeof a === 'number') return -a;
  a = __v(a);
  if (Array.isArray(a)) return a.map(function (x) { return -x; });
  return -a;
}

// ---------------------------------------------------------------------------------------------
// Vector maths.

function add(a, b) { return __bin(a, b, __fadd); }
function sub(a, b) { return __bin(a, b, __fsub); }
function mul(a, b) { return __bin(a, b, __fmul); }
function div(a, b) { return __bin(a, b, __fdiv); }

function clamp(v, a, b) {
  v = __v(v); a = __v(a); b = __v(b);
  var lo = function (x, y0, y1) { return Math.min(Math.max(x, Math.min(y0, y1)), Math.max(y0, y1)); };
  if (Array.isArray(v)) {
    return v.map(function (x, i) {
      return lo(x, Array.isArray(a) ? a[i] : a, Array.isArray(b) ? b[i] : b);
    });
  }
  return lo(v, a, b);
}

function dot(a, b) {
  a = __v(a); b = __v(b);
  var s = 0;
  for (var i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

function cross(a, b) {
  a = __v(a); b = __v(b);
  var a2 = a[2] || 0, b2 = b[2] || 0;
  return [a[1] * b2 - a2 * b[1], a2 * b[0] - a[0] * b2, a[0] * b[1] - a[1] * b[0]];
}

function length(a, b) {
  a = __v(a);
  if (b !== undefined) a = sub(a, __v(b));
  if (!Array.isArray(a)) return Math.abs(a);
  var s = 0;
  for (var i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

function normalize(a) {
  a = __v(a);
  if (!Array.isArray(a)) return a === 0 ? 0 : a / Math.abs(a);
  var l = length(a);
  return l === 0 ? a.map(function () { return 0; }) : div(a, l);
}

function lookAt(from, at) {
  var d = normalize(sub(__v(at), __v(from)));
  var x = d[0], y = d[1], z = d[2] || 0;
  var rx = -Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
  var ry = Math.atan2(x, z) * 180 / Math.PI;
  return [rx, ry, 0];
}

function degreesToRadians(d) { return __v(d) * Math.PI / 180; }
function radiansToDegrees(r) { return __v(r) * 180 / Math.PI; }

// ---------------------------------------------------------------------------------------------
// Interpolation: linear/ease/easeIn/easeOut(t, [tMin, tMax,] value1, value2).

function __interp(shape, args) {
  var t, tMin, tMax, v1, v2;
  if (args.length <= 3) {
    t = args[0]; tMin = 0; tMax = 1; v1 = args[1]; v2 = args[2];
  } else {
    t = args[0]; tMin = args[1]; tMax = args[2]; v1 = args[3]; v2 = args[4];
  }
  t = __v(t); tMin = __v(tMin); tMax = __v(tMax); v1 = __v(v1); v2 = __v(v2);
  var u;
  if (tMax === tMin) u = t >= tMax ? 1 : 0;
  else u = (t - tMin) / (tMax - tMin);
  u = Math.max(0, Math.min(1, u));
  u = shape(u);
  if (Array.isArray(v1) || Array.isArray(v2)) return add(v1, mul(sub(v2, v1), u));
  return v1 + (v2 - v1) * u;
}

function __lin(u) { return u; }
// AE's ease: zero velocity at both ends; easeIn only at tMin (linear at tMax), easeOut only at tMax.
function __ease(u) { return u * u * (3 - 2 * u); }
function __easeIn(u) { return u * u * (2 - u); }
function __easeOut(u) { var w = 1 - u; return 1 - w * w * (2 - w); }

function linear() { return __interp(__lin, arguments); }
function ease() { return __interp(__ease, arguments); }
function easeIn() { return __interp(__easeIn, arguments); }
function easeOut() { return __interp(__easeOut, arguments); }

// ---------------------------------------------------------------------------------------------
// Deterministic hashing (32-bit, Math.imul), random numbers and smooth noise.

function __hash(x) {
  x = x | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
function __hstr(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
// Bits of a double (deterministic: the same number always hashes the same).
var __f64 = new Float64Array(1), __u32 = new Uint32Array(__f64.buffer);
function __hnum(x) {
  __f64[0] = x === 0 ? 0 : x;
  return __hash(__u32[0] ^ __hash(__u32[1] + 0x9e3779b9));
}
function __mix(parts) {
  var h = 0x2545f491;
  for (var i = 0; i < parts.length; i++) h = __hash(h ^ __hash(parts[i] + 0x9e3779b9 * (i + 1)));
  return h >>> 0;
}
// Uniform in [0, 1) with 53 random bits.
function __unit(seed) {
  var a = __hash(seed ^ 0x68e31da4) >>> 5, b = __hash(seed ^ 0xb5297a4d) >>> 6;
  return (a * 67108864 + b) / 9007199254740992;
}
function __fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function __lattice(seed, i) { return __unit(__mix([seed, __hnum(i)])) * 2 - 1; }
// Smooth 1D value noise in [-1, 1] (C2-continuous).
function __noise1(seed, x) {
  if (!isFinite(x)) return 0;
  var i = Math.floor(x), u = __fade(x - i);
  var a = __lattice(seed, i), b = __lattice(seed, i + 1);
  return a + (b - a) * u;
}
// Smooth 3D value noise in [-1, 1]: nearby inputs give nearby outputs.
function __noise3(x, y, z) {
  if (!(isFinite(x) && isFinite(y) && isFinite(z))) return 0;
  var fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  var u = __fade(x - fx), v = __fade(y - fy), w = __fade(z - fz);
  var g = function (dx, dy, dz) { return __unit(__mix([__hnum(fx + dx), __hnum(fy + dy), __hnum(fz + dz)])) * 2 - 1; };
  var l = function (a, b, t) { return a + (b - a) * t; };
  var x00 = l(g(0, 0, 0), g(1, 0, 0), u), x10 = l(g(0, 1, 0), g(1, 1, 0), u);
  var x01 = l(g(0, 0, 1), g(1, 0, 1), u), x11 = l(g(0, 1, 1), g(1, 1, 1), u);
  return l(l(x00, x10, v), l(x01, x11, v), w);
}
// Per-dimension wiggle offsets: sum over octaves of amp * ampMult^k * noise(freq * 2^k * t).
function __wig(seed, dims, freq, amp, octaves, ampMult, t) {
  octaves = isFinite(octaves) ? Math.max(1, Math.min(16, Math.floor(octaves))) : 1;
  var out = [];
  for (var d = 0; d < dims; d++) {
    var a = amp, f = freq, sum = 0;
    for (var k = 0; k < octaves; k++) {
      var s = __mix([seed, d, k]);
      sum += a * __noise1(s, f * t + __unit(s) * 1000);
      a *= ampMult;
      f *= 2;
    }
    out.push(sum);
  }
  return out;
}

function seedRandom(offset, timeless) {
  __S.user = __v(offset);
  __S.timeless = !!timeless;
  __S.rc = 0;
}

function __r01() {
  var t = __S.timeless ? 0 : time;
  return __unit(__mix([__hstr(__S.seed), __hnum(__S.user), __hnum(t), __S.rc++]));
}

function __scaleRand(r, args) {
  if (args.length === 0) return r();
  var a = __v(args[0]);
  if (args.length === 1) {
    if (Array.isArray(a)) return a.map(function (m) { return r() * m; });
    return r() * a;
  }
  var b = __v(args[1]);
  if (Array.isArray(a) || Array.isArray(b)) {
    var n = Math.max(Array.isArray(a) ? a.length : 1, Array.isArray(b) ? b.length : 1), out = [];
    for (var i = 0; i < n; i++) {
      var lo = Array.isArray(a) ? (a[i] || 0) : a, hi = Array.isArray(b) ? (b[i] || 0) : b;
      out.push(lo + r() * (hi - lo));
    }
    return out;
  }
  return a + r() * (b - a);
}

function random() { return __scaleRand(__r01, arguments); }

function __gauss01() {
  var u1 = Math.max(__r01(), 1e-12), u2 = __r01();
  var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  // AE: about 90% of the results fall within [0, 1].
  return 0.5 + z * 0.304;
}

function gaussRandom() { return __scaleRand(__gauss01, arguments); }

function noise(x) {
  x = __v(x);
  if (Array.isArray(x)) return __noise3(x[0] || 0, x[1] || 0, x[2] || 0);
  return __noise3(x, 0, 0);
}

// ---------------------------------------------------------------------------------------------
// Time conversion.

function timeToFrames(t, fps, isDuration) {
  if (t === undefined) t = time + thisComp.displayStartTime;
  if (fps === undefined) fps = 1 / __S.fd;
  return Math.floor(__v(t) * fps + 1e-6);
}

function framesToTime(frames, fps) {
  if (fps === undefined) fps = 1 / __S.fd;
  return __v(frames) / fps;
}

function __pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }

function timeToTimecode(t, base, isDuration) {
  if (t === undefined) t = time + thisComp.displayStartTime;
  if (base === undefined) base = Math.round(1 / __S.fd);
  t = __v(t);
  var neg = t < 0;
  var f = Math.floor(Math.abs(t) * base + 1e-6);
  var ff = f % base, s = Math.floor(f / base), ss = s % 60, m = Math.floor(s / 60), mm = m % 60, h = Math.floor(m / 60);
  return (neg ? '-' : '') + __pad(h) + ':' + __pad(mm) + ':' + __pad(ss) + ':' + __pad(ff);
}

function timeToNTSCTimecode(t, ntscDropFrame, isDuration) {
  return timeToTimecode(t, 30, isDuration);
}

function timeToFeetAndFrames(t, fps, framesPerFoot, isDuration) {
  if (t === undefined) t = time + thisComp.displayStartTime;
  if (fps === undefined) fps = 1 / __S.fd;
  if (framesPerFoot === undefined) framesPerFoot = 16;
  t = __v(t);
  var neg = t < 0;
  var f = Math.floor(Math.abs(t) * fps + 1e-6);
  var feet = Math.floor(f / framesPerFoot), fr = f % framesPerFoot;
  return (neg ? '-' : '') + feet + '+' + __pad(fr);
}

function timeToCurrentFormat(t, fps, isDuration) {
  if (fps === undefined) fps = Math.round(1 / __S.fd);
  return timeToTimecode(t, fps, isDuration);
}

function posterizeTime(fps) {
  fps = __v(fps);
  if (!(fps > 0)) return;
  var t = Math.floor(time * fps + 1e-6) / fps;
  if (t !== time) {
    var v = thisProperty.valueAtTime(t);
    time = t;
    value = v;
  }
}

// ---------------------------------------------------------------------------------------------
// Colour.

function rgbToHsl(c) {
  c = __v(c);
  var r = c[0], g = c[1], b = c[2], a = c.length > 3 ? c[3] : 1;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0;
  if (mx !== mn) {
    var d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l, a];
}

function hslToRgb(c) {
  c = __v(c);
  var h = c[0], s = c[1], l = c[2], a = c.length > 3 ? c[3] : 1;
  h = h - Math.floor(h);
  if (s === 0) return [l, l, l, a];
  var hue = function (p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3), a];
}

function hexToRgb(hex) {
  var s = String(__v(hex)).replace(/^#|^0x/i, '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  var n = parseInt(s.slice(0, 6), 16);
  if (!isFinite(n)) __err('hexToRgb: "' + hex + '" is not a hexadecimal colour');
  var a = s.length >= 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

// ---------------------------------------------------------------------------------------------
// Object model: comps (sequences), layers (clips), property groups and properties.

function __child(seq, owner, group, key) {
  var info = __h(__CHILD, seq, owner, group, key);
  if (info === null) return undefined;
  return info[1] ? __mkGroup(seq, owner, info) : __mkProp(seq, owner, info[0]);
}

function Comp(seq) { this.__s = seq; this.__i = null; }
Comp.prototype = {
  __isComp: true,
  get __info() {
    if (this.__i) return this.__i;
    var i = __h(__COMP, this.__s);
    if (i === null) __err('Sequence no longer exists');
    return (this.__i = i);
  },
  get name() { return this.__info[0]; },
  get width() { return this.__info[1]; },
  get height() { return this.__info[2]; },
  get duration() { return this.__info[3]; },
  get frameDuration() { return this.__info[4]; },
  get numLayers() { return this.__info[5]; },
  get pixelAspect() { return this.__info[6]; },
  get displayStartTime() { return this.__info[7]; },
  get bgColor() { return this.__info[8]; },
  get shutterAngle() { return 180; },
  get shutterPhase() { return -90; },
  get ntscDropFrame() { return this.__info[9]; },
  get marker() { return new Markers(this.__s, null); },
  get activeCamera() { __err('Sequences have no cameras'); },
  layer: function (a, rel) {
    a = __v(a);
    if (a !== null && typeof a === 'object' && a.__isLayer) {
      if (rel === undefined) return a;
      return this.layer(a.index + __v(rel));
    }
    var id = __h(__LAYER, this.__s, a);
    if (id === null) __err(typeof a === 'string' ? 'Layer named "' + a + '" does not exist' : 'Layer index ' + a + ' out of range');
    return new Layer(this.__s, id);
  },
  layerByComment: function (c) { __err('layerByComment: clips have no comments'); },
  toString: function () { return '[object Comp]'; },
};

function comp(name) {
  var id = __h(__COMPNAME, String(__v(name)));
  if (id === null) __err('Comp named "' + name + '" does not exist');
  return new Comp(id);
}

var thisProject = {
  get fullPath() { return ''; },
  get bitsPerChannel() { return 8; },
  get linearBlending() { return false; },
  toString: function () { return '[object Project]'; },
};
function footage(name) { __err('footage(): data footage items are not supported'); }

function Layer(seq, o) { this.__s = seq; this.__o = o; this.__i = null; }

function __m3(m, p) {
  var x = p[0] || 0, y = p[1] || 0;
  var X = m[0] * x + m[1] * y + m[2], Y = m[3] * x + m[4] * y + m[5], W = m[6] * x + m[7] * y + m[8];
  if (W !== 0 && W !== 1) { X /= W; Y /= W; }
  return p.length > 2 ? [X, Y, p[2] || 0] : [X, Y];
}
function __m3v(m, p) {
  var x = p[0] || 0, y = p[1] || 0;
  return p.length > 2 ? [m[0] * x + m[1] * y, m[3] * x + m[4] * y, p[2] || 0] : [m[0] * x + m[1] * y, m[3] * x + m[4] * y];
}

Layer.prototype = {
  __isLayer: true,
  get __info() {
    if (this.__i) return this.__i;
    var i = __h(__LINFO, this.__s, this.__o);
    if (i === null) __err(String(this.__o).indexOf(':') >= 0 ? 'This property does not belong to a layer (clip)' : 'Layer no longer exists');
    return (this.__i = i);
  },
  get name() { return this.__info[0]; },
  get index() { return this.__info[1]; },
  get inPoint() { return this.__info[2]; },
  get outPoint() { return this.__info[3]; },
  get startTime() { return this.__info[4]; },
  get width() { return this.__info[5]; },
  get height() { return this.__info[6]; },
  get hasVideo() { return this.__info[7]; },
  get hasAudio() { return this.__info[8]; },
  get enabled() { return this.__info[9]; },
  get audioActive() { return this.__info[8] && this.__info[9] && time >= this.inPoint && time < this.outPoint; },
  get active() { return this.__info[9] && time >= this.inPoint && time < this.outPoint; },
  get hasParent() { return false; },
  get parent() { __err('Layer "' + this.name + '" has no parent (sequences have no parenting)'); },
  get source() { return null; },
  get containingComp() { return new Comp(this.__s); },
  __group: function (k) {
    var g = __child(this.__s, this.__o, '', k);
    if (g === undefined) __err('Layer "' + this.name + '" has no property "' + k + '"');
    return g;
  },
  get transform() { return this.__group('transform'); },
  get position() { return this.transform.position; },
  get scale() { return this.transform.scale; },
  get rotation() { return this.transform.rotation; },
  get opacity() { return this.transform.opacity; },
  get anchorPoint() { return this.transform.anchorPoint; },
  get text() { return this.__group('text'); },
  get audio() { return this.__group('audio'); },
  get audioLevels() { return this.audio.audioLevels; },
  get shape() { return this.__group('shape'); },
  get params() { return this.__group('params'); },
  get marker() { return new Markers(this.__s, this.__o); },
  effect: function (k) {
    k = __v(k);
    var g = __child(this.__s, this.__o, '', 'effects');
    var e = g === undefined ? undefined : __child(this.__s, this.__o, g.__p, k);
    if (e === undefined) __err('Effect ' + (typeof k === 'string' ? '"' + k + '"' : k) + ' not found on layer "' + this.name + '"');
    return e;
  },
  property: function (k) { return this.__group(__v(k)); },
  mask: function (k) { return this.__group('masks').__get(k); },
  content: function (k) { __err('content(): clips have no shape contents; use thisLayer.shape'); },
  __x: function (t) { return __h(__XFORM, this.__s, this.__o, t === undefined ? time : __v(t)); },
  toComp: function (p, t) { return __m3(this.__x(t)[0], __v(p)); },
  fromComp: function (p, t) { return __m3(this.__x(t)[1], __v(p)); },
  toWorld: function (p, t) { return __m3(this.__x(t)[0], __v(p)); },
  fromWorld: function (p, t) { return __m3(this.__x(t)[1], __v(p)); },
  toCompVec: function (p, t) { return __m3v(this.__x(t)[0], __v(p)); },
  fromCompVec: function (p, t) { return __m3v(this.__x(t)[1], __v(p)); },
  toWorldVec: function (p, t) { return __m3v(this.__x(t)[0], __v(p)); },
  fromWorldVec: function (p, t) { return __m3v(this.__x(t)[1], __v(p)); },
  fromCompToSurface: function (p, t) { return this.fromComp(p, t); },
  sourceRectAtTime: function (t, includeExtents) {
    var r = __h(__RECT, this.__s, this.__o, t === undefined ? time : __v(t), !!includeExtents);
    return { top: r[0], left: r[1], width: r[2], height: r[3] };
  },
  sourceTime: function (t) { return (t === undefined ? time : __v(t)) - this.startTime; },
  // Average straight RGBA of the layer's pixels in point +- radius (layer pixels).
  sampleImage: function (point, radius, postEffect, t) {
    point = __v(point);
    radius = radius === undefined ? [0.5, 0.5] : __v(radius);
    if (!Array.isArray(radius)) radius = [radius, radius];
    return __h(__SAMPLE, this.__s, this.__o, point[0], point[1], radius[0], radius.length > 1 ? radius[1] : radius[0],
      postEffect === undefined ? true : !!__v(postEffect), t === undefined ? time : __v(t));
  },
  toString: function () { return '[object Layer]'; },
};

// Property groups are callable: effect("Slider Control")("Slider").
var __GroupProto = {
  __isGroup: true,
  __get: function (k) {
    k = __v(k);
    var r = __child(this.__s, this.__o, this.__p, k);
    if (r === undefined) __err('Property ' + (typeof k === 'string' ? '"' + k + '"' : k) + ' not found in "' + this.__info[2] + '"');
    return r;
  },
  param: function (k) { return this.__get(k); },
  property: function (k) { return this.__get(k); },
  get name() { return this.__info[2]; },
  get matchName() { return this.__info[3]; },
  get numProperties() { return this.__info[4]; },
  get propertyIndex() { return this.__info[5]; },
  get active() { return true; },
  get enabled() { return this.__info[6] !== false; },
  toString: function () { return '[object PropertyGroup]'; },
};

var __groupHandler = {
  get: function (t, k) {
    if (typeof k !== 'string' || k in t) return t[k];
    return __child(t.__s, t.__o, t.__p, k);
  },
};

function __mkGroup(seq, owner, info) {
  var f = function (k) { return f.__get(k); };
  delete f.name;
  delete f.length;
  Object.setPrototypeOf(f, __GroupProto);
  f.__s = seq; f.__o = owner; f.__p = info[0]; f.__info = info;
  return new Proxy(f, __groupHandler);
}

function Prop(seq, owner, path) {
  this.__s = seq; this.__o = owner; this.__p = path; this.__i = null;
  this.__self = __S !== null && seq === __S.seq && owner === __S.owner && path === __S.path;
}

function __mod(a, d) { return ((a % d) + d) % d; }

function __avg(vals) {
  var s = vals[0];
  for (var i = 1; i < vals.length; i++) s = add(s, vals[i]);
  return div(s, vals.length);
}

// loopIn/loopOut (cycle, pingpong, offset, continue) over the last/first n keyframes (0 = all) or a duration.
function __loop(p, out, type, n, dur) {
  type = type === undefined ? 'cycle' : String(__v(type)).toLowerCase();
  if (type !== 'cycle' && type !== 'pingpong' && type !== 'offset' && type !== 'continue')
    __err((out ? 'loopOut' : 'loopIn') + ': unknown type "' + type + '" (cycle, pingpong, offset or continue)');
  n = Math.floor(__v(n) || 0);
  var times = p.__info[3], N = times.length, t = time;
  if (N < 2 && type !== 'continue') return p.value;
  if (N === 0) return p.value;
  var tStart, tEnd, h = 1e-3, k, ph;
  if (out) {
    tEnd = times[N - 1];
    if (t <= tEnd) return p.value;
    if (dur !== undefined && dur > 0) tStart = tEnd - dur;
    else if (n > 0 && N - 1 - n >= 0) tStart = times[N - 1 - n];
    else tStart = times[0];
  } else {
    tStart = times[0];
    if (t >= tStart) return p.value;
    if (dur !== undefined && dur > 0) tEnd = tStart + dur;
    else if (n > 0 && n < N) tEnd = times[n];
    else tEnd = times[N - 1];
  }
  var d = tEnd - tStart;
  if (type === 'continue') {
    if (out) {
      var ve = p.valueAtTime(tEnd);
      if (N < 2) return ve;
      return add(ve, mul(div(sub(ve, p.valueAtTime(tEnd - h)), h), t - tEnd));
    }
    var vs = p.valueAtTime(tStart);
    if (N < 2) return vs;
    return add(vs, mul(div(sub(p.valueAtTime(tStart + h), vs), h), t - tStart));
  }
  if (!(d > 0)) return p.value;
  ph = __mod(t - tStart, d);
  if (type === 'pingpong') {
    if (out) {
      k = Math.floor((t - tStart) / d);
      return p.valueAtTime(k % 2 === 1 ? tEnd - ph : tStart + ph);
    }
    k = Math.floor((tEnd - t) / d);
    var q = __mod(tEnd - t, d);
    return p.valueAtTime(k % 2 === 1 ? tEnd - q : tStart + q);
  }
  if (type === 'offset') {
    k = Math.floor((t - tStart) / d);
    return add(p.valueAtTime(tStart + ph), mul(sub(p.valueAtTime(tEnd), p.valueAtTime(tStart)), k));
  }
  return p.valueAtTime(tStart + ph);
}

Prop.prototype = {
  __isProp: true,
  get __info() {
    if (this.__i) return this.__i;
    var i = __h(__PINFO, this.__s, this.__o, this.__p);
    if (i === null) __err('Property no longer exists');
    return (this.__i = i);
  },
  get name() { return this.__info[0]; },
  get numKeys() { return this.__info[3].length; },
  get propertyIndex() { return this.__info[6]; },
  get matchName() { return this.__info[7]; },
  get expression() { return this.__info[9]; },
  get expressionEnabled() { return this.__info[5]; },
  get canSetExpression() { return true; },
  get propertyGroup() { return function () { __err('propertyGroup() is not supported'); }; },
  __wrap: function (v) {
    if (this.__info[1] === 'layer') return v === null || v === '' ? null : new Layer(this.__s, v);
    return v;
  },
  get value() { return this.__self ? value : this.valueAtTime(time); },
  valueAtTime: function (t) {
    t = __v(t);
    if (typeof t !== 'number' || !isFinite(t)) __err('valueAtTime: time must be a number');
    if (this.__self && t === time) return value;
    // AE: the property's own expression reads its pre-expression value at other times (no self-recursion).
    return this.__wrap(__h(__VALUE, this.__s, this.__o, this.__p, t, this.__self));
  },
  get preExpressionValue() { return this.__wrap(__h(__VALUE, this.__s, this.__o, this.__p, time, true)); },
  velocityAtTime: function (t) {
    var h = 1e-3;
    t = __v(t);
    return div(sub(this.valueAtTime(t + h), this.valueAtTime(t - h)), 2 * h);
  },
  get velocity() { return this.velocityAtTime(time); },
  speedAtTime: function (t) { return length(this.velocityAtTime(t)); },
  get speed() { return this.speedAtTime(time); },
  key: function (n) {
    n = __v(n);
    var info = this.__info, N = info[3].length;
    if (typeof n === 'string') __err('key("' + n + '"): only marker keys have names');
    if (!(n >= 1 && n <= N)) __err('Key index ' + n + ' out of range (property has ' + N + ' keys)');
    n = Math.floor(n);
    var k = { time: info[3][n - 1], value: this.__wrap(info[4][n - 1]), index: n };
    return k;
  },
  nearestKey: function (t) {
    t = __v(t);
    var times = this.__info[3];
    if (times.length === 0) __err('Property has no keyframes');
    var best = 0;
    for (var i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    return this.key(best + 1);
  },
  __seed: function () { return this.__self ? __S.seed : String(this.__o) + '/' + this.__p; },
  wiggle: function (freq, amp, octaves, ampMult, t) {
    octaves = octaves === undefined ? 1 : __v(octaves);
    ampMult = ampMult === undefined ? 0.5 : __v(ampMult);
    t = t === undefined ? time : __v(t);
    var base = this.valueAtTime(t);
    var dims = Array.isArray(base) ? base.length : 1;
    var off = __wig(__hstr(this.__seed()), dims, __v(freq), __v(amp), octaves, ampMult, t);
    if (!Array.isArray(base)) return base + off[0];
    var r = base.slice();
    for (var i = 0; i < r.length; i++) r[i] += off[i];
    return r;
  },
  temporalWiggle: function (freq, amp, octaves, ampMult, t) {
    octaves = octaves === undefined ? 1 : __v(octaves);
    ampMult = ampMult === undefined ? 0.5 : __v(ampMult);
    t = t === undefined ? time : __v(t);
    var off = __wig(__hstr(this.__seed()), 1, __v(freq), __v(amp), octaves, ampMult, t);
    return this.valueAtTime(t + off[0]);
  },
  smooth: function (width, samples, t) {
    width = width === undefined ? 0.2 : __v(width);
    samples = samples === undefined ? 5 : __v(samples);
    t = t === undefined ? time : __v(t);
    samples = Math.max(1, Math.round(samples));
    if (samples === 1) return this.valueAtTime(t);
    var vals = [];
    for (var i = 0; i < samples; i++) vals.push(this.valueAtTime(t - width / 2 + width * i / (samples - 1)));
    return __avg(vals);
  },
  loopOut: function (type, n) { return __loop(this, true, type, n || 0); },
  loopIn: function (type, n) { return __loop(this, false, type, n || 0); },
  loopOutDuration: function (type, d) { return __loop(this, true, type, 0, d === undefined ? 0 : __v(d)); },
  loopInDuration: function (type, d) { return __loop(this, false, type, 0, d === undefined ? 0 : __v(d)); },
  // Source Text style (read-only): text.sourceText.style.fontSize, getStyleAt(i, t).
  get style() { return this.getStyleAt(0); },
  getStyleAt: function (i, t) {
    var d = __h(__TEXT, this.__s, this.__o, t === undefined ? time : __v(t));
    if (d === null) __err('Property "' + this.name + '" is not a Source Text property');
    return new __TextStyle(d, i === undefined ? 0 : Math.floor(__v(i)));
  },
  valueOf: function () { return this.value; },
  toString: function () { return String(this.value); },
};

var __propHandler = {
  get: function (t, k) {
    if (typeof k !== 'string' || k in t) return t[k];
    var v = t.value;
    if (v === null || v === undefined) return undefined;
    var x = v[k];
    // Methods of the value bind to it; property groups (callable proxies) pass through untouched.
    return typeof x === 'function' && !x.__isGroup ? x.bind(v) : x;
  },
};

function __mkProp(seq, owner, path) {
  return new Proxy(new Prop(seq, owner, path), __propHandler);
}

// Text style (read-only view of a text clip's base style and runs).
function __TextStyle(d, i) { this.__d = d; this.__i = i; }
__TextStyle.prototype = {
  __isTextStyle: true,
  __at: function (key) {
    var runs = this.__d.runs || [];
    for (var k = runs.length - 1; k >= 0; k--) {
      var r = runs[k];
      if (this.__i >= r.from && this.__i < r.to && r.style[key] !== undefined) return r.style[key];
    }
    return this.__d.style[key];
  },
  get text() { return this.__d.text; },
  get font() { return this.__at('font'); },
  get fontSize() { return this.__at('fontSize'); },
  get fillColor() { var c = this.__at('fillColor'); return [c[0], c[1], c[2]]; },
  get applyFill() { return true; },
  get applyStroke() { return this.__at('applyStroke'); },
  get strokeColor() { var c = this.__at('strokeColor'); return [c[0], c[1], c[2]]; },
  get strokeWidth() { return this.__at('strokeWidth'); },
  get tracking() { return this.__at('tracking'); },
  get leading() { return this.__at('leading'); },
  get autoLeading() { return false; },
  get isFauxBold() { return this.__at('fontWeight') >= 600; },
  get fontWeight() { return this.__at('fontWeight'); },
  get isFauxItalic() { return this.__at('isFauxItalic'); },
  get isAllCaps() { return this.__at('isAllCaps'); },
  get isSmallCaps() { return false; },
  get justification() { return this.__at('justification'); },
  get baselineShift() { return 0; },
  toString: function () { return this.text; },
  valueOf: function () { return this.text; },
};
Object.defineProperty(__TextStyle.prototype, 'length', { get: function () { return this.text.length; } });

// Markers: [time, duration, comment, name, chapter, url, type, color].
function Markers(seq, owner) { this.__s = seq; this.__o = owner; this.__m = null; }
Markers.prototype = {
  get __list() { return this.__m || (this.__m = __h(__MARKERS, this.__s, this.__o)); },
  get numKeys() { return this.__list.length; },
  key: function (n) {
    n = __v(n);
    var list = this.__list, i;
    if (typeof n === 'string') {
      for (i = 0; i < list.length; i++) if (list[i][3] === n || list[i][2] === n) return this.key(i + 1);
      __err('Marker "' + n + '" not found');
    }
    if (!(n >= 1 && n <= list.length)) __err('Marker index ' + n + ' out of range');
    n = Math.floor(n);
    var m = list[n - 1];
    return {
      time: m[0], duration: m[1], comment: m[2], name: m[3], chapter: m[4], url: m[5], type: m[6], color: m[7],
      index: n, frameTarget: '', eventCuePoint: false, cuePointName: '', parameters: {}, protectedRegion: false,
    };
  },
  nearestKey: function (t) {
    t = __v(t);
    var list = this.__list;
    if (list.length === 0) __err('No markers');
    var best = 0;
    for (var i = 1; i < list.length; i++) if (Math.abs(list[i][0] - t) < Math.abs(list[best][0] - t)) best = i;
    return this.key(best + 1);
  },
};

// ---------------------------------------------------------------------------------------------
// Unqualified names: thisLayer / thisProperty attributes and the this* objects. Accessors on the global object;
// assigning one (width = 10) shadows it for the current evaluation only.

function __global(name, get) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get: function () { return name in __S.vars ? __S.vars[name] : get(); },
    set: function (v) { __S.vars[name] = v; },
  });
}

__global('thisComp', function () { return __S.comp || (__S.comp = new Comp(__S.seq)); });
__global('thisLayer', function () { return __S.layer || (__S.layer = new Layer(__S.seq, __S.owner)); });
__global('thisProperty', function () { return __S.prop || (__S.prop = __mkProp(__S.seq, __S.owner, __S.path)); });
__global('colorDepth', function () { return 8; });
['name', 'index', 'inPoint', 'outPoint', 'startTime', 'width', 'height', 'hasParent', 'parent', 'hasVideo', 'hasAudio',
  'enabled', 'active', 'audioActive', 'transform', 'position', 'scale', 'rotation', 'opacity', 'anchorPoint', 'text', 'marker',
  'audioLevels', 'source'].forEach(function (k) {
  __global(k, function () { return thisLayer[k]; });
});
['numKeys', 'velocity', 'speed'].forEach(function (k) {
  __global(k, function () { return thisProperty[k]; });
});

function effect(k) { return thisLayer.effect(k); }
function mask(k) { return thisLayer.mask(k); }
function content(k) { return thisLayer.content(k); }
function toComp(p, t) { return thisLayer.toComp(p, t); }
function fromComp(p, t) { return thisLayer.fromComp(p, t); }
function toWorld(p, t) { return thisLayer.toWorld(p, t); }
function fromWorld(p, t) { return thisLayer.fromWorld(p, t); }
function toCompVec(p, t) { return thisLayer.toCompVec(p, t); }
function fromCompVec(p, t) { return thisLayer.fromCompVec(p, t); }
function toWorldVec(p, t) { return thisLayer.toWorldVec(p, t); }
function fromWorldVec(p, t) { return thisLayer.fromWorldVec(p, t); }
function sourceRectAtTime(t, e) { return thisLayer.sourceRectAtTime(t, e); }
function sampleImage(p, r, post, t) { return thisLayer.sampleImage(p, r, post, t); }

function wiggle(f, a, o, m, t) { return thisProperty.wiggle(f, a, o, m, t); }
function temporalWiggle(f, a, o, m, t) { return thisProperty.temporalWiggle(f, a, o, m, t); }
function smooth(w, s, t) { return thisProperty.smooth(w, s, t); }
function loopOut(type, n) { return thisProperty.loopOut(type, n); }
function loopIn(type, n) { return thisProperty.loopIn(type, n); }
function loopOutDuration(type, d) { return thisProperty.loopOutDuration(type, d); }
function loopInDuration(type, d) { return thisProperty.loopInDuration(type, d); }
function valueAtTime(t) { return thisProperty.valueAtTime(t); }
function velocityAtTime(t) { return thisProperty.velocityAtTime(t); }
function speedAtTime(t) { return thisProperty.speedAtTime(t); }
function key(n) { return thisProperty.key(n); }
function nearestKey(t) { return thisProperty.nearestKey(t); }
`;
