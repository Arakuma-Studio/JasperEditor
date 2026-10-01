// Text probe of the live frame host (M3, wp-m3-mgtext, S08:MGC-037/039, MGU-005): a small script the host
// bootstrap installs in a bundle's page (before the bundle's own scripts) as `window.__jasperTexts`. It
//   - records the sources of the fonts the bundle registers with the FontFace API (`@remotion/fonts`,
//     `new FontFace(…)`) and reads `@font-face` rules, so the editor can draw with the bundle's own fonts;
//   - locates a text (a prop value) in the rendered frame — by its characters, ignoring whitespace, case and
//     `*_~` markup, so copy split into spans / rows still matches — and reports its boxes, rendered lines,
//     clipping, ellipsis and computed style (layout checks, on-canvas editing);
//   - hides / restores a located text while the on-canvas editor replaces it.
// Plain ES2019 in a string (it runs in another document; no bundler helpers can leak into it). The page is
// laid out at the composition size from (0, 0), so client coordinates are composition pixels.

import type { MgTextMeasurement } from '@jasper/project';

export const TEXT_PROBE_SCRIPT = String.raw`(function(){
var W = window;
if (W.__jasperTexts) return;
var fontSources = [];
function absUrls(src, base) {
	return String(src).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
		try { return 'url("' + new URL(u, base || document.baseURI).href + '")'; } catch (e) { return m; }
	});
}
var NativeFontFace = W.FontFace;
if (typeof NativeFontFace === 'function') {
	var Recording = function FontFace(family, source, descriptors) {
		var face = descriptors === undefined ? new NativeFontFace(family, source) : new NativeFontFace(family, source, descriptors);
		try {
			var d = descriptors || {};
			var e = { family: String(family).replace(/^['"]|['"]$/g, ''), weight: String(d.weight || 'normal'), style: String(d.style || 'normal'), stretch: d.stretch ? String(d.stretch) : undefined, unicodeRange: d.unicodeRange ? String(d.unicodeRange) : undefined };
			if (typeof source === 'string') e.source = absUrls(source);
			else e.buffer = source;
			fontSources.push(e);
		} catch (err) {}
		return face;
	};
	Recording.prototype = NativeFontFace.prototype;
	W.FontFace = Recording;
}
function cssFonts() {
	var out = [];
	var sheets = document.styleSheets;
	for (var i = 0; i < sheets.length; i++) {
		var rules;
		try { rules = sheets[i].cssRules; } catch (e) { continue; }
		if (!rules) continue;
		for (var j = 0; j < rules.length; j++) {
			var r = rules[j];
			if (!r || r.type !== 5) continue;
			var st = r.style;
			var fam = st.getPropertyValue('font-family').trim().replace(/^['"]|['"]$/g, '');
			var src = st.getPropertyValue('src');
			if (!fam || !src) continue;
			out.push({ family: fam, source: absUrls(src, sheets[i].href || document.baseURI), weight: st.getPropertyValue('font-weight') || 'normal', style: st.getPropertyValue('font-style') || 'normal', unicodeRange: st.getPropertyValue('unicode-range') || undefined });
		}
	}
	return out;
}
function fonts() {
	var all = fontSources.concat(cssFonts());
	var loaded = {};
	try { document.fonts.forEach(function (f) { if (f.status === 'loaded') loaded[String(f.family).replace(/^['"]|['"]$/g, '')] = true; }); } catch (e) {}
	return all.map(function (f) { var c = Object.assign({}, f); c.loaded = !!loaded[f.family]; return c; });
}
var STRIP = /[\s ​-‍⁠﻿*_~]/;
function norm(s) {
	var out = '';
	var t = String(s).normalize('NFC');
	for (var i = 0; i < t.length; i++) { var ch = t[i]; if (!STRIP.test(ch)) out += ch.toLowerCase(); }
	return out;
}
function indexPage() {
	var flat = '';
	var map = [];
	if (!document.body) return { flat: flat, map: map };
	var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
		acceptNode: function (n) {
			var p = n.parentElement;
			if (!p) return NodeFilter.FILTER_REJECT;
			var tag = p.tagName;
			if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		}
	});
	var n;
	while ((n = walker.nextNode())) {
		var d = n.data;
		for (var i = 0; i < d.length; i++) {
			var ch = d[i];
			if (STRIP.test(ch)) continue;
			var lo = ch.toLowerCase();
			for (var k = 0; k < lo.length; k++) { flat += lo[k]; map.push([n, i]); }
		}
	}
	return { flat: flat, map: map };
}
function rectOf(r) { return { x: r.left, y: r.top, width: r.width, height: r.height }; }
function union(rects) {
	if (!rects.length) return null;
	var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
	rects.forEach(function (x) { l = Math.min(l, x.x); t = Math.min(t, x.y); r = Math.max(r, x.x + x.width); b = Math.max(b, x.y + x.height); });
	return { x: l, y: t, width: r - l, height: b - t };
}
function lineBoxes(rects) {
	var sorted = rects.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; });
	var lines = [];
	sorted.forEach(function (r) {
		var cy = r.y + r.height / 2;
		var line = null;
		for (var i = 0; i < lines.length; i++) { var L = lines[i]; if (cy >= L.y && cy <= L.y + L.height) { line = L; break; } }
		if (!line) lines.push({ x: r.x, y: r.y, width: r.width, height: r.height });
		else { var u = union([line, r]); line.x = u.x; line.y = u.y; line.width = u.width; line.height = u.height; }
	});
	return lines;
}
function opacityOf(el) {
	var o = 1;
	for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
		var cs = getComputedStyle(e);
		if (cs.display === 'none') return 0;
		o *= Number(cs.opacity);
		if (o <= 0.01) return 0;
	}
	var vis = getComputedStyle(el).visibility;
	return vis === 'hidden' || vis === 'collapse' ? 0 : o;
}
function px(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
function styleOf(el) {
	var cs = getComputedStyle(el);
	return { fontFamily: cs.fontFamily, fontSize: px(cs.fontSize) || 16, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, color: cs.color, lineHeight: px(cs.lineHeight), letterSpacing: px(cs.letterSpacing) || 0, textAlign: cs.textAlign, textTransform: cs.textTransform, whiteSpace: cs.whiteSpace };
}
function rangeOf(idx, hit, len) {
	var s = idx.map[hit], e = idx.map[hit + len - 1];
	var range = document.createRange();
	range.setStart(s[0], s[1]);
	range.setEnd(e[0], Math.min(e[0].data.length, e[1] + 1));
	return range;
}
function textNodesIn(range) {
	var out = [];
	var root = range.commonAncestorContainer;
	if (root.nodeType === 3) return [root];
	var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	var n;
	while ((n = w.nextNode())) if (range.intersectsNode(n) && /\S/.test(n.data)) out.push(n);
	return out;
}
function measureRange(range, id, frame) {
	var rects = [];
	var list = range.getClientRects();
	for (var i = 0; i < list.length; i++) if (list[i].width > 0.5 && list[i].height > 0.5) rects.push(rectOf(list[i]));
	var nodes = textNodesIn(range);
	var el = nodes.length ? nodes[0].parentElement : (range.startContainer.parentElement || document.body);
	var visible = false;
	for (var j = 0; j < nodes.length && !visible; j++) if (nodes[j].parentElement && opacityOf(nodes[j].parentElement) > 0.02) visible = true;
	var rect = union(rects);
	var clippedBy = null, truncated = false;
	if (rect) {
		var anc = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
		for (var a = anc; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
			var cs = getComputedStyle(a);
			if (cs.textOverflow === 'ellipsis' && a.scrollWidth > a.clientWidth + 1) truncated = true;
			var clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
			if (!clips || clippedBy) continue;
			var b = rectOf(a.getBoundingClientRect());
			if (rect.x < b.x - 1 || rect.y < b.y - 1 || rect.x + rect.width > b.x + b.width + 1 || rect.y + rect.height > b.y + b.height + 1) clippedBy = b;
		}
	}
	return { id: id, found: true, visible: visible && !!rect, rect: rect, lines: lineBoxes(rects), clippedBy: clippedBy, truncated: truncated, style: el ? styleOf(el) : null };
}
function exactElement(range, v) {
	var c = range.commonAncestorContainer;
	var el = c.nodeType === 1 ? c : c.parentElement;
	return !!el && norm(el.textContent || '') === v;
}
function find(idx, text) {
	var v = norm(text);
	if (!v) return null;
	var best = null, bestScore = -1;
	var from = 0;
	for (var guard = 0; guard < 50; guard++) {
		var hit = idx.flat.indexOf(v, from);
		if (hit < 0) break;
		from = hit + 1;
		var range = rangeOf(idx, hit, v.length);
		var nodes = textNodesIn(range);
		var vis = false;
		for (var j = 0; j < nodes.length && !vis; j++) if (nodes[j].parentElement && opacityOf(nodes[j].parentElement) > 0.02) vis = true;
		var score = (exactElement(range, v) ? 2 : 0) + (vis ? 4 : 0) + (range.getClientRects().length ? 1 : 0);
		if (score > bestScore) { best = range; bestScore = score; }
	}
	return best;
}
var hidden = [];
var api = {
	version: 1,
	fonts: fonts,
	locate: function (items, frame) {
		var idx = indexPage();
		return items.map(function (it) {
			var range = find(idx, it.text);
			if (!range) return { id: it.id, found: false, visible: false, rect: null, lines: [], clippedBy: null, truncated: false, style: null };
			return measureRange(range, it.id, frame);
		});
	},
	hide: function (text) {
		var range = find(indexPage(), text);
		if (!range) return false;
		textNodesIn(range).forEach(function (n) {
			var el = n.parentElement;
			if (!el || el.__jasperHidden) return;
			el.__jasperHidden = true;
			hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
			el.style.setProperty('visibility', 'hidden', 'important');
		});
		return true;
	},
	restore: function () {
		hidden.splice(0).forEach(function (h) {
			var el = h[0];
			el.__jasperHidden = false;
			if (h[1]) el.style.setProperty('visibility', h[1], h[2]); else el.style.removeProperty('visibility');
		});
	}
};
W.__jasperTexts = api;
})();`;

/** A font the bundle page registered: CSS `src` (absolute URLs) or the raw data given to `new FontFace`. */
export type BundleFontSource = {
	family: string;
	source?: string;
	buffer?: ArrayBuffer | ArrayBufferView;
	weight: string;
	style: string;
	stretch?: string;
	unicodeRange?: string;
	/** A face of this family is loaded in the page. */
	loaded: boolean;
};

/** What the probe installs on a host page. */
type TextProbeApi = {
	version: number;
	fonts(): BundleFontSource[];
	locate(
		items: { id: string; text: string }[],
		frame: { width: number; height: number },
	): MgTextMeasurement[];
	hide(text: string): boolean;
	restore(): void;
};

/** The probe of a host page window (null when the page was loaded without the host bootstrap). */
export function textProbeOf(win: unknown): TextProbeApi | null {
	const api = (win as { __jasperTexts?: TextProbeApi } | null)?.__jasperTexts;
	return api && typeof api.locate === 'function' ? api : null;
}

/** Measures texts in the frame the host page currently shows (S08:MGC-037). */
export function locateTexts(
	win: unknown,
	items: { id: string; text: string }[],
	frame: { width: number; height: number },
): MgTextMeasurement[] {
	const api = textProbeOf(win);
	if (!api) return items.map((i) => notFound(i.id));
	try {
		return api.locate(items, frame);
	} catch {
		return items.map((i) => notFound(i.id));
	}
}

const notFound = (id: string): MgTextMeasurement => ({
	id,
	found: false,
	visible: false,
	rect: null,
	lines: [],
	clippedBy: null,
	truncated: false,
	style: null,
});
