// Sequence → Lottie document (imports workstream, docs/wp-notes/imports.md). Design ported from EffectCraft
// `crates/lottie/src/{export,anim,shapes,text}.rs` (MIT OR Apache-2.0): every layer maps to its Lottie layer type,
// keyframes keep their temporal ease (our influence / slope ease is exactly Lottie's normalised Bézier `o`/`i`) and
// spatial tangents (`to`/`ti`), and everything Lottie cannot express is listed in `warnings` instead of being dropped
// silently.
//
// Mapping (top video track first: Lottie lists the top layer first):
// - vector shape clips (and rectangle / ellipse shapes) → shape layers (`ty 4`): groups, rectangles, ellipses,
//   polystars, paths, fills, strokes (dashes), gradient fills / strokes, Trim Paths, Repeater, Offset Paths, Round
//   Corners, Zig Zag, Twist, Pucker & Bloat, Merge Paths, blend modes;
// - text clips → text layers (`ty 5`): text documents (Source Text keys), font, size, tracking, leading, alignment,
//   fill, first stroke, paragraph box; AE-style animators with their first range selector;
// - colour mattes → solid layers (`ty 1`); stills → image layers (`ty 2`) with embedded image assets; nested
//   sequences and imported Lottie animations → precomp layers (`ty 0`);
// - Motion (position, anchor, scale, rotation, flips), opacity, Opacity masks, blend modes, the Gaussian Blur effect,
//   layer in/out points, speed (`sr`), sequence markers.
// Values Lottie cannot carry exactly (roving keys, expressions, eases our evaluator computes) are baked as one key per
// frame (exact at every frame). Keyframes are in layer frames: content time / sequence frame duration.
import { legacyToVectorItems } from '../commands/handlers/shape.ts';
import { bindExpressions } from '../expressions.ts';
import { evaluate, incomingEase, isHoldOnlyValue, outgoingEase, rovingRunAt } from '../keyframes.ts';
import { effectiveTangents, isVec2Value } from '../keyframes-spatial.ts';
import type { BezierPath } from '../path/model.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import type { Animatable, Keyframe, RGBA, Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Mask } from '../schema/mask.ts';
import { BLEND_MODES, type Clip, type Sequence, type TextContent, type TextStyle, type Transform } from '../schema/sequence.ts';
import type { ShapeItem, ShapeTransform } from '../schema/shapes.ts';
import type { TextAnimatorGroup, TextRangeSelector } from '../schema/text-animators.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import type { GradientValue } from '../vector/values.ts';
import { gradientSvgStops } from '../vector/values.ts';

type Json = Record<string, unknown>;

/** Media the exporter embeds (resolved by the caller: the engine reads the files). */
export type LottieExportMedia = Record<
	string,
	| { kind: 'image'; dataUri: string; width: number; height: number }
	| { kind: 'lottie'; doc: Json }
	| undefined
>;

export type LottieExportOptions = {
	/** Sequence frames [start, end) (default: the whole sequence). */
	range?: { start: number; end: number };
	media?: LottieExportMedia;
	/** Generator name written to `meta.g`. */
	generator?: string;
};

export type LottieExportResult = { json: Json; warnings: string[]; layers: number };

/** Lottie `bm` codes (index = code). */
const LOTTIE_BLEND: readonly string[] = [
	'normal',
	'multiply',
	'screen',
	'overlay',
	'darken',
	'lighten',
	'color-dodge',
	'color-burn',
	'hard-light',
	'soft-light',
	'difference',
	'exclusion',
	'hue',
	'saturation',
	'color',
	'luminosity',
	'add',
	'hard-mix',
];

const r6 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0);
const MAX_DEPTH = 32;
const MAX_BAKED_KEYS = 100_000;

class Ctx {
	readonly warnings: string[] = [];
	readonly assets: Json[] = [];
	readonly fonts: Json[] = [];
	private readonly done = new Set<string>();
	layerCount = 0;
	constructor(
		readonly doc: ProjectDocument,
		readonly media: LottieExportMedia,
	) {}
	warn(w: string) {
		if (!this.warnings.includes(w)) this.warnings.push(w);
	}
	has(id: string) {
		return this.done.has(id);
	}
	add(id: string) {
		this.done.add(id);
	}
}

/** How a clip's content time maps to Lottie layer frames. */
type Clock = {
	/** Flicks per sequence frame. */
	F: number;
	/** Comp frame of the clip's first frame (relative to the export range). */
	start: number;
	duration: number;
	sourceIn: number;
	rate: number;
	/** Comp frame f → content time (flicks): used to bake. */
	contentAt(f: number): number;
};

// ---------------------------------------------------------------- values

const num = (v: unknown) => r6(Number(v));
const vec2 = (v: unknown): number[] => {
	const a = v as number[];
	return [r6(a[0] ?? 0), r6(a[1] ?? 0)];
};
const rgb01 = (c: RGBA | number[]) => [r6(c[0] ?? 0), r6(c[1] ?? 0), r6(c[2] ?? 0), r6(c[3] ?? 1)];

/** A path value → Lottie shape value `{c, v, i, o}` (tangents relative, as ours), mapped by `map`. */
function shapeValue(p: BezierPath, map: (pt: [number, number]) => [number, number] = (x) => x, scale: [number, number] = [1, 1]): Json {
	return {
		c: !!p.closed,
		v: p.vertices.map((v) => map([v.p[0], v.p[1]]).map(r6)),
		i: p.vertices.map((v) => [r6(v.in[0] * scale[0]), r6(v.in[1] * scale[1])]),
		o: p.vertices.map((v) => [r6(v.out[0] * scale[0]), r6(v.out[1] * scale[1])]),
	};
}

/**
 * An Animatable as a Lottie property. `conv` maps a value to its Lottie value (number or array). Keys are converted
 * exactly when Lottie can carry them (hold, linear, Bézier eases — auto-bezier included —, spatial tangents of vec2
 * points); roving runs and expressions are baked per frame of the clip.
 */
function prop<T>(
	ctx: Ctx,
	a: Animatable<T> | undefined,
	conv: (v: T) => unknown,
	clock: Clock,
	label: string,
	opts: { spatial?: boolean } = {},
): Json {
	if (!a) return { a: 0, k: 0 };
	const expr = (a as { expression?: { text?: string; enabled?: boolean } }).expression;
	const hasExpr = !!expr && expr.enabled !== false && !!expr.text?.trim();
	const kfs = a.keyframes as Keyframe<T>[];
	const roving = kfs.some((_, i) => rovingRunAt(kfs as Keyframe<unknown>[], i));
	if (hasExpr || roving) return bake(ctx, a, conv, clock, label, hasExpr ? 'expression' : 'roving keys');
	if (kfs.length === 0) return { a: 0, k: conv(a.value) };
	// Layer frames: content time / sequence frame duration (`layerTimes` sets `st` and `sr` so that it holds).
	const toFrame = (t: number) => r6(t / clock.F);
	const out: Json[] = [];
	kfs.forEach((k, i) => {
		const s = conv(k.value);
		const o: Json = { t: toFrame(k.time), s: Array.isArray(s) ? s : [s] };
		const next = kfs[i + 1];
		if (!next) {
			out.push(o);
			return;
		}
		if (k.interpolation === 'hold' || isHoldOnlyValue(k.value)) {
			o.h = 1;
			out.push(o);
			return;
		}
		const eo = k.interpolation === 'linear' ? { influence: 1 / 3, slope: 1 } : outgoingEase(kfs, i);
		const ei = k.interpolation === 'linear' ? { influence: 1 / 3, slope: 1 } : incomingEase(kfs, i + 1);
		const ox = r6(Math.min(1, Math.max(0, eo.influence)));
		const ix = r6(1 - Math.min(1, Math.max(0, ei.influence)));
		o.o = { x: ox, y: r6(ox * eo.slope) };
		o.i = { x: ix, y: r6(1 - (1 - ix) * ei.slope) };
		if (opts.spatial && isVec2Value(k.value) && isVec2Value(next.value)) {
			const to = effectiveTangents(kfs as Keyframe<unknown>[], i).outTangent;
			const ti = effectiveTangents(kfs as Keyframe<unknown>[], i + 1).inTangent;
			o.to = [r6(to[0]), r6(to[1])];
			o.ti = [r6(ti[0]), r6(ti[1])];
		}
		out.push(o);
	});
	return { a: 1, k: out };
}

/** One linear key per frame of the clip (the evaluated value, expressions included). */
function bake<T>(ctx: Ctx, a: Animatable<T>, conv: (v: T) => unknown, clock: Clock, label: string, why: string): Json {
	const n = Math.min(clock.duration, MAX_BAKED_KEYS);
	if (n < clock.duration) ctx.warn(`${label}: only the first ${MAX_BAKED_KEYS} frames are baked`);
	const out: Json[] = [];
	for (let f = 0; f < Math.max(1, n); f++) {
		const t = clock.contentAt(clock.start + f);
		const s = conv(evaluate(a, t));
		out.push({
			t: r6(t / clock.F),
			s: Array.isArray(s) ? s : [s],
			o: { x: 0, y: 0 },
			i: { x: 1, y: 1 },
		});
	}
	void why;
	return out.length === 1 ? { a: 0, k: (out[0]!.s as unknown[]).length === 1 ? (out[0]!.s as unknown[])[0] : out[0]!.s } : { a: 1, k: out };
}

/** A static Lottie value. */
const k0 = (v: unknown) => ({ a: 0, k: v });

// ---------------------------------------------------------------- layers

function blendCode(ctx: Ctx, mode: string | undefined, label: string): number {
	const m = mode ?? 'normal';
	const i = LOTTIE_BLEND.indexOf(m);
	if (i >= 0) return i;
	ctx.warn(`${label}: blend mode ${m} has no Lottie equivalent (Normal is used)`);
	return 0;
}

function hasKeys(a: Animatable<unknown> | undefined): boolean {
	return !!a && a.keyframes.length > 0;
}

/** Layer transform `ks` from Motion + Opacity. `origin` = the layer's content origin in box pixels. */
function transform(
	ctx: Ctx,
	tr: Transform | null,
	opacity: Animatable<number>,
	clock: Clock,
	origin: [number, number],
	label: string,
): Json {
	const ks: Json = { o: prop(ctx, opacity, (v) => num(v), clock, `${label} ▸ Opacity`) };
	if (!tr) return ks;
	ks.p = prop(ctx, tr.position as Animatable<Vec2>, (v) => vec2(v), clock, `${label} ▸ Position`, { spatial: true });
	ks.a = prop(ctx, tr.anchor as Animatable<Vec2>, (v) => [r6(v[0] - origin[0]), r6(v[1] - origin[1])], clock, `${label} ▸ Anchor Point`);
	ks.r = prop(ctx, tr.rotation, (v) => num(v), clock, `${label} ▸ Rotation`);
	const fx = tr.flipH ? -1 : 1;
	const fy = tr.flipV ? -1 : 1;
	if (tr.uniformScale || !hasKeys(tr.scaleWidth)) {
		if (tr.uniformScale) ks.s = prop(ctx, tr.scale, (v) => [r6(v * fx), r6(v * fy)], clock, `${label} ▸ Scale`);
		else if (!hasKeys(tr.scale))
			ks.s = k0([r6(tr.scaleWidth.value * fx), r6(tr.scale.value * fy)]);
		else {
			const w = tr.scaleWidth.value;
			ks.s = prop(ctx, tr.scale, (v) => [r6(w * fx), r6(v * fy)], clock, `${label} ▸ Scale`);
		}
	} else {
		// Scale Height and Scale Width keyed separately: one combined vector per frame.
		const combined: Animatable<[number, number]> = {
			value: [tr.scaleWidth.value, tr.scale.value],
			keyframes: [],
			[Symbol.for('jasper.expressionBinding')]: {
				evaluate: (t: number) => [evaluate(tr.scaleWidth, t), evaluate(tr.scale, t)],
			},
		} as never;
		ks.s = bake(ctx, combined, (v) => [r6(v[0] * fx), r6(v[1] * fy)], clock, `${label} ▸ Scale`, 'separate scale keys');
	}
	return ks;
}

const MASK_MODE: Record<string, string> = {
	none: 'n',
	add: 'a',
	subtract: 's',
	intersect: 'i',
	lighten: 'l',
	darken: 'd',
	difference: 'f',
};

function masks(ctx: Ctx, list: readonly Mask[] | undefined, box: { width: number; height: number }, origin: [number, number], clock: Clock, label: string): Json[] {
	if (!list?.length) return [];
	const out: Json[] = [];
	for (const m of list) {
		const map = (p: [number, number]): [number, number] => [p[0] * box.width - origin[0], p[1] * box.height - origin[1]];
		const pt = prop(ctx, m.path as Animatable<BezierPath>, (v) => shapeValue(v, map, [box.width, box.height]), clock, `${label} ▸ ${m.name}`);
		const o: Json = {
			nm: m.name,
			mode: MASK_MODE[m.mode] ?? 'a',
			inv: !!m.inverted,
			pt,
			o: prop(ctx, m.opacity, (v) => num(v), clock, `${label} ▸ ${m.name} ▸ Mask Opacity`),
			x: prop(ctx, m.expansion, (v) => num(v), clock, `${label} ▸ ${m.name} ▸ Mask Expansion`),
		};
		if (m.feather.value !== 0 || m.feather.keyframes.length)
			ctx.warn(`${label} ▸ ${m.name}: mask feather is not drawn by most Lottie players (exported as \`f\`)`);
		o.f = prop(ctx, m.feather, (v) => [num(v), num(v)], clock, `${label} ▸ ${m.name} ▸ Mask Feather`);
		out.push(o);
	}
	return out;
}

/** Gaussian Blur is the one effect of ours Lottie players implement (`ty 29`); the rest are reported. */
function effects(ctx: Ctx, c: Clip, clock: Clock, label: string): Json[] {
	const list = (c as { effects?: { effectId: string; enabled: boolean; params: Record<string, Animatable<unknown>> }[] }).effects ?? [];
	const out: Json[] = [];
	let i = 0;
	for (const fx of list) {
		if (!fx.enabled) continue;
		if (fx.effectId === 'jasper.gaussian-blur') {
			const radius = fx.params.radius as Animatable<number> | undefined;
			out.push({
				ty: 29,
				nm: 'Gaussian Blur',
				mn: 'ADBE Gaussian Blur 2',
				ix: ++i,
				en: 1,
				ef: [
					{ ty: 0, nm: 'Blurriness', mn: 'ADBE Gaussian Blur 2-0001', ix: 1, v: prop(ctx, radius, (v) => num(v), clock, `${label} ▸ Blurriness`) },
					{ ty: 7, nm: 'Blur Dimensions', mn: 'ADBE Gaussian Blur 2-0002', ix: 2, v: k0(1) },
					{ ty: 7, nm: 'Repeat Edge Pixels', mn: 'ADBE Gaussian Blur 2-0003', ix: 3, v: k0(0) },
				],
			});
			continue;
		}
		ctx.warn(`${label}: effect ${fx.effectId} is not part of Lottie (skipped)`);
	}
	return out;
}

// ---------------------------------------------------------------- shapes

const PATH_DIR = (d: string | undefined) => (d === 'reversed' ? 3 : 1);
const CAP: Record<string, number> = { butt: 1, round: 2, square: 3 };
const JOIN: Record<string, number> = { miter: 1, round: 2, bevel: 3 };
const MERGE: Record<string, number> = { merge: 1, add: 2, subtract: 3, intersect: 4, exclude: 5 };

function gradientValue(g: GradientValue): { p: number; k: number[] } {
	// Midpoints and separate opacity stops: the stops a linear player needs (the SVG renderer's expansion).
	const stops = gradientSvgStops(g);
	const k: number[] = [];
	for (const s of stops) k.push(r6(s.offset), r6(s.color[0]), r6(s.color[1]), r6(s.color[2]));
	for (const s of stops) k.push(r6(s.offset), r6(s.alpha));
	return { p: stops.length, k };
}

function shapeTransform(ctx: Ctx, t: ShapeTransform, clock: Clock, label: string): Json {
	return {
		ty: 'tr',
		nm: 'Transform',
		a: prop(ctx, t.anchor, (v) => vec2(v), clock, `${label} ▸ Anchor Point`),
		p: prop(ctx, t.position, (v) => vec2(v), clock, `${label} ▸ Position`, { spatial: true }),
		s: prop(ctx, t.scale, (v) => vec2(v), clock, `${label} ▸ Scale`),
		sk: prop(ctx, t.skew, (v) => num(v), clock, `${label} ▸ Skew`),
		sa: prop(ctx, t.skewAxis, (v) => num(v), clock, `${label} ▸ Skew Axis`),
		r: prop(ctx, t.rotation, (v) => num(v), clock, `${label} ▸ Rotation`),
		o: prop(ctx, t.opacity, (v) => num(v), clock, `${label} ▸ Opacity`),
	};
}

function strokeFields(ctx: Ctx, s: Extract<ShapeItem, { type: 'stroke' | 'gradientStroke' }>, clock: Clock, label: string): Json {
	const o: Json = {
		o: prop(ctx, s.opacity, (v) => num(v), clock, `${label} ▸ Opacity`),
		w: prop(ctx, s.width, (v) => num(v), clock, `${label} ▸ Stroke Width`),
		lc: CAP[s.lineCap ?? 'butt'] ?? 1,
		lj: JOIN[s.lineJoin ?? 'miter'] ?? 1,
		ml: num(s.miterLimit.value),
	};
	if (s.miterLimit.keyframes.length) o.ml2 = prop(ctx, s.miterLimit, (v) => num(v), clock, `${label} ▸ Miter Limit`);
	if (s.dashes?.segments.length) {
		const d: Json[] = [];
		s.dashes.segments.forEach((seg, i) => {
			d.push({ n: 'd', nm: `Dash ${i + 1}`, v: prop(ctx, seg.dash, (v) => num(v), clock, `${label} ▸ Dash`) });
			d.push({ n: 'g', nm: `Gap ${i + 1}`, v: prop(ctx, seg.gap, (v) => num(v), clock, `${label} ▸ Gap`) });
		});
		d.push({ n: 'o', nm: 'Offset', v: prop(ctx, s.dashes.offset, (v) => num(v), clock, `${label} ▸ Offset`) });
		o.d = d;
	}
	if (s.taper) ctx.warn(`${label}: stroke taper is not part of Lottie (a uniform stroke is exported)`);
	if (s.wave) ctx.warn(`${label}: stroke wave is not part of Lottie (a straight stroke is exported)`);
	if (s.position && s.position !== 'center')
		ctx.warn(`${label}: stroke position ${s.position} is not part of Lottie (centred on the path)`);
	if (s.composite === 'above') ctx.warn(`${label}: Composite "Above Previous in Same Group" is not part of Lottie`);
	return o;
}

function gradientFields(ctx: Ctx, g: Extract<ShapeItem, { type: 'gradientFill' | 'gradientStroke' }>, clock: Clock, label: string): Json {
	const colors = g.colors;
	const sameStructure =
		colors.keyframes.length === 0 ||
		colors.keyframes.every((k) => gradientValue(k.value).p === gradientValue(colors.value).p);
	let gk: Json;
	if (!sameStructure) {
		ctx.warn(`${label}: gradient keys with different stops are baked per frame`);
		gk = bake(ctx, colors, (v) => gradientValue(v).k, clock, `${label} ▸ Colors`, 'gradient structure');
	} else gk = prop(ctx, colors, (v) => gradientValue(v).k, clock, `${label} ▸ Colors`);
	return {
		t: g.gradientType === 'radial' ? 2 : 1,
		s: prop(ctx, g.startPoint, (v) => vec2(v), clock, `${label} ▸ Start Point`),
		e: prop(ctx, g.endPoint, (v) => vec2(v), clock, `${label} ▸ End Point`),
		h: prop(ctx, g.highlightLength, (v) => num(v), clock, `${label} ▸ Highlight Length`),
		a: prop(ctx, g.highlightAngle, (v) => num(v), clock, `${label} ▸ Highlight Angle`),
		g: { p: gradientValue(colors.value).p, k: gk },
	};
}

/** Our shape items (index 0 = top) → Lottie shape items (same order; a group's transform last). */
function shapeItems(ctx: Ctx, items: readonly ShapeItem[], clock: Clock, label: string, depth = 0): Json[] {
	const out: Json[] = [];
	if (depth > MAX_DEPTH) return out;
	for (const it of items) {
		const l = `${label} ▸ ${it.name}`;
		const base: Json = { nm: it.name, mn: it.id, ...(it.enabled === false ? { hd: true } : {}) };
		switch (it.type) {
			case 'group':
				out.push({
					...base,
					ty: 'gr',
					...(it.blendMode && it.blendMode !== 'normal' ? { bm: blendCode(ctx, it.blendMode, l) } : {}),
					it: [...shapeItems(ctx, it.contents, clock, l, depth + 1), shapeTransform(ctx, it.transform, clock, l)],
				});
				break;
			case 'rect':
				out.push({
					...base,
					ty: 'rc',
					d: PATH_DIR(it.direction),
					s: prop(ctx, it.size, (v) => vec2(v), clock, `${l} ▸ Size`),
					p: prop(ctx, it.position, (v) => vec2(v), clock, `${l} ▸ Position`),
					r: prop(ctx, it.roundness, (v) => num(v), clock, `${l} ▸ Roundness`),
				});
				break;
			case 'ellipse':
				out.push({
					...base,
					ty: 'el',
					d: PATH_DIR(it.direction),
					s: prop(ctx, it.size, (v) => vec2(v), clock, `${l} ▸ Size`),
					p: prop(ctx, it.position, (v) => vec2(v), clock, `${l} ▸ Position`),
				});
				break;
			case 'polystar':
				out.push({
					...base,
					ty: 'sr',
					d: PATH_DIR(it.direction),
					sy: it.starType === 'polygon' ? 2 : 1,
					pt: prop(ctx, it.points, (v) => num(v), clock, `${l} ▸ Points`),
					p: prop(ctx, it.position, (v) => vec2(v), clock, `${l} ▸ Position`),
					r: prop(ctx, it.rotation, (v) => num(v), clock, `${l} ▸ Rotation`),
					or: prop(ctx, it.outerRadius, (v) => num(v), clock, `${l} ▸ Outer Radius`),
					os: prop(ctx, it.outerRoundness, (v) => num(v), clock, `${l} ▸ Outer Roundness`),
					...(it.starType === 'star'
						? {
								ir: prop(ctx, it.innerRadius, (v) => num(v), clock, `${l} ▸ Inner Radius`),
								is: prop(ctx, it.innerRoundness, (v) => num(v), clock, `${l} ▸ Inner Roundness`),
							}
						: {}),
				});
				break;
			case 'path':
				out.push({
					...base,
					ty: 'sh',
					d: PATH_DIR(it.direction),
					ks: prop(ctx, it.path, (v) => shapeValue(v), clock, `${l} ▸ Path`),
				});
				break;
			case 'fill':
				out.push({
					...base,
					ty: 'fl',
					c: prop(ctx, it.color, (v) => rgb01(v), clock, `${l} ▸ Color`),
					o: prop(ctx, it.opacity, (v) => num(v), clock, `${l} ▸ Opacity`),
					r: it.fillRule === 'evenodd' ? 2 : 1,
					...(it.blendMode && it.blendMode !== 'normal' ? { bm: blendCode(ctx, it.blendMode, l) } : {}),
				});
				if (it.composite === 'above') ctx.warn(`${l}: Composite "Above Previous in Same Group" is not part of Lottie`);
				break;
			case 'stroke':
				out.push({
					...base,
					ty: 'st',
					c: prop(ctx, it.color, (v) => rgb01(v), clock, `${l} ▸ Color`),
					...strokeFields(ctx, it, clock, l),
					...(it.blendMode && it.blendMode !== 'normal' ? { bm: blendCode(ctx, it.blendMode, l) } : {}),
				});
				break;
			case 'gradientFill':
				out.push({
					...base,
					ty: 'gf',
					o: prop(ctx, it.opacity, (v) => num(v), clock, `${l} ▸ Opacity`),
					r: it.fillRule === 'evenodd' ? 2 : 1,
					...gradientFields(ctx, it, clock, l),
					...(it.blendMode && it.blendMode !== 'normal' ? { bm: blendCode(ctx, it.blendMode, l) } : {}),
				});
				break;
			case 'gradientStroke':
				out.push({
					...base,
					ty: 'gs',
					...strokeFields(ctx, it, clock, l),
					...gradientFields(ctx, it, clock, l),
					...(it.blendMode && it.blendMode !== 'normal' ? { bm: blendCode(ctx, it.blendMode, l) } : {}),
				});
				break;
			case 'trim':
				out.push({
					...base,
					ty: 'tm',
					s: prop(ctx, it.start, (v) => num(v), clock, `${l} ▸ Start`),
					e: prop(ctx, it.end, (v) => num(v), clock, `${l} ▸ End`),
					o: prop(ctx, it.offset, (v) => num(v), clock, `${l} ▸ Offset`),
					m: it.mode === 'individual' ? 2 : 1,
				});
				break;
			case 'repeater':
				out.push({
					...base,
					ty: 'rp',
					c: prop(ctx, it.copies, (v) => num(v), clock, `${l} ▸ Copies`),
					o: prop(ctx, it.offset, (v) => num(v), clock, `${l} ▸ Offset`),
					// Lottie `m`: 1 = above, 2 = below (After Effects' Composite).
					m: it.composite === 'above' ? 1 : 2,
					tr: {
						ty: 'tr',
						a: prop(ctx, it.transform.anchor, (v) => vec2(v), clock, `${l} ▸ Anchor Point`),
						p: prop(ctx, it.transform.position, (v) => vec2(v), clock, `${l} ▸ Position`),
						s: prop(ctx, it.transform.scale, (v) => vec2(v), clock, `${l} ▸ Scale`),
						r: prop(ctx, it.transform.rotation, (v) => num(v), clock, `${l} ▸ Rotation`),
						so: prop(ctx, it.transform.startOpacity, (v) => num(v), clock, `${l} ▸ Start Opacity`),
						eo: prop(ctx, it.transform.endOpacity, (v) => num(v), clock, `${l} ▸ End Opacity`),
					},
				});
				break;
			case 'offsetPaths':
				out.push({
					...base,
					ty: 'op',
					a: prop(ctx, it.amount, (v) => num(v), clock, `${l} ▸ Amount`),
					lj: JOIN[it.lineJoin ?? 'miter'] ?? 1,
					ml: prop(ctx, it.miterLimit, (v) => num(v), clock, `${l} ▸ Miter Limit`),
				});
				if (it.copies.value > 1 || it.copies.keyframes.length)
					ctx.warn(`${l}: Offset Paths copies are not part of Lottie (one offset is exported)`);
				break;
			case 'roundCorners':
				out.push({ ...base, ty: 'rd', r: prop(ctx, it.radius, (v) => num(v), clock, `${l} ▸ Radius`) });
				break;
			case 'zigZag':
				out.push({
					...base,
					ty: 'zz',
					s: prop(ctx, it.size, (v) => num(v), clock, `${l} ▸ Size`),
					r: prop(ctx, it.ridges, (v) => num(v), clock, `${l} ▸ Ridges per segment`),
					pt: k0(it.points === 'smooth' ? 2 : 1),
				});
				break;
			case 'twist':
				out.push({
					...base,
					ty: 'tw',
					a: prop(ctx, it.angle, (v) => num(v), clock, `${l} ▸ Angle`),
					c: prop(ctx, it.center, (v) => vec2(v), clock, `${l} ▸ Center`),
				});
				break;
			case 'puckerBloat':
				out.push({ ...base, ty: 'pb', a: prop(ctx, it.amount, (v) => num(v), clock, `${l} ▸ Amount`) });
				break;
			case 'mergePaths':
				out.push({ ...base, ty: 'mm', mm: MERGE[it.mode] ?? 1 });
				ctx.warn(`${l}: Merge Paths is not drawn by every Lottie player (lottie-web ignores it)`);
				break;
			case 'wiggle':
				ctx.warn(`${l}: Wiggle Paths is not part of Lottie (skipped)`);
				break;
		}
	}
	return out;
}

// ---------------------------------------------------------------- text

const JUSTIFY: Record<string, number> = { left: 0, right: 1, center: 2, justify: 3 };

function fontName(family: string, weight: number, italic: boolean): string {
	return `${family.replace(/\s+/g, '')}-${weight}${italic ? 'i' : ''}`;
}

function styleName(weight: number, italic: boolean): string {
	const names: Record<number, string> = {
		100: 'Thin',
		200: 'ExtraLight',
		300: 'Light',
		400: 'Regular',
		500: 'Medium',
		600: 'SemiBold',
		700: 'Bold',
		800: 'ExtraBold',
		900: 'Black',
	};
	const w = names[Math.round(weight / 100) * 100] ?? 'Regular';
	return italic ? (w === 'Regular' ? 'Italic' : `${w} Italic`) : w;
}

function textDocument(ctx: Ctx, content: TextContent, box: { width: number; height: number }, label: string): Json {
	const s: TextStyle = content.style;
	const family = ctx.doc.fonts[s.fontId]?.family ?? 'Inter';
	const fName = fontName(family, s.weight, s.italic);
	if (!ctx.fonts.some((f) => f.fName === fName))
		ctx.fonts.push({ fName, fFamily: family, fStyle: styleName(s.weight, s.italic), ascent: 75 });
	const d: Json = {
		t: (s.allCaps ? content.text.toUpperCase() : content.text).replace(/\r\n|\n/g, '\r'),
		f: fName,
		s: r6(s.sizePx),
		j: JUSTIFY[s.align] ?? 0,
		tr: r6(s.trackingEm * 1000),
		lh: r6(s.sizePx * s.lineHeight),
		ls: r6(s.baselineShiftPx ?? 0),
		fc: rgb01(s.fill).slice(0, 3),
		sz: [r6(box.width), r6(box.height)],
		ps: [0, 0],
	};
	const stroke = s.strokes?.[0] as { color?: RGBA; widthPx?: number; width?: number } | undefined;
	if (stroke?.color) {
		d.sc = rgb01(stroke.color).slice(0, 3);
		d.sw = r6(stroke.widthPx ?? stroke.width ?? 0);
		d.of = true;
	}
	if ((s.strokes?.length ?? 0) > 1) ctx.warn(`${label}: Lottie text has one stroke (the first is exported)`);
	if (s.background) ctx.warn(`${label}: text background is not part of Lottie`);
	if (s.shadow) ctx.warn(`${label}: text shadow is not part of Lottie`);
	if (content.runs?.length) ctx.warn(`${label}: styled runs are not part of Lottie text (the base style is used)`);
	if (s.fill[3] < 1) ctx.warn(`${label}: text fill opacity is not part of Lottie text documents`);
	return d;
}

const BASED_ON: Record<string, number> = { characters: 1, charactersExcludingSpaces: 2, words: 3, lines: 4 };
const SEL_MODE: Record<string, number> = { add: 1, subtract: 2, intersect: 3, min: 4, max: 5, difference: 6 };
const SEL_SHAPE: Record<string, number> = { square: 1, rampUp: 2, rampDown: 3, triangle: 4, round: 5, smooth: 6 };

const ANIM_PROPS: [keyof TextAnimatorGroup['properties'], string, 'num' | 'vec2' | 'scale' | 'color' | 'pos'][] = [
	['anchor', 'a', 'pos'],
	['position', 'p', 'pos'],
	['scale', 's', 'scale'],
	['skew', 'sk', 'num'],
	['skewAxis', 'sa', 'num'],
	['rotation', 'r', 'num'],
	['opacity', 'o', 'num'],
	['fillColor', 'fc', 'color'],
	['strokeColor', 'sc', 'color'],
	['strokeWidth', 'sw', 'num'],
	['tracking', 't', 'num'],
	['fillHue', 'fh', 'num'],
	['fillSaturation', 'fs', 'num'],
	['fillBrightness', 'fb', 'num'],
	['fillOpacity', 'fo', 'num'],
	['strokeOpacity', 'so', 'num'],
	['rotationX', 'rx', 'num'],
	['rotationY', 'ry', 'num'],
];

function textAnimators(ctx: Ctx, groups: readonly TextAnimatorGroup[] | undefined, clock: Clock, label: string): Json[] {
	const out: Json[] = [];
	for (const g of groups ?? []) {
		if (!g.enabled) continue;
		const l = `${label} ▸ ${g.name}`;
		const a: Json = {};
		for (const [key, lk, type] of ANIM_PROPS) {
			const p = g.properties[key] as Animatable<unknown> | undefined;
			if (!p) continue;
			const conv =
				type === 'num'
					? (v: unknown) => num(v)
					: type === 'color'
						? (v: unknown) => rgb01(v as RGBA)
						: type === 'scale'
							? (v: unknown) => [...vec2(v), 100]
							: (v: unknown) => [...vec2(v), 0];
			a[lk] = prop(ctx, p as Animatable<never>, conv, clock, `${l} ▸ ${key}`);
		}
		for (const key of Object.keys(g.properties) as (keyof TextAnimatorGroup['properties'])[]) {
			if (ANIM_PROPS.some(([k]) => k === key) || key === 'trackingType') continue;
			ctx.warn(`${l}: animator property ${key} is not part of Lottie`);
		}
		const sels = g.selectors.filter((s) => s.enabled);
		if (sels.length > 1) ctx.warn(`${l}: only the first selector is exported (a Lottie animator has one)`);
		const first = sels[0];
		let s: Json = { t: 0, r: 1, b: 1, sh: 1, a: k0(100), s: k0(0), e: k0(100), o: k0(0), m: k0(1), rn: 0 };
		if (first && first.kind !== 'range') ctx.warn(`${l}: the ${first.kind} selector is not part of Lottie (all characters are selected)`);
		else if (first) {
			const r = first as TextRangeSelector;
			s = {
				t: 0,
				r: r.units === 'index' ? 2 : 1,
				b: BASED_ON[r.basedOn] ?? 1,
				m: k0(SEL_MODE[r.mode] ?? 1),
				sh: SEL_SHAPE[r.shape] ?? 1,
				a: prop(ctx, r.amount, (v) => num(v), clock, `${l} ▸ Amount`),
				s: prop(ctx, r.start, (v) => num(v), clock, `${l} ▸ Start`),
				e: prop(ctx, r.end, (v) => num(v), clock, `${l} ▸ End`),
				o: prop(ctx, r.offset, (v) => num(v), clock, `${l} ▸ Offset`),
				sm: prop(ctx, r.smoothness, (v) => num(v), clock, `${l} ▸ Smoothness`),
				xe: prop(ctx, r.easeHigh, (v) => num(v), clock, `${l} ▸ Ease High`),
				ne: prop(ctx, r.easeLow, (v) => num(v), clock, `${l} ▸ Ease Low`),
				rn: r.randomize ? 1 : 0,
			};
			if (r.randomize) ctx.warn(`${l}: randomised order uses the player's own random sequence`);
		}
		out.push({ nm: g.name, s, a });
	}
	return out;
}

// ---------------------------------------------------------------- clips

function clockOf(c: Clip, rate: Rational, rangeStart: number): Clock {
	const F = flicksPerFrame(rate);
	const speed = c.speed?.rate ?? 1;
	const reverse = !!c.speed?.reverse;
	return {
		F,
		start: c.start - rangeStart,
		duration: c.duration,
		sourceIn: c.sourceIn,
		rate: speed,
		contentAt(f: number) {
			const i = f - (c.start - rangeStart);
			return reverse ? c.sourceIn + (c.duration - 1 - i) * F * speed : c.sourceIn + i * F * speed;
		},
	};
}

type Placed = { layer: Json; hidden?: boolean };

function layerTimes(c: Clip, clock: Clock): Json {
	// Lottie layer time = (comp frame − st) / sr; content time c ↔ layer frame c / F.
	const sr = 1 / clock.rate;
	const st = clock.start - clock.sourceIn / clock.F / clock.rate;
	return { ip: clock.start, op: clock.start + clock.duration, st: r6(st), sr: r6(sr) };
}

function clipLayer(ctx: Ctx, seq: Sequence, c: Clip, rangeStart: number, depth: number): Placed | null {
	const clock = clockOf(c, seq.settings.frameRate as Rational, rangeStart);
	const label = `"${c.name}"`;
	const box = intrinsicBoxOf({ clip: c, doc: ctx.doc, seq } as never);
	const r = c as Clip & {
		transform?: Transform;
		opacity?: Animatable<number>;
		blendMode?: string;
		masks?: Mask[];
	};
	if (c.speed?.reverse) ctx.warn(`${label}: reverse playback is not supported by Lottie players (exported forwards)`);
	if ((c as { timeRemap?: { enabled?: boolean } }).timeRemap?.enabled)
		ctx.warn(`${label}: Time Remapping is not exported`);
	const base = (ty: number, origin: [number, number]): Json => ({
		ty,
		nm: c.name,
		ind: 0,
		ddd: 0,
		...layerTimes(c, clock),
		ks: transform(ctx, r.transform ?? null, r.opacity ?? { value: 100, keyframes: [] }, clock, origin, label),
		bm: blendCode(ctx, r.blendMode, label),
		ao: 0,
	});
	let layer: Json;
	switch (c.kind) {
		case 'shape': {
			const shape = c.shape;
			const items: ShapeItem[] =
				shape.type === 'vector'
					? (shape.contents as ShapeItem[])
					: legacyToVectorItems(shape, {
							item: (() => {
								let n = 0;
								return () => `lg_${++n}`;
							})(),
							keyframe: (() => {
								let n = 0;
								return () => `lk_${++n}`;
							})(),
						});
			const origin: [number, number] = [box.width / 2, box.height / 2];
			layer = { ...base(4, origin), shapes: shapeItems(ctx, items, clock, label) };
			const m = masks(ctx, r.masks, box, origin, clock, label);
			if (m.length) Object.assign(layer, { hasMask: true, masksProperties: m });
			break;
		}
		case 'text': {
			const docs: Json[] = [];
			const keys = c.sourceTextKeyframes ?? [];
			if (keys.length === 0) docs.push({ t: 0, s: textDocument(ctx, c.content, c.box, label) });
			else
				for (const k of keys)
					docs.push({
						t: r6(k.time / clock.F),
						s: textDocument(ctx, k.value as TextContent, c.box, label),
					});
			if (c.content.expression?.enabled) ctx.warn(`${label}: the Source Text expression is not exported`);
			if (c.textAnimation && (c.textAnimation.in || c.textAnimation.out))
				ctx.warn(`${label}: text animation presets are not exported (convert them to animators first)`);
			if (c.pathOptions) ctx.warn(`${label}: text on a path is not exported`);
			if (c.perCharacter3d) ctx.warn(`${label}: per-character 3D is not exported`);
			layer = {
				...base(5, [0, 0]),
				t: {
					d: { k: docs },
					a: textAnimators(ctx, c.animators, clock, label),
					m: { g: 1, a: k0([0, 0]) },
					p: {},
				},
			};
			const m = masks(ctx, r.masks, box, [0, 0], clock, label);
			if (m.length) Object.assign(layer, { hasMask: true, masksProperties: m });
			break;
		}
		case 'solid': {
			const syn = ctx.doc.synthetics[c.syntheticId] as { kind?: string; color?: RGBA } | undefined;
			if (syn?.kind !== 'color-matte' || !syn.color) {
				ctx.warn(`${label}: ${syn?.kind ?? 'generator'} pictures are not part of Lottie (skipped)`);
				return null;
			}
			const col = syn.color;
			const hex = `#${[col[0], col[1], col[2]].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
			layer = { ...base(1, [0, 0]), sc: hex, sw: Math.round(box.width), sh: Math.round(box.height) };
			const m = masks(ctx, r.masks, box, [0, 0], clock, label);
			if (m.length) Object.assign(layer, { hasMask: true, masksProperties: m });
			break;
		}
		case 'still': {
			const media = ctx.media[c.mediaId];
			if (media?.kind !== 'image') {
				ctx.warn(`${label}: the picture cannot be embedded (skipped)`);
				return null;
			}
			const id = `image_${c.mediaId}`;
			if (!ctx.has(id)) {
				ctx.add(id);
				ctx.assets.push({ id, w: Math.round(box.width), h: Math.round(box.height), u: '', p: media.dataUri, e: 1 });
			}
			layer = { ...base(2, [0, 0]), refId: id };
			const m = masks(ctx, r.masks, box, [0, 0], clock, label);
			if (m.length) Object.assign(layer, { hasMask: true, masksProperties: m });
			break;
		}
		case 'animated-image': {
			const media = ctx.media[c.mediaId];
			if (media?.kind !== 'lottie') {
				ctx.warn(`${label}: animated images other than Lottie animations are not part of Lottie (skipped)`);
				return null;
			}
			const id = embedLottie(ctx, c.mediaId, media.doc);
			const fr = Number(media.doc.fr) || 30;
			const seqFps = (seq.settings.frameRate.num as number) / (seq.settings.frameRate.den as number);
			layer = { ...base(0, [0, 0]), refId: id, w: Math.round(box.width), h: Math.round(box.height) };
			// The precomp runs on its own frames: stretch so one of its frames lasts its own duration.
			const ip = Number(media.doc.ip) || 0;
			layer.sr = r6((layer.sr as number) * (seqFps / fr));
			layer.st = r6(clock.start - (clock.sourceIn / FLICKS_PER_SECOND) * seqFps / clock.rate - ip * (layer.sr as number));
			if ((c as { loop?: boolean }).loop) ctx.warn(`${label}: a looping Lottie clip plays once in the export`);
			if (ctx.doc.media[c.mediaId]?.interpretation)
				ctx.warn(`${label}: Interpret Footage settings of the Lottie animation are not exported`);
			break;
		}
		case 'nest-video': {
			const nested = ctx.doc.sequences[c.sequenceId];
			if (!nested || depth >= MAX_DEPTH) {
				ctx.warn(`${label}: the nested sequence is missing (skipped)`);
				return null;
			}
			const id = `comp_${c.sequenceId}`;
			if (!ctx.has(id)) {
				ctx.add(id);
				const layers = sequenceLayers(ctx, nested, 0, Number.POSITIVE_INFINITY, depth + 1);
				ctx.assets.push({ id, nm: c.name, fr: r6(fps(nested.settings.frameRate as Rational)), layers });
			}
			layer = { ...base(0, [0, 0]), refId: id, w: nested.settings.width, h: nested.settings.height };
			if (!rationalEqual(nested.settings.frameRate as Rational, seq.settings.frameRate as Rational))
				ctx.warn(`${label}: the nested sequence's frame rate differs (its frames are drawn at the outer rate)`);
			if ((c as { multicam?: unknown }).multicam) ctx.warn(`${label}: multi-camera switching is not exported`);
			break;
		}
		case 'video':
			ctx.warn(`${label}: video footage is not part of Lottie (skipped)`);
			return null;
		case 'adjustment':
			ctx.warn(`${label}: adjustment layers are not part of Lottie (skipped)`);
			return null;
		case 'captions':
			ctx.warn(`${label}: captions are not part of Lottie (skipped)`);
			return null;
		case 'motion-graphic':
		case 'composition':
			ctx.warn(`${label}: ${c.kind} clips are rendered by the editor and are not part of Lottie (skipped)`);
			return null;
		default:
			return null;
	}
	const fx = effects(ctx, c, clock, label);
	if (fx.length) layer.ef = fx;
	if (((r as { trackedBy?: unknown }).trackedBy)) ctx.warn(`${label}: tracking links are exported as their keyframes only`);
	return { layer, hidden: !c.enabled };
}

const fps = (r: Rational) => r.num / r.den;
const rationalEqual = (a: Rational, b: Rational) => a.num * b.den === b.num * a.den;

function embedLottie(ctx: Ctx, mediaId: string, doc: Json): string {
	const id = `lottie_${mediaId}`;
	if (ctx.has(id)) return id;
	ctx.add(id);
	// Its own assets move to the root with prefixed ids (refIds rewritten throughout its layers).
	const prefix = `${mediaId}_`;
	const remap = (layers: unknown): unknown =>
		Array.isArray(layers)
			? layers.map((l) => {
					const o = { ...(l as Json) };
					if (typeof o.refId === 'string') o.refId = prefix + o.refId;
					return o;
				})
			: [];
	for (const a of (doc.assets as Json[] | undefined) ?? []) {
		const copy: Json = { ...a, id: prefix + String(a.id) };
		if (Array.isArray(a.layers)) copy.layers = remap(a.layers);
		ctx.assets.push(copy);
	}
	if (Array.isArray(doc.chars) && doc.chars.length) ctx.warn('An embedded Lottie animation carries glyphs (chars); they are kept at the root');
	const fonts = (doc.fonts as { list?: Json[] } | undefined)?.list ?? [];
	for (const f of fonts) if (!ctx.fonts.some((x) => x.fName === f.fName)) ctx.fonts.push(f);
	ctx.assets.push({ id, nm: String(doc.nm ?? 'Lottie'), fr: Number(doc.fr) || 30, layers: remap(doc.layers) });
	return id;
}

/** The layers of a sequence over comp frames [start, end) (top video track first). */
function sequenceLayers(ctx: Ctx, seq: Sequence, start: number, end: number, depth: number): Json[] {
	const out: Json[] = [];
	const tracks = [...seq.videoTracks].reverse();
	for (const t of tracks) {
		const clips = Object.values(seq.clips)
			.filter((c) => c.trackId === t.id && c.start < end && c.start + c.duration > start)
			.sort((a, b) => a.start - b.start);
		for (const c of clips) {
			const placed = clipLayer(ctx, seq, c, start, depth);
			if (!placed) continue;
			if (placed.hidden || t.output === false) placed.layer.hd = true;
			out.push(placed.layer);
		}
	}
	const hasTransitions = Object.keys(seq.transitions ?? {}).length > 0;
	if (hasTransitions) ctx.warn('Transitions are not part of Lottie (the clips cut instead)');
	out.forEach((l, i) => {
		l.ind = i + 1;
	});
	ctx.layerCount += out.length;
	return out;
}

/** Exports `sequenceId` as a Lottie document (`v` 5.12.0). Pure; pass embedded media in `opts.media`. */
export function exportSequenceToLottie(
	doc: ProjectDocument,
	sequenceId: string,
	opts: LottieExportOptions = {},
): LottieExportResult {
	// Expressions evaluate (bake) through their bound evaluators.
	const bound = bindExpressions(doc);
	const seq = bound.sequences[sequenceId];
	if (!seq) throw new Error(`Sequence not found: ${sequenceId}`);
	const ctx = new Ctx(bound, opts.media ?? {});
	let end = 0;
	for (const c of Object.values(seq.clips)) end = Math.max(end, c.start + c.duration);
	const range = opts.range ?? { start: 0, end: Math.max(1, end) };
	const rate = seq.settings.frameRate as Rational;
	const layers = sequenceLayers(ctx, seq, range.start, range.end, 0);
	for (const t of seq.audioTracks)
		if (Object.values(seq.clips).some((c) => c.trackId === t.id)) {
			ctx.warn('Audio is not part of Lottie');
			break;
		}
	const markers = (seq.markers ?? [])
		.filter((m) => m.frame >= range.start && m.frame < range.end)
		.map((m) => ({ tm: m.frame - range.start, cm: m.name || m.comment, dr: m.duration }));
	const json: Json = {
		v: '5.12.0',
		fr: r6(fps(rate)),
		ip: 0,
		op: range.end - range.start,
		w: seq.settings.width,
		h: seq.settings.height,
		nm: Object.values(doc.items).find((it) => it.kind === 'sequence' && it.sequenceId === sequenceId)?.name ?? 'Sequence',
		ddd: 0,
		assets: ctx.assets,
		layers,
		markers,
		meta: { g: opts.generator ?? 'JasperEditor' },
	};
	if (ctx.fonts.length) json.fonts = { list: ctx.fonts };
	if (layers.length === 0) ctx.warn('The sequence has no clip Lottie can carry');
	return { json, warnings: ctx.warnings, layers: ctx.layerCount };
}

/** BLEND_MODES that have a Lottie code (for UI hints). */
export const LOTTIE_BLEND_MODES: readonly string[] = LOTTIE_BLEND.filter((m) => (BLEND_MODES as readonly string[]).includes(m));
