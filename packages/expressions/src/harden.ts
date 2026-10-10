// Realm hardening (docs/security-review.md, finding EXPR-1). Evaluated once per QuickJS context right after the
// prelude, before any expression runs.
//
// One realm serves every document a process evaluates (all projects of an engine, every project a tab opens), so
// nothing an expression does may outlive its own evaluation: without this, `Math.sin = …`,
// `Array.prototype.map = null` or `JSON.stringify = …` in one (hostile or buggy) project silently changed the
// results of every later expression in every project, and preview could differ from export depending on what ran
// first. The script
//
// 1. closes the last path to the real clock: `new Date(0).constructor` was the original `Date` (its `now()` and
//    zero-argument construction read the wall clock);
// 2. removes ways to detach the prelude's scratch buffers (`ArrayBuffer.prototype.transfer*`);
// 3. "tames" a few inherited data properties that ordinary code overrides on its own objects (`toString`,
//    `valueOf`, `constructor`, error `name`/`message`): they become accessors whose setter defines an own
//    property, so freezing their prototypes does not make `obj.toString = f` fail silently (the "override
//    mistake");
// 4. deep-freezes every object reachable from the global object (built-ins, hidden intrinsics such as the
//    generator and iterator prototypes, and the prelude's own prototypes and handlers);
// 5. makes every global binding non-configurable and, except the per-evaluation state the prelude itself rewrites
//    (`time`, `value`, `__S`, …, all restored by `__run`), read-only, and makes the global object non-extensible.
//    Implicit globals (`x = 5` without `var`) are declared as locals of the compiled function instead
//    (compile.ts), so they keep working inside one evaluation and vanish with it.
//
// This text is a template literal: no backticks, dollar-brace sequences or backslashes.
export const HARDEN = `
(function () {
  var STATE = { time: 1, value: 1, __S: 1, __memo: 1, textIndex: 1, textTotal: 1, selectorValue: 1 };
  var G = globalThis;
  var getProto = Object.getPrototypeOf, ownKeys = Reflect.ownKeys, getDesc = Object.getOwnPropertyDescriptor;
  var defProp = Object.defineProperty, freeze = Object.freeze, isFrozen = Object.isFrozen;

  // 1. The original Date: unreachable, and frozen in time even if it were reached.
  var RealDate = getProto(new Date(0)).constructor;
  if (RealDate !== Date) {
    RealDate.now = Date.now;
    defProp(RealDate.prototype, 'constructor', { value: Date, writable: false, enumerable: false, configurable: false });
  }

  // 2. Detaching the hash scratch buffers would change every later random()/wiggle()/noise().
  ['transfer', 'transferToFixedLength'].forEach(function (k) {
    if (typeof ArrayBuffer === 'function' && getDesc(ArrayBuffer.prototype, k)) delete ArrayBuffer.prototype[k];
  });

  // 3. Override-mistake taming.
  function tame(obj, key) {
    var d = getDesc(obj, key);
    if (!d || !('value' in d) || !d.configurable) return;
    var v = d.value;
    defProp(obj, key, {
      get: function () { return v; },
      set: function (nv) {
        if (this === obj) throw new TypeError('Cannot assign to read only property ' + String(key));
        if (Object.prototype.hasOwnProperty.call(this, key)) {
          var own = getDesc(this, key);
          if (own && own.set) { own.set.call(this, nv); return; }
          if (own && own.writable === false) throw new TypeError('Cannot assign to read only property ' + String(key));
        }
        defProp(this, key, { value: nv, writable: true, enumerable: true, configurable: true });
      },
      enumerable: d.enumerable,
      configurable: false,
    });
  }
  ['constructor', 'toString', 'valueOf', 'toLocaleString'].forEach(function (k) { tame(Object.prototype, k); });
  var errors = [Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError];
  if (typeof AggregateError === 'function') errors.push(AggregateError);
  if (typeof InternalError === 'function') errors.push(InternalError);
  errors.forEach(function (E) {
    ['name', 'message', 'constructor', 'toString'].forEach(function (k) { tame(E.prototype, k); });
  });
  ['constructor', 'toString'].forEach(function (k) { tame(Function.prototype, k); });

  // 4. Deep freeze.
  var seen = new Set();
  function isView(o) {
    return typeof ArrayBuffer === 'function' && ArrayBuffer.isView(o);
  }
  function deepFreeze(o) {
    if (o === null || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o)) return;
    seen.add(o);
    // Typed arrays with elements cannot be frozen; their prototype chain and properties still are.
    if (o !== G && !isView(o)) freeze(o);
    var keys = ownKeys(o);
    for (var i = 0; i < keys.length; i++) {
      var d = getDesc(o, keys[i]);
      if (!d) continue;
      if (o === G && Object.prototype.hasOwnProperty.call(STATE, keys[i])) continue;
      if ('value' in d) deepFreeze(d.value);
      else {
        deepFreeze(d.get);
        deepFreeze(d.set);
      }
    }
    deepFreeze(getProto(o));
  }
  // Intrinsics only reachable through syntax or instances.
  var hidden = [];
  function add(f) { try { var v = f(); if (v) hidden.push(v); } catch (e) {} }
  add(function () { return getProto(function* () {}); });
  add(function () { return getProto(function* () {}).prototype; });
  add(function () { return getProto(async function () {}); });
  add(function () { return getProto(async function* () {}); });
  add(function () { return getProto(async function* () {}).prototype; });
  add(function () { return getProto([][Symbol.iterator]()); });
  add(function () { return getProto(getProto([][Symbol.iterator]())); });
  add(function () { return getProto(new Map()[Symbol.iterator]()); });
  add(function () { return getProto(new Set()[Symbol.iterator]()); });
  add(function () { return getProto(''[Symbol.iterator]()); });
  add(function () { return getProto('a'.matchAll(/a/g)); });
  add(function () { return getProto(Int8Array); });
  add(function () { return getDesc(Function.prototype, 'caller').get; });
  add(function () { return getDesc(arguments, 'callee').get; });
  for (var h = 0; h < hidden.length; h++) deepFreeze(hidden[h]);
  deepFreeze(G);

  // 5. Global bindings: read-only (except the evaluation state) and non-configurable; no new globals.
  var names = ownKeys(G);
  for (var n = 0; n < names.length; n++) {
    var k = names[n];
    var d = getDesc(G, k);
    if (!d) continue;
    if ('value' in d) {
      var writable = Object.prototype.hasOwnProperty.call(STATE, k);
      if (d.configurable || (d.writable && !writable))
        defProp(G, k, { value: d.value, writable: writable, enumerable: d.enumerable, configurable: false });
    } else if (d.configurable) {
      defProp(G, k, { get: d.get, set: d.set, enumerable: d.enumerable, configurable: false });
    }
  }
  Object.preventExtensions(G);
  if (!isFrozen(Object.prototype)) throw new Error('hardening failed: Object.prototype is not frozen');
})();
`;
