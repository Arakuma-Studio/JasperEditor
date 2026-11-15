// The host agent of an HTML composition page (docs/wp-notes/html-compositions.md): the counterpart of agent.ts for
// pages that implement the HTML composition contract instead of the Remotion page protocol:
//
//   window.__duration   length in seconds (a finite number > 0)
//   window.__ready      a Promise that settles when fonts and images are loaded
//   window.__seek(t)    puts the whole page at time t (seconds); pure and deterministic
//
// It runs inside the page, before the page's own scripts, in the editor's sandboxed live host (over the same
// MessagePort API as agent.ts: check / configure / seek, no texts) and in the engine's headless renders, which call
// `window.__jasperHtmlHost` directly. Both drive the page the same way, so the Program monitor shows the frames the
// export renders. The page sees `navigator.webdriver === true` in both (pages commonly play themselves in real time
// when it is false). Nothing here is trusted by the editor or the engine: they validate every reply.
//
// Plain ES2019 in a string, like agent.ts: it runs in another document, so no bundler helper may leak in.

import { MG_HOST_CONNECT, MG_HOST_PORT_PROTOCOL } from './agent.ts';

/** The contract globals, in the order errors name them. */
export const HTML_CONTRACT_GLOBALS = ['__seek', '__duration', '__ready'] as const;
/** Longest composition an HTML page may declare (seconds). */
export const HTML_MAX_DURATION_SEC = 3600;
/** How long after the page's `load` event the contract globals may still appear. */
export const HTML_CONTRACT_GRACE_MS = 3000;

export const HTML_HOST_AGENT_SCRIPT = String.raw`(function(){
var W = window;
if (W.__jasperMgAgent) return;
W.__jasperMgAgent = 1;
// Driven, never playing by itself: what headless renderers (Puppeteer, Remotion) report.
try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: function () { return true; }, configurable: true }); } catch (e) {}
var GLOBALS = ${JSON.stringify(HTML_CONTRACT_GLOBALS)};
var MAX_DURATION = ${HTML_MAX_DURATION_SEC};
var GRACE = ${HTML_CONTRACT_GRACE_MS};
var pageErrors = [];
function firstLine(v) { return String(v && v.message !== undefined ? v.message : v).split('\n')[0].slice(0, 300); }
function noteError(text) { if (pageErrors.length < 5) pageErrors.push(text); }
W.addEventListener('error', function (ev) {
	if (!ev || ev.target !== W) return;
	var file = String(ev.filename || '').split('?')[0];
	// Lines of the page itself are counted without the bootstrap the engine inserted into it.
	var shift = file && file === String(location.href).split('?')[0] ? Number(W.__jasperHtmlLineShift) || 0 : 0;
	var where = file ? ' (' + file.split('/').pop() + ':' + Math.max(1, ev.lineno - shift) + ')' : '';
	noteError(firstLine(ev.error || ev.message) + where);
}, true);
W.addEventListener('unhandledrejection', function (ev) { noteError('unhandled rejection: ' + firstLine(ev && ev.reason)); });
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// anime-allow: wall-clock timeouts of the page contract, never animation time
function now() { return Date.now(); }
function fail(code, message, detail) { var e = new Error(message); e.code = code; e.detail = detail || {}; return e; }
function missing() {
	var out = [];
	if (typeof W.__seek !== 'function') out.push('__seek');
	if (W.__duration === undefined || W.__duration === null) out.push('__duration');
	if (!W.__ready || (typeof W.__ready.then !== 'function' && typeof W.__ready !== 'function')) out.push('__ready');
	return out;
}
function check() { var m = missing(); return { ok: m.length === 0, missing: m, remotionVersion: null, siteVersion: null, pageErrors: pageErrors.slice() }; }
async function waitContract(timeout) {
	var until = now() + timeout;
	var loadedAt = null;
	for (;;) {
		var m = missing();
		if (m.length === 0) return;
		if (document.readyState === 'complete' && loadedAt === null) loadedAt = now();
		if ((loadedAt !== null && now() - loadedAt > GRACE) || now() > until) {
			var names = m.map(function (k) { return 'window.' + k; }).join(', ');
			throw fail('HTML_CONTRACT_MISSING',
				'The page does not implement the HTML composition contract: ' + names + (m.length === 1 ? ' is' : ' are') + ' missing' +
				(pageErrors.length ? '; the page threw: ' + pageErrors.join(' | ') : ''),
				{ missing: m, pageErrors: pageErrors.slice() });
		}
		await sleep(10);
	}
}
var readyPromise = null;
function awaitReady(timeout) {
	if (!readyPromise) readyPromise = new Promise(function (resolve, reject) {
		var timer = setTimeout(function () {
			reject(fail('HTML_READY_TIMEOUT', 'window.__ready did not settle within ' + timeout + ' ms', { timeoutMs: timeout }));
		}, timeout);
		var p;
		try { p = typeof W.__ready === 'function' ? W.__ready() : W.__ready; } catch (e) { p = Promise.reject(e); }
		Promise.resolve(p).then(function () { clearTimeout(timer); resolve(); }, function (e) {
			clearTimeout(timer);
			reject(fail('HTML_READY_FAILED', 'window.__ready rejected: ' + firstLine(e), { reason: firstLine(e) }));
		});
	}).then(function () { return Promise.race([document.fonts ? document.fonts.ready : null, sleep(2000)]); });
	return readyPromise;
}
function durationSec() {
	var raw = W.__duration;
	var d = typeof raw === 'number' ? raw : NaN;
	if (!isFinite(d) || d <= 0 || d > MAX_DURATION)
		throw fail('HTML_DURATION_INVALID',
			'window.__duration must be the length in seconds (a finite number > 0 and ≤ ' + MAX_DURATION + '), got ' + String(raw).slice(0, 60),
			{ duration: String(raw).slice(0, 60) });
	return d;
}
// Resolves after n animation frames (the page's own rAF work after a seek is drawn); fallbackMs > 0 also resolves
// after that long (a live host in a hidden tab gets no animation frames).
function frames(n, fallbackMs) {
	return new Promise(function (resolve) {
		var done = false, left = n;
		function tick() { if (done) return; if (--left <= 0) { done = true; resolve(); } else requestAnimationFrame(tick); }
		requestAnimationFrame(tick);
		if (fallbackMs > 0) setTimeout(function () { if (!done) { done = true; resolve(); } }, fallbackMs);
	});
}
var meta = null, frame = null;
function publicMeta(m) { return { width: m.width, height: m.height, fps: m.fps, durationInFrames: m.durationInFrames, durationSec: m.durationSec }; }
async function configure(cfg, timeout) {
	await waitContract(timeout);
	await awaitReady(timeout);
	var d = durationSec();
	var o = (cfg && cfg.override) || {};
	var fps = Number(o.fps) > 0 ? Number(o.fps) : 30;
	meta = {
		width: o.width != null ? o.width : W.innerWidth,
		height: o.height != null ? o.height : W.innerHeight,
		fps: fps,
		durationInFrames: o.durationInFrames != null ? o.durationInFrames : Math.max(1, Math.round(d * fps)),
		durationSec: d
	};
	return publicMeta(meta);
}
async function seekNow(f, timeout, fallbackMs) {
	if (!meta) throw fail('MG_HOST_PROTOCOL', 'The page is not configured');
	var max = Math.max(0, meta.durationInFrames - 1);
	var n = Math.max(0, Math.min(max, Math.round(Number(f) || 0)));
	if (n === frame) return n;
	frame = null;
	var t = n / meta.fps;
	try {
		var r = W.__seek(t);
		if (r && typeof r.then === 'function')
			await Promise.race([r, sleep(timeout).then(function () { throw new Error('the Promise it returned did not settle within ' + timeout + ' ms'); })]);
	} catch (e) {
		throw fail('HTML_SEEK_FAILED', 'window.__seek(' + t + ') threw: ' + firstLine(e), { t: t, reason: firstLine(e) });
	}
	await frames(2, fallbackMs);
	frame = n;
	return n;
}
var chain = Promise.resolve();
function run(fn) { var next = chain.then(fn, fn); chain = next.catch(function () {}); return next; }
function timeoutOf(a) { var t = Number(a && a.timeoutMs); return isFinite(t) && t >= 1000 ? Math.min(t, 300000) : 30000; }
function asResult(p) {
	return p.then(function (v) { return { ok: true, value: v }; }, function (e) {
		return { ok: false, code: String((e && e.code) || 'MG_HOST_PROTOCOL'), message: firstLine(e), detail: (e && e.detail) || {} };
	});
}
// The engine's headless renders call these directly (results, never exceptions, cross the evaluate boundary).
W.__jasperHtmlHost = {
	check: check,
	configure: function (cfg, timeoutMs) { return asResult(run(function () { return configure(cfg, timeoutOf({ timeoutMs: timeoutMs })); })); },
	seek: function (f, timeoutMs) { return asResult(run(function () { return seekNow(f, timeoutOf({ timeoutMs: timeoutMs }), 0); })); }
};
// The editor's live host: the port API of agent.ts.
var ops = {
	check: function () { return check(); },
	configure: function (a) { return run(function () { return configure(a.config || {}, timeoutOf(a)); }); },
	seek: function (a) { return run(function () { return seekNow(a.frame, timeoutOf(a), 250); }); },
	locate: function () { return null; },
	fonts: function () { return []; },
	hide: function () { return false; },
	restore: function () { return true; }
};
function serve(port) {
	port.onmessage = function (ev) {
		var m = ev.data || {};
		var id = m.id;
		Promise.resolve().then(function () {
			if (typeof m.op !== 'string' || !Object.prototype.hasOwnProperty.call(ops, m.op)) throw fail('MG_HOST_PROTOCOL', 'Unknown operation');
			return ops[m.op](m.args || {});
		}).then(function (result) {
			port.postMessage({ id: id, ok: true, result: result });
		}, function (e) {
			try { port.postMessage({ id: id, ok: false, error: { code: String((e && e.code) || 'MG_HOST_PROTOCOL'), message: firstLine(e) } }); } catch (e2) {}
		});
	};
	port.postMessage({ hello: ${MG_HOST_PORT_PROTOCOL} });
}
W.addEventListener('message', function (ev) {
	var d = ev.data;
	if (ev.source !== W.parent || !d || d.jasperMgHost !== ${JSON.stringify(MG_HOST_CONNECT)} || !ev.ports || !ev.ports[0]) return;
	serve(ev.ports[0]);
});
})();`;
