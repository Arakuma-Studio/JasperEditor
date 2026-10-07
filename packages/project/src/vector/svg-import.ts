// SVG → vector shape contents (wp shapes): a pure converter (no DOM) for paste, SVG import and agents. It reads an SVG
// document (or bare path data) and returns shape items in the relaxed input form (`ShapeItemInputSchema`), ready for
// `clip.addShape {type: 'vector', contents}` or `shape.addItems {items}`:
//
//   svgToShapeContents(svgText) → {contents, width, height, viewBox, warnings}
//   svgPathToShapeItems(d, {fill?, stroke?}) → items (one path item per subpath + paints)
//
// Mapping (SVG 1.1 / 2 painting model → After Effects shape layers):
// - every shape element (path, rect with rx/ry, circle, ellipse, line, polyline, polygon, use) becomes a group holding
//   its path(s), a Stroke and a Fill (SVG paints fill then stroke, so the stroke is listed above the fill); `g` and
//   `svg` become groups; document order is reversed (later SVG elements draw on top = earlier in the list);
// - transforms become exact group transforms (an affine matrix decomposed into position · rotation · skew · scale);
//   only a skew beyond ±85° (After Effects' range) is baked into the path vertices instead;
// - paint: inherited presentation attributes, `style` attributes and simple `<style>` rules (element, .class, #id
//   selectors), colours (hex, rgb[a], hsl[a], the CSS named colours, currentColor), fill-rule, opacity, fill- and
//   stroke-opacity, stroke width, caps, joins, miter limit, dashes (up to three dash/gap pairs) and dash offset;
// - linear and radial gradients (stops with opacity, userSpaceOnUse and objectBoundingBox units, gradientTransform,
//   href inheritance, the focal point as Highlight Length / Angle);
// - the root `viewBox` maps to the document size (preserveAspectRatio xMidYMid meet) and the contents are centred on
//   the layer centre (content (0, 0) = the middle of the viewBox).
// What After Effects shape layers cannot express (text, images, filters, masks, clip paths, patterns, markers,
// non-uniform gradient transforms, pad-less spread methods…) is skipped or approximated and named in `warnings`.
import type { BezPath, Cubic, P } from './geom.ts';
import { arcCubics, lineCubic, polyline } from './geom.ts';
import { parseSvgPath } from './svg-path.ts';
import { bezToBezierPaths } from './values.ts';

type Item = Record<string, unknown>;
type Mat = [number, number, number, number, number, number];
const I: Mat = [1, 0, 0, 1, 0, 0];

export type SvgConversion = {
	/** Shape items (input form), centred on the layer centre. */
	contents: Item[];
	/** Document size in px (width/height attributes, else the viewBox size). */
	width: number;
	height: number;
	viewBox: [number, number, number, number];
	/** What could not be converted exactly. */
	warnings: string[];
};

export class SvgImportError extends Error {}

// ---------------------------------------------------------------- XML

type XNode = { name: string; attrs: Record<string, string>; children: XNode[]; text: string };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
	s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) =>
		e.startsWith('#x')
			? String.fromCodePoint(Number.parseInt(e.slice(2), 16))
			: e.startsWith('#')
				? String.fromCodePoint(Number.parseInt(e.slice(1), 10))
				: (ENTITIES[e] ?? m),
	);

/** A small non-validating XML parser (elements, attributes, text, CDATA; comments, PIs and doctype skipped). */
function parseXml(src: string): XNode {
	if (src.length > 50_000_000) throw new SvgImportError('SVG too large');
	const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
	const stack: XNode[] = [root];
	let i = 0;
	const n = src.length;
	while (i < n) {
		const lt = src.indexOf('<', i);
		if (lt < 0) {
			stack[stack.length - 1]!.text += decode(src.slice(i));
			break;
		}
		if (lt > i) stack[stack.length - 1]!.text += decode(src.slice(i, lt));
		if (src.startsWith('<!--', lt)) {
			const e = src.indexOf('-->', lt + 4);
			i = e < 0 ? n : e + 3;
			continue;
		}
		if (src.startsWith('<![CDATA[', lt)) {
			const e = src.indexOf(']]>', lt + 9);
			stack[stack.length - 1]!.text += src.slice(lt + 9, e < 0 ? n : e);
			i = e < 0 ? n : e + 3;
			continue;
		}
		if (src.startsWith('<?', lt)) {
			const e = src.indexOf('?>', lt + 2);
			i = e < 0 ? n : e + 2;
			continue;
		}
		if (src.startsWith('<!', lt)) {
			// DOCTYPE (with an optional internal subset).
			let depth = 0;
			let j = lt + 2;
			for (; j < n; j++) {
				if (src[j] === '[') depth++;
				else if (src[j] === ']') depth--;
				else if (src[j] === '>' && depth <= 0) break;
			}
			i = j + 1;
			continue;
		}
		if (src[lt + 1] === '/') {
			const e = src.indexOf('>', lt);
			const name = src.slice(lt + 2, e < 0 ? n : e).trim();
			for (let k = stack.length - 1; k > 0; k--)
				if (stack[k]!.name === name) {
					stack.length = k;
					break;
				}
			i = e < 0 ? n : e + 1;
			continue;
		}
		// Start tag.
		let j = lt + 1;
		while (j < n && !/[\s/>]/.test(src[j]!)) j++;
		const name = src.slice(lt + 1, j);
		const attrs: Record<string, string> = {};
		let selfClose = false;
		while (j < n) {
			while (j < n && /\s/.test(src[j]!)) j++;
			if (src[j] === '>') {
				j++;
				break;
			}
			if (src[j] === '/' && src[j + 1] === '>') {
				selfClose = true;
				j += 2;
				break;
			}
			let k = j;
			while (k < n && !/[\s=/>]/.test(src[k]!)) k++;
			const an = src.slice(j, k);
			j = k;
			while (j < n && /\s/.test(src[j]!)) j++;
			let value = '';
			if (src[j] === '=') {
				j++;
				while (j < n && /\s/.test(src[j]!)) j++;
				const q = src[j];
				if (q === '"' || q === "'") {
					const e = src.indexOf(q, j + 1);
					value = src.slice(j + 1, e < 0 ? n : e);
					j = e < 0 ? n : e + 1;
				} else {
					let e = j;
					while (e < n && !/[\s>]/.test(src[e]!)) e++;
					value = src.slice(j, e);
					j = e;
				}
			}
			if (an) attrs[an] = decode(value);
			if (k === j && !an) j++;
		}
		const node: XNode = { name, attrs, children: [], text: '' };
		stack[stack.length - 1]!.children.push(node);
		if (stack.length > 512) throw new SvgImportError('SVG nesting too deep');
		if (!selfClose) stack.push(node);
		i = j;
	}
	return root;
}

// ---------------------------------------------------------------- values

const NAMED: Record<string, string> = {
	aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc',
	bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
	burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50',
	cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff', darkblue: '00008b',
	darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9',
	darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc',
	darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f',
	darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff',
	dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0',
	forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700',
	goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0',
	hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
	lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080',
	lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3',
	lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa',
	lightslategray: '778899', lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00',
	limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa',
	mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
	mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585',
	midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead',
	navy: '000080', oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500',
	orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093',
	papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6',
	purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1',
	saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee',
	sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090',
	slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080',
	thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff',
	whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
};

type RGBA = [number, number, number, number];

/** CSS colour → straight RGBA 0…1 (null for `none`, `transparent` gives alpha 0; unknown → null). */
export function parseCssColor(v: string, current: RGBA = [0, 0, 0, 1]): RGBA | null {
	const s = v.trim().toLowerCase();
	if (!s || s === 'none') return null;
	if (s === 'transparent') return [0, 0, 0, 0];
	if (s === 'currentcolor') return current;
	const hex = (h: string): RGBA | null => {
		if (!/^[0-9a-f]+$/.test(h)) return null;
		if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
		if (h.length !== 6 && h.length !== 8) return null;
		const b = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
		return [b(0), b(2), b(4), h.length === 8 ? b(6) : 1];
	};
	if (s.startsWith('#')) return hex(s.slice(1));
	if (NAMED[s]) return hex(NAMED[s]!);
	const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
	if (!fn) return null;
	const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
	const num = (x: string | undefined, scale: number) =>
		x === undefined ? 1 : x.endsWith('%') ? Number.parseFloat(x) / 100 : Number.parseFloat(x) / scale;
	if (fn[1]!.startsWith('rgb')) {
		const c: RGBA = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), num(parts[3], 1)];
		return c.every(Number.isFinite) ? (c.map((x) => Math.min(1, Math.max(0, x))) as RGBA) : null;
	}
	const h = (((Number.parseFloat(parts[0] ?? '0') % 360) + 360) % 360) / 360;
	const sat = num(parts[1], 100);
	const l = num(parts[2], 100);
	const a = num(parts[3], 1);
	const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
	const p = 2 * l - q;
	const tc = (t: number) => {
		const x = ((t % 1) + 1) % 1;
		return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
	};
	const c: RGBA = [tc(h + 1 / 3), tc(h), tc(h - 1 / 3), a];
	return c.every(Number.isFinite) ? c : null;
}

/** A length in px (px, unitless, pt, pc, mm, cm, in, em ≈ 16 px; % of `ref`). */
export function parseLength(v: string | undefined, ref = 0, dflt = 0): number {
	if (v === undefined) return dflt;
	const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v);
	if (!m) return dflt;
	const x = Number.parseFloat(m[1]!);
	const u = m[2]!.toLowerCase();
	const k: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 };
	if (u === '%') return (x / 100) * ref;
	return Number.isFinite(x) ? x * (k[u] ?? 1) : dflt;
}

const nums = (s: string | undefined): number[] =>
	(s ?? '').match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];

const mul = (m: Mat, n: Mat): Mat => [
	m[0] * n[0] + m[2] * n[1],
	m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3],
	m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4],
	m[1] * n[4] + m[3] * n[5] + m[5],
];
const ap = (m: Mat, p: P): P => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

/** SVG `transform` list → matrix. */
export function parseTransform(s: string | undefined): Mat {
	let m: Mat = I;
	const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
	let r: RegExpExecArray | null;
	while ((r = re.exec(s ?? ''))) {
		const a = nums(r[2]);
		let t: Mat = I;
		const rad = ((a[0] ?? 0) * Math.PI) / 180;
		switch (r[1]) {
			case 'matrix':
				if (a.length >= 6) t = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
				break;
			case 'translate':
				t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
				break;
			case 'scale':
				t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
				break;
			case 'rotate': {
				const c = Math.cos(rad);
				const sn = Math.sin(rad);
				t = [c, sn, -sn, c, 0, 0];
				if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1]!, a[2]!], t), [1, 0, 0, 1, -a[1]!, -a[2]!]);
				break;
			}
			case 'skewX':
				t = [1, 0, Math.tan(rad), 1, 0, 0];
				break;
			case 'skewY':
				t = [1, Math.tan(rad), 0, 1, 0, 0];
				break;
		}
		m = mul(m, t);
	}
	return m;
}

/**
 * Decomposes an affine matrix into a shape group transform (position · rotation · skew · scale, anchor 0), or null
 * when the skew is outside After Effects' ±85° (the caller bakes the matrix into the geometry).
 */
export function matrixToGroupTransform(m: Mat): Record<string, unknown> | null {
	const [a, b, c, d, e, f] = m;
	const sx = Math.hypot(a, b);
	if (sx < 1e-12) return null;
	const th = Math.atan2(b, a);
	const cs = Math.cos(th);
	const sn = Math.sin(th);
	const sy = -sn * c + cs * d;
	if (Math.abs(sy) < 1e-12) return null;
	const k = (cs * c + sn * d) / sy;
	const skew = (-Math.atan(k) * 180) / Math.PI;
	if (Math.abs(skew) > 85) return null;
	const r = (x: number) => Math.round(x * 1e6) / 1e6;
	return {
		position: [r(e), r(f)],
		scale: [r(sx * 100), r(sy * 100)],
		rotation: r((th * 180) / Math.PI),
		skew: r(skew),
	};
}

// ---------------------------------------------------------------- styles

type Style = Record<string, string>;
const INHERITED = new Set([
	'fill',
	'fill-opacity',
	'fill-rule',
	'stroke',
	'stroke-opacity',
	'stroke-width',
	'stroke-linecap',
	'stroke-linejoin',
	'stroke-miterlimit',
	'stroke-dasharray',
	'stroke-dashoffset',
	'color',
	'visibility',
	'paint-order',
]);
const PRESENTATION = new Set([...INHERITED, 'opacity', 'display']);

type Rule = { sel: string; decl: Style };

function parseDecls(s: string): Style {
	const out: Style = {};
	for (const part of s.split(';')) {
		const k = part.indexOf(':');
		if (k < 0) continue;
		const name = part.slice(0, k).trim().toLowerCase();
		const value = part
			.slice(k + 1)
			.replace(/!important/i, '')
			.trim();
		if (name) out[name] = value;
	}
	return out;
}

function parseCss(text: string): Rule[] {
	const rules: Rule[] = [];
	const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
	const re = /([^{}]+)\{([^}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(clean))) {
		const decl = parseDecls(m[2]!);
		for (const sel of m[1]!.split(',')) rules.push({ sel: sel.trim(), decl });
	}
	return rules;
}

/** Simple selectors only: `tag`, `.class`, `#id`, `tag.class` (combinators are ignored and reported). */
function matches(sel: string, node: XNode): boolean | null {
	if (/[\s>+~[:]/.test(sel)) return null;
	const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(sel);
	if (!m) return null;
	if (m[1] && m[1] !== node.name && m[1] !== '*') return false;
	const classes = (node.attrs.class ?? '').split(/\s+/);
	for (const part of m[2]!.match(/[.#][\w-]+/g) ?? []) {
		if (part[0] === '.' && !classes.includes(part.slice(1))) return false;
		if (part[0] === '#' && node.attrs.id !== part.slice(1)) return false;
	}
	return true;
}

// ---------------------------------------------------------------- conversion

type Ctx = {
	ids: Map<string, XNode>;
	rules: Rule[];
	warnings: Set<string>;
	vw: number;
	vh: number;
	depth: number;
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function ownStyle(node: XNode, ctx: Ctx): Style {
	const s: Style = {};
	for (const [k, v] of Object.entries(node.attrs)) if (PRESENTATION.has(k)) s[k] = v.trim();
	for (const rule of ctx.rules) {
		const ok = matches(rule.sel, node);
		if (ok === null) ctx.warnings.add(`CSS selector "${rule.sel}" is not supported (simple selectors only)`);
		else if (ok) Object.assign(s, rule.decl);
	}
	if (node.attrs.style) Object.assign(s, parseDecls(node.attrs.style));
	return s;
}

function inherit(parent: Style, own: Style): Style {
	const out: Style = {};
	for (const [k, v] of Object.entries(parent)) if (INHERITED.has(k)) out[k] = v;
	for (const [k, v] of Object.entries(own)) if (v !== 'inherit') out[k] = v;
	return out;
}

const pathItems = (bez: BezPath): Item[] =>
	bezToBezierPaths(bez).map((path) => ({
		type: 'path',
		path: {
			closed: path.closed,
			vertices: path.vertices.map((v) => ({ p: v.p.map(r3), in: v.in.map(r3), out: v.out.map(r3) })),
		},
	}));

/** Geometry of a shape element in its own user space (null = not a shape). */
function geometry(node: XNode, ctx: Ctx): BezPath | null {
	const a = node.attrs;
	const L = (k: string, ref: number, d = 0) => parseLength(a[k], ref, d);
	switch (node.name) {
		case 'path':
			try {
				return parseSvgPath(a.d ?? '');
			} catch (e) {
				ctx.warnings.add(`Path data error: ${(e as Error).message}`);
				return [];
			}
		case 'rect': {
			const x = L('x', ctx.vw);
			const y = L('y', ctx.vh);
			const w = L('width', ctx.vw);
			const h = L('height', ctx.vh);
			if (!(w > 0 && h > 0)) return [];
			let rx = a.rx !== undefined ? L('rx', ctx.vw) : undefined;
			let ry = a.ry !== undefined ? L('ry', ctx.vh) : undefined;
			rx ??= ry ?? 0;
			ry ??= rx;
			rx = Math.min(Math.max(0, rx), w / 2);
			ry = Math.min(Math.max(0, ry), h / 2);
			if (rx === 0 || ry === 0)
				return [polyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true)];
			const arc = (cx: number, cy: number, a0: number) =>
				arcCubics([0, 0], 1, a0, a0 + Math.PI / 2).map((c) => c.map((q) => [cx + q[0] * rx!, cy + q[1] * ry!]) as unknown as Cubic);
			const segs: Cubic[] = [
				lineCubic([x + rx, y], [x + w - rx, y]),
				...arc(x + w - rx, y + ry, -Math.PI / 2),
				lineCubic([x + w, y + ry], [x + w, y + h - ry]),
				...arc(x + w - rx, y + h - ry, 0),
				lineCubic([x + w - rx, y + h], [x + rx, y + h]),
				...arc(x + rx, y + h - ry, Math.PI / 2),
				lineCubic([x, y + h - ry], [x, y + ry]),
				...arc(x + rx, y + ry, Math.PI),
			];
			return [{ segs, closed: true }];
		}
		case 'circle':
		case 'ellipse': {
			const cx = L('cx', ctx.vw);
			const cy = L('cy', ctx.vh);
			const diag = Math.hypot(ctx.vw, ctx.vh) / Math.SQRT2;
			const rx = node.name === 'circle' ? L('r', diag) : L('rx', ctx.vw);
			const ry = node.name === 'circle' ? rx : L('ry', ctx.vh);
			if (!(rx > 0 && ry > 0)) return [];
			const segs = arcCubics([0, 0], 1, -Math.PI / 2, (3 * Math.PI) / 2).map(
				(c) => c.map((q) => [cx + q[0] * rx, cy + q[1] * ry]) as unknown as Cubic,
			);
			return [{ segs, closed: true }];
		}
		case 'line':
			return [{ segs: [lineCubic([L('x1', ctx.vw), L('y1', ctx.vh)], [L('x2', ctx.vw), L('y2', ctx.vh)])], closed: false }];
		case 'polyline':
		case 'polygon': {
			const v = nums(a.points);
			const pts: P[] = [];
			for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i]!, v[i + 1]!]);
			if (pts.length < 2) return [];
			return [polyline(pts, node.name === 'polygon')];
		}
		default:
			return null;
	}
}

function bboxOf(bez: BezPath): [number, number, number, number] {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const sp of bez)
		for (const c of sp.segs)
			for (const q of c) {
				x0 = Math.min(x0, q[0]);
				y0 = Math.min(y0, q[1]);
				x1 = Math.max(x1, q[0]);
				y1 = Math.max(y1, q[1]);
			}
	return Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 0, 0];
}

/** A gradient paint item (fill or stroke) from a gradient element, in the element's user space. */
function gradientItem(id: string, ctx: Ctx, bez: BezPath, kind: 'fill' | 'stroke', opacity: number): Item | null {
	// Resolve href chains (attributes and stops are inherited from referenced gradients).
	const chain: XNode[] = [];
	let cur = ctx.ids.get(id);
	while (cur && chain.length < 16 && !chain.includes(cur)) {
		chain.push(cur);
		const href = cur.attrs.href ?? cur.attrs['xlink:href'];
		cur = href?.startsWith('#') ? ctx.ids.get(href.slice(1)) : undefined;
	}
	const g = chain[0];
	if (!g || (g.name !== 'linearGradient' && g.name !== 'radialGradient')) {
		ctx.warnings.add(`Paint server #${id} is not a gradient (patterns are not supported): painted with its fallback`);
		return null;
	}
	const attr = (k: string) => chain.find((n) => n.attrs[k] !== undefined)?.attrs[k];
	const stopsNode = chain.find((n) => n.children.some((c) => c.name === 'stop'));
	const colors: { position: number; color: [number, number, number] }[] = [];
	const opacities: { position: number; opacity: number }[] = [];
	let last = 0;
	for (const s of stopsNode?.children.filter((c) => c.name === 'stop') ?? []) {
		const st = { ...Object.fromEntries(Object.entries(s.attrs)), ...parseDecls(s.attrs.style ?? '') } as Style;
		const off = st.offset ?? '0';
		let pos = off.endsWith('%') ? Number.parseFloat(off) / 100 : Number.parseFloat(off);
		pos = Math.max(last, Math.min(1, Math.max(0, Number.isFinite(pos) ? pos : 0)));
		last = pos;
		const c = parseCssColor(st['stop-color'] ?? 'black') ?? [0, 0, 0, 1];
		const so = Number.parseFloat(st['stop-opacity'] ?? '1');
		colors.push({ position: r3(pos), color: [r3(c[0]), r3(c[1]), r3(c[2])] });
		opacities.push({ position: r3(pos), opacity: r3(Math.min(1, Math.max(0, (Number.isFinite(so) ? so : 1) * c[3]))) });
	}
	if (!colors.length) return null;
	const spread = attr('spreadMethod');
	if (spread && spread !== 'pad') ctx.warnings.add(`Gradient spreadMethod="${spread}" is drawn as pad`);
	const obb = (attr('gradientUnits') ?? 'objectBoundingBox') === 'objectBoundingBox';
	const [bx, by, bw, bh] = bboxOf(bez);
	let m: Mat = obb ? [bw, 0, 0, bh, bx, by] : I;
	m = mul(m, parseTransform(attr('gradientTransform')));
	const len = (k: string, d: string, ref: number) => {
		const v = attr(k) ?? d;
		return obb && v.endsWith('%') ? Number.parseFloat(v) / 100 : obb ? Number.parseFloat(v) : parseLength(v, ref);
	};
	const uniform = Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) < 1e-6 * Math.max(1, Math.hypot(m[0], m[1])) && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9 * Math.max(1, m[0] * m[0] + m[1] * m[1]);
	const base = {
		type: kind === 'fill' ? 'gradientFill' : 'gradientStroke',
		colors: { colors, opacities },
		opacity: r3(opacity * 100),
	};
	if (g.name === 'linearGradient') {
		const p1 = ap(m, [len('x1', '0%', ctx.vw), len('y1', '0%', ctx.vh)]);
		const p2 = ap(m, [len('x2', '100%', ctx.vw), len('y2', '0%', ctx.vh)]);
		if (!uniform) ctx.warnings.add('A linear gradient with a non-uniform transform keeps its end points (its angle may differ)');
		return { ...base, gradientType: 'linear', startPoint: p1.map(r3), endPoint: p2.map(r3) };
	}
	const cx = len('cx', '50%', ctx.vw);
	const cy = len('cy', '50%', ctx.vh);
	const rr = len('r', '50%', Math.hypot(ctx.vw, ctx.vh) / Math.SQRT2);
	const fx = attr('fx') !== undefined ? len('fx', '50%', ctx.vw) : cx;
	const fy = attr('fy') !== undefined ? len('fy', '50%', ctx.vh) : cy;
	if (!uniform) ctx.warnings.add('An elliptical radial gradient is drawn circular (shape layers have circular radial gradients)');
	const c = ap(m, [cx, cy]);
	const e = ap(m, [cx + rr, cy]);
	const f = ap(m, [fx, fy]);
	const R = Math.hypot(e[0] - c[0], e[1] - c[1]);
	const fd = Math.hypot(f[0] - c[0], f[1] - c[1]);
	const axis = Math.atan2(e[1] - c[1], e[0] - c[0]);
	const fang = Math.atan2(f[1] - c[1], f[0] - c[0]);
	return {
		...base,
		gradientType: 'radial',
		startPoint: c.map(r3),
		endPoint: e.map(r3),
		highlightLength: r3(R > 0 ? Math.min(100, (fd / R) * 100) : 0),
		highlightAngle: r3(fd > 1e-9 ? ((fang - axis) * 180) / Math.PI : 0),
	};
}

function paintItems(style: Style, ctx: Ctx, bez: BezPath): Item[] {
	const out: Item[] = [];
	const color = parseCssColor(style.color ?? 'black') ?? [0, 0, 0, 1];
	const op = (k: string) => {
		const v = Number.parseFloat(style[k] ?? '1');
		return Math.min(1, Math.max(0, Number.isFinite(v) ? (style[k]?.endsWith('%') ? v / 100 : v) : 1));
	};
	const paint = (k: 'fill' | 'stroke'): Item | null => {
		const v = (style[k] ?? (k === 'fill' ? 'black' : 'none')).trim();
		const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(v);
		const o = op(`${k}-opacity`);
		if (url) {
			const g = gradientItem(url[1]!, ctx, bez, k, o);
			if (g) return g;
			const fb = parseCssColor(url[2] || 'none', color);
			return fb ? { type: k, color: fb.map(r3), opacity: r3(o * 100) } : null;
		}
		const c = parseCssColor(v, color);
		if (v && !c && v !== 'none') ctx.warnings.add(`Unknown colour "${v}"`);
		return c ? { type: k, color: c.map(r3), opacity: r3(o * 100) } : null;
	};
	const stroke = paint('stroke');
	if (stroke) {
		const w = parseLength(style['stroke-width'], Math.hypot(ctx.vw, ctx.vh) / Math.SQRT2, 1);
		if (w > 0) {
			stroke.width = r3(w);
			const cap = style['stroke-linecap'];
			if (cap === 'round' || cap === 'square') stroke.lineCap = cap;
			const join = style['stroke-linejoin'];
			if (join === 'round' || join === 'bevel') stroke.lineJoin = join;
			else if (join === 'arcs' || join === 'miter-clip') {
				ctx.warnings.add(`stroke-linejoin="${join}" is drawn as miter`);
			}
			const ml = Number.parseFloat(style['stroke-miterlimit'] ?? '4');
			stroke.miterLimit = Number.isFinite(ml) && ml >= 1 ? ml : 4;
			let dash = (style['stroke-dasharray'] ?? 'none') === 'none' ? [] : nums(style['stroke-dasharray']).map((x) => Math.max(0, x));
			if (dash.length % 2 === 1) dash = [...dash, ...dash];
			if (dash.length && dash.some((x) => x > 0)) {
				if (dash.length > 6) ctx.warnings.add('Dash patterns longer than three dash/gap pairs are truncated');
				const segments = [];
				for (let i = 0; i < Math.min(6, dash.length); i += 2) segments.push({ dash: r3(dash[i]!), gap: r3(dash[i + 1]!) });
				stroke.dashes = { segments, offset: r3(parseLength(style['stroke-dashoffset'], 0, 0)) };
			}
			out.push(stroke);
		}
	}
	const fill = paint('fill');
	if (fill) {
		if (style['fill-rule'] === 'evenodd') fill.fillRule = 'evenodd';
		out.push(fill);
	}
	if (style['paint-order']?.trim().startsWith('stroke')) {
		out.reverse();
	}
	return out;
}

const SKIPPED: Record<string, string> = {
	text: 'text',
	image: 'images',
	foreignObject: 'foreignObject',
	video: 'video',
	audio: 'audio',
	switch: 'switch',
};
const NON_RENDERED = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'pattern', 'clipPath', 'mask', 'filter', 'marker', 'symbol', 'script']);

function convertNode(node: XNode, parent: Style, ctx: Ctx, extra: Mat = I): Item | null {
	if (NON_RENDERED.has(node.name)) return null;
	if (SKIPPED[node.name]) {
		ctx.warnings.add(`${SKIPPED[node.name]} are not converted (shape layers draw vector paths only)`);
		return null;
	}
	if (ctx.depth > 256) {
		ctx.warnings.add('Nesting deeper than 256 levels is skipped');
		return null;
	}
	const own = ownStyle(node, ctx);
	if (own.display === 'none') return null;
	const style = inherit(parent, own);
	if (style.visibility === 'hidden' || style.visibility === 'collapse') return null;
	for (const k of ['clip-path', 'mask', 'filter'] as const)
		if ((node.attrs[k] ?? own[k]) && (node.attrs[k] ?? own[k]) !== 'none') ctx.warnings.add(`${k} is not converted`);
	if (node.attrs['marker-start'] || node.attrs['marker-mid'] || node.attrs['marker-end']) ctx.warnings.add('markers are not converted');
	let m = mul(extra, parseTransform(node.attrs.transform));
	const opacity = Math.min(1, Math.max(0, Number.parseFloat(own.opacity ?? '1')));
	let contents: Item[] = [];
	let name = node.attrs.id ?? node.name;
	if (node.name === 'use') {
		const href = node.attrs.href ?? node.attrs['xlink:href'];
		const target = href?.startsWith('#') ? ctx.ids.get(href.slice(1)) : undefined;
		if (!target) {
			ctx.warnings.add(`use: reference ${href ?? '(none)'} not found`);
			return null;
		}
		m = mul(m, [1, 0, 0, 1, parseLength(node.attrs.x, ctx.vw), parseLength(node.attrs.y, ctx.vh)]);
		ctx.depth++;
		const inner =
			target.name === 'symbol'
				? convertChildren(target, style, ctx)
				: [convertNode(target, style, ctx)].filter((x): x is Item => !!x);
		ctx.depth--;
		contents = inner;
		name = `use ${href}`;
	} else if (node.name === 'g' || node.name === 'svg' || node.name === 'a') {
		if (node.name === 'svg' && ctx.depth > 0) {
			// A nested viewport: x/y offset (its own viewBox scaling is applied when present).
			m = mul(m, [1, 0, 0, 1, parseLength(node.attrs.x, ctx.vw), parseLength(node.attrs.y, ctx.vh)]);
			const vb = nums(node.attrs.viewBox);
			const w = parseLength(node.attrs.width, ctx.vw, vb[2] ?? ctx.vw);
			const h = parseLength(node.attrs.height, ctx.vh, vb[3] ?? ctx.vh);
			if (vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) {
				const k = Math.min(w / vb[2]!, h / vb[3]!);
				m = mul(m, [k, 0, 0, k, (w - vb[2]! * k) / 2 - vb[0]! * k, (h - vb[3]! * k) / 2 - vb[1]! * k]);
			}
		}
		ctx.depth++;
		contents = convertChildren(node, style, ctx);
		ctx.depth--;
	} else {
		const geo = geometry(node, ctx);
		if (geo === null) {
			if (node.name && !node.name.startsWith('#') && !node.name.includes(':')) ctx.warnings.add(`<${node.name}> is not converted`);
			return null;
		}
		if (!geo.length) return null;
		const paints = paintItems(style, ctx, geo);
		if (!paints.length) return null;
		contents = [...pathItems(geo), ...paints];
	}
	if (!contents.length) return null;
	const isIdentity = m.every((x, i) => Math.abs(x - I[i]!) < 1e-12);
	const tr = isIdentity ? {} : matrixToGroupTransform(m);
	if (tr === null) {
		ctx.warnings.add('A transform with a skew beyond ±85° is baked into the path vertices (stroke widths are not skewed)');
		bake(contents, m);
	}
	return {
		type: 'group',
		name,
		contents,
		...(tr && Object.keys(tr).length ? { transform: { ...tr, ...(opacity < 1 ? { opacity: r3(opacity * 100) } : {}) } } : opacity < 1 ? { transform: { opacity: r3(opacity * 100) } } : {}),
	};
}

/** Applies a matrix to every path (and gradient point) of converted items in place. */
function bake(items: Item[], m: Mat): void {
	for (const it of items) {
		if (it.type === 'path') {
			const p = it.path as { vertices: { p: P; in: P; out: P }[] };
			for (const v of p.vertices) {
				const q = ap(m, v.p);
				const i = ap(m, [v.p[0] + v.in[0], v.p[1] + v.in[1]]);
				const o = ap(m, [v.p[0] + v.out[0], v.p[1] + v.out[1]]);
				v.p = [r3(q[0]), r3(q[1])];
				v.in = [r3(i[0] - q[0]), r3(i[1] - q[1])];
				v.out = [r3(o[0] - q[0]), r3(o[1] - q[1])];
			}
		} else if (it.type === 'gradientFill' || it.type === 'gradientStroke') {
			it.startPoint = ap(m, it.startPoint as P).map(r3);
			it.endPoint = ap(m, it.endPoint as P).map(r3);
		} else if (it.type === 'group') {
			const tr = it.transform as Record<string, unknown> | undefined;
			if (tr?.position || tr?.scale || tr?.rotation || tr?.skew) {
				// Nested transforms stay; the outer matrix goes into the group's own children.
				it.contents = [{ type: 'group', name: String(it.name), contents: it.contents, transform: tr }];
				it.transform = tr.opacity !== undefined ? { opacity: tr.opacity } : undefined;
				if (!it.transform) delete it.transform;
			}
			bake(it.contents as Item[], m);
		}
	}
}

function convertChildren(node: XNode, style: Style, ctx: Ctx): Item[] {
	const out: Item[] = [];
	for (const c of node.children) {
		const it = convertNode(c, style, ctx);
		if (it) out.push(it);
	}
	// SVG paints in document order (later on top); shape layers list the top first.
	return out.reverse();
}

/**
 * Converts an SVG document into vector shape contents (see the module comment). Throws SvgImportError when the text
 * is not an SVG document.
 */
export function svgToShapeContents(svg: string): SvgConversion {
	const doc = parseXml(svg);
	const root = findFirst(doc, 'svg');
	if (!root) throw new SvgImportError('Not an SVG document (no <svg> element)');
	const ids = new Map<string, XNode>();
	const rules: Rule[] = [];
	const visit = (n: XNode) => {
		if (n.attrs.id && !ids.has(n.attrs.id)) ids.set(n.attrs.id, n);
		if (n.name === 'style') rules.push(...parseCss(n.text));
		for (const c of n.children) visit(c);
	};
	visit(root);
	const vb = nums(root.attrs.viewBox);
	const hasVb = vb.length === 4 && vb[2]! > 0 && vb[3]! > 0;
	const width = parseLength(root.attrs.width, 0, hasVb ? vb[2]! : 300) || (hasVb ? vb[2]! : 300);
	const height = parseLength(root.attrs.height, 0, hasVb ? vb[3]! : 150) || (hasVb ? vb[3]! : 150);
	const viewBox: [number, number, number, number] = hasVb ? [vb[0]!, vb[1]!, vb[2]!, vb[3]!] : [0, 0, width, height];
	const ctx: Ctx = { ids, rules, warnings: new Set(), vw: viewBox[2], vh: viewBox[3], depth: 0 };
	const par = (root.attrs.preserveAspectRatio ?? 'xMidYMid meet').trim();
	if (par !== 'xMidYMid meet' && par !== 'xMidYMid') ctx.warnings.add(`preserveAspectRatio="${par}" is treated as xMidYMid meet`);
	const k = Math.min(width / viewBox[2], height / viewBox[3]);
	const own = ownStyle(root, ctx);
	const style = inherit({}, own);
	ctx.depth = 1;
	const contents = convertChildren(root, style, ctx);
	ctx.depth = 0;
	const opacity = Number.parseFloat(own.opacity ?? '1');
	// Centre the viewBox on the layer centre at the document size.
	const centred: Item = {
		type: 'group',
		name: root.attrs.id ?? 'SVG',
		contents,
		transform: {
			anchor: [r3(viewBox[0] + viewBox[2] / 2), r3(viewBox[1] + viewBox[3] / 2)],
			scale: [r3(k * 100), r3(k * 100)],
			...(opacity < 1 ? { opacity: r3(Math.max(0, opacity) * 100) } : {}),
		},
	};
	return { contents: contents.length ? [centred] : [], width, height, viewBox, warnings: [...ctx.warnings] };
}

function findFirst(n: XNode, name: string): XNode | null {
	if (n.name === name || n.name.endsWith(`:${name}`)) return n;
	for (const c of n.children) {
		const r = findFirst(c, name);
		if (r) return r;
	}
	return null;
}

/** Path items (one per subpath) from SVG path data, followed by the given paints (input form). */
export function svgPathToShapeItems(
	d: string,
	paint: { fill?: string | [number, number, number, number] | null; stroke?: { color: string | [number, number, number, number]; width: number } | null } = {},
): Item[] {
	const items: Item[] = pathItems(parseSvgPath(d));
	if (paint.stroke) items.push({ type: 'stroke', color: paint.stroke.color, width: paint.stroke.width });
	if (paint.fill !== null) items.push({ type: 'fill', color: paint.fill ?? [1, 1, 1, 1] });
	return items;
}

/** True when a clipboard / file text looks like SVG markup. */
export function looksLikeSvg(text: string): boolean {
	return /<svg[\s>]/i.test(text.slice(0, 4096));
}
