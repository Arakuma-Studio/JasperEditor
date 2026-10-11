// The host agent (security review MG-1): the part of the live frame host that runs INSIDE a bundle's page.
//
// Bundles are untrusted code: their iframe omits allow-same-origin, giving it an opaque origin without
// cookies, storage, or access to the parent and desktop bridge. A capability path and Content-Security-Policy
// restrict loading; the editor communicates only through one MessagePort. This agent drives the renderer-page
// protocol and text probe at the other end of that port.
//
// The whole API is the `ops` table below: seven operations, plain JSON in, plain JSON out (font data as
// ArrayBuffers). Nothing here is trusted by the editor either: remote.ts validates every reply, because the
// bundle's own scripts share this realm and can answer in the agent's place.
//
// Plain ES2019 in a string, like the text probe: it runs in another document, so no bundler helper may leak in.

import { MG_HOST_REMOTION_VERSION, MG_HOST_REQUIRED_GLOBALS, MG_HOST_SITE_VERSION } from './constants.ts';

/** `data.jasperMgHost` of the message that hands the agent its port. */
export const MG_HOST_CONNECT = 'connect';
/** Version of the port protocol (the agent's hello carries it). */
export const MG_HOST_PORT_PROTOCOL = 1;

export const HOST_AGENT_SCRIPT = String.raw`(function(){
var W = window;
if (W.__jasperMgAgent) return;
W.__jasperMgAgent = 1;
var REQUIRED = ${JSON.stringify(MG_HOST_REQUIRED_GLOBALS)};
var REMOTION = ${JSON.stringify(MG_HOST_REMOTION_VERSION)};
var SITE = ${JSON.stringify(MG_HOST_SITE_VERSION)};
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// anime-allow: wall-clock timeouts of the page protocol, never animation time
function now() { return Date.now(); }
function fail(code, message) { var e = new Error(message); e.code = code; return e; }
function firstLine(v) { return String(v && v.message !== undefined ? v.message : v).split('\n')[0]; }
function check() {
	var missing = REQUIRED.filter(function (k) { return W[k] === undefined; });
	var rv = typeof W.remotion_version === 'string' ? W.remotion_version : null;
	var sv = typeof W.siteVersion === 'string' ? W.siteVersion : null;
	if (rv !== null && rv !== REMOTION) missing.push('remotion_version=' + REMOTION + ' (found ' + rv + ')');
	if (sv !== null && sv !== SITE) missing.push('siteVersion=' + SITE + ' (found ' + sv + ')');
	return { ok: missing.length === 0, missing: missing, remotionVersion: rv, siteVersion: sv };
}
async function ready(timeout) {
	var until = now() + timeout;
	for (;;) {
		if (typeof W.remotion_cancelledError === 'string') throw fail('MG_HOST_CANCELLED', W.remotion_cancelledError.split('\n')[0] || 'cancelled');
		if (W.remotion_renderReady === true) break;
		if (now() > until) throw fail('MG_HOST_TIMEOUT', 'The composition page was not ready after ' + timeout + ' ms');
		await sleep(8);
	}
	try { await Promise.race([document.fonts.ready, sleep(2000)]); } catch (e) {}
}
async function waitPage(timeout) {
	var until = now() + timeout;
	for (;;) {
		var c = check();
		if (c.ok) return;
		if (c.remotionVersion && c.remotionVersion !== REMOTION) throw fail('MG_HOST_PROTOCOL', 'Unsupported bundle: ' + c.missing.join(', '));
		if (now() > until) throw fail('MG_HOST_PROTOCOL', 'The bundle page does not implement the Remotion ' + REMOTION + ' page protocol (missing ' + c.missing.join(', ') + ')');
		await sleep(10);
	}
}
async function waitComposition(id, timeout) {
	if (typeof W.remotion_getCompositionNames !== 'function') return;
	var until = now() + Math.min(timeout, 10000);
	for (;;) {
		try { if (W.remotion_getCompositionNames().indexOf(id) >= 0) return; } catch (e) {}
		if (now() > until) return;
		await sleep(10);
	}
}
var evaluated = false, configured = null, metadata = null, frame = null;
function publicMeta(m) { return { width: m.width, height: m.height, fps: m.fps, durationInFrames: m.durationInFrames }; }
async function seekNow(id, f, timeout) {
	if (typeof W.remotion_setFrame !== 'function') throw fail('MG_HOST_PROTOCOL', 'remotion_setFrame is missing (no composition mounted)');
	var max = Math.max(0, ((metadata && metadata.durationInFrames) || f + 1) - 1);
	var n = Math.max(0, Math.min(max, Math.round(f)));
	if (n === frame) return n;
	W.remotion_setFrame(n, id, 1);
	await ready(timeout);
	frame = n;
	return n;
}
async function configure(cfg, timeout) {
	var key = JSON.stringify([cfg.compositionId, cfg.props, cfg.override || null]);
	if (key === configured && metadata) return publicMeta(metadata);
	await waitPage(timeout);
	W.remotion_inputProps = JSON.stringify(cfg.props || {});
	if (!evaluated) {
		W.remotion_setBundleMode({ type: 'evaluation' });
		await ready(timeout);
		evaluated = true;
	}
	// Compositions register from React effects of the evaluated root: wait until ours is there.
	await waitComposition(cfg.compositionId, timeout);
	var meta;
	try { meta = await W.remotion_calculateComposition(cfg.compositionId); }
	catch (e) { throw fail('MG_HOST_NO_COMPOSITION', firstLine(e)); }
	var o = cfg.override || {};
	var resolved = {
		width: o.width != null ? o.width : meta.width,
		height: o.height != null ? o.height : meta.height,
		fps: o.fps != null ? o.fps : meta.fps,
		durationInFrames: o.durationInFrames != null ? o.durationInFrames : meta.durationInFrames
	};
	W.remotion_setBundleMode({
		type: 'composition',
		compositionName: cfg.compositionId,
		serializedResolvedPropsWithSchema: meta.serializedResolvedPropsWithCustomSchema,
		compositionDurationInFrames: resolved.durationInFrames,
		compositionFps: resolved.fps,
		compositionHeight: resolved.height,
		compositionWidth: resolved.width,
		compositionDefaultCodec: meta.defaultCodec || 'h264',
		compositionDefaultOutName: meta.defaultOutName || null,
		compositionDefaultVideoImageFormat: meta.defaultVideoImageFormat || null,
		compositionDefaultPixelFormat: meta.defaultPixelFormat || null,
		compositionDefaultProResProfile: meta.defaultProResProfile || null,
		compositionDefaultSampleRate: meta.defaultSampleRate || 48000
	});
	await ready(timeout);
	configured = key;
	metadata = resolved;
	// A new tree starts at the initial frame: show the last requested frame again.
	if (frame !== null) { var f = frame; frame = null; await seekNow(cfg.compositionId, f, timeout); }
	return publicMeta(resolved);
}
// Calls are serialized: configure (props / metadata) and seek (frame) each resolve when the page is ready.
var chain = Promise.resolve();
function run(fn) { var next = chain.then(fn, fn); chain = next.catch(function () {}); return next; }
function timeoutOf(a) { var t = Number(a && a.timeoutMs); return isFinite(t) && t >= 1000 ? Math.min(t, 300000) : 30000; }
function probe() { var t = W.__jasperTexts; return t && typeof t.locate === 'function' ? t : null; }
var ops = {
	check: function () { return check(); },
	configure: function (a) { return run(function () { return configure(a.config || {}, timeoutOf(a)); }); },
	seek: function (a) { return run(function () { return seekNow(String(a.compositionId), Number(a.frame) || 0, timeoutOf(a)); }); },
	locate: function (a) { var t = probe(); return t ? t.locate(a.items || [], a.frame || { width: 0, height: 0 }) : null; },
	fonts: function () { var t = probe(); return t ? t.fonts() : []; },
	hide: function (a) { var t = probe(); return t ? !!t.hide(String(a.text)) : false; },
	restore: function () { var t = probe(); if (t) t.restore(); return true; }
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
// The editor hands over the port once per page load. Only the embedding window may: a message from anything else
// (the bundle's own frames, a window it opened) is ignored.
W.addEventListener('message', function (ev) {
	var d = ev.data;
	if (ev.source !== W.parent || !d || d.jasperMgHost !== ${JSON.stringify('connect')} || !ev.ports || !ev.ports[0]) return;
	serve(ev.ports[0]);
});
})();`;
