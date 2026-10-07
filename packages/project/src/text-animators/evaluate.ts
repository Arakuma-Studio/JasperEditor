// Text animator evaluation (workstream text-animators): the selection of every character by an animator's
// selectors and the per-character animation state (`CharXf`) summed over every animator, at one content time.
// Pure; the text layer feeds it the laid-out characters and draws the result.
//
// Ported from EffectCraft `crates/render/src/text.rs` (`CharXf`, `animator_selection`, `char_transforms`,
// `substitute`, `adjust_color`; MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team and the EffectCraft
// contributors; see licenses/ported/text-animators.md).
import { evaluate, evaluateKeyframes, expressionBindingOf } from '../keyframes.ts';
import type { Animatable, Keyframe, RGBA } from '../schema/common.ts';
import type { TextContent } from '../schema/sequence.ts';
import type {
	TextAnimatorGroup,
	TextAnimatorProperties,
	TextExpressionSelector,
	TextRangeSelector,
	TextSelector,
	TextSelectorBasedOn,
	TextSelectorMode,
	TextWigglySelector,
} from '../schema/text-animators.ts';
import { FLICKS_PER_SECOND } from '../time.ts';
import {
	layerSeed,
	modeCombine,
	modeInitial,
	type RangeParams,
	randomOrder,
	rangeValue,
	type TextUnitCounts,
	type TextUnitIndices,
	unitCount,
	unitOf,
	wigglyValue,
} from './selectors.ts';

/** Evaluated per-character animation state (sums of every animator, weighted by selection). */
export type CharXf = {
	/** Position offset (px, Y down) x, y, z. */
	offset: [number, number, number];
	anchor: [number, number, number];
	/** Percent. */
	scale: [number, number, number];
	/** Z rotation (2D rotation), degrees clockwise. */
	rotation: number;
	rotationX: number;
	rotationY: number;
	skew: number;
	skewAxis: number;
	/** Percent. */
	opacity: number;
	fill: RGBA | null;
	fillK: number;
	/** Hue (degrees), saturation and brightness (percent) offsets. */
	fillHsb: [number, number, number];
	fillOpacity: number;
	stroke: RGBA | null;
	strokeK: number;
	strokeHsb: [number, number, number];
	strokeOpacity: number;
	strokeWidth: number;
	/** Tracking (1/1000 em) added before / after the character. */
	trackBefore: number;
	trackAfter: number;
	/** Line Anchor (percent) and the selection weight it was set with. */
	lineAnchor: number;
	lineAnchorK: number;
	lineSpacing: [number, number];
	charOffset: number;
	/** Character Value (code point) and its selection. */
	charValue: [value: number, k: number] | null;
	charRange: 'preserveCaseAndDigits' | 'fullUnicode';
	charAlign: 'left' | 'center' | 'right' | 'adjustKerning';
	/** Blur (px) x, y. */
	blur: [number, number];
	/** Variable font axis offsets (tag → user units). */
	axes: Record<string, number>;
};

export function defaultCharXf(): CharXf {
	return {
		offset: [0, 0, 0],
		anchor: [0, 0, 0],
		scale: [100, 100, 100],
		rotation: 0,
		rotationX: 0,
		rotationY: 0,
		skew: 0,
		skewAxis: 0,
		opacity: 100,
		fill: null,
		fillK: 0,
		fillHsb: [0, 0, 0],
		fillOpacity: 100,
		stroke: null,
		strokeK: 0,
		strokeHsb: [0, 0, 0],
		strokeOpacity: 100,
		strokeWidth: 0,
		trackBefore: 0,
		trackAfter: 0,
		lineAnchor: 0,
		lineAnchorK: 0,
		lineSpacing: [0, 0],
		charOffset: 0,
		charValue: null,
		charRange: 'preserveCaseAndDigits',
		charAlign: 'center',
		blur: [0, 0],
		axes: {},
	};
}

/** True when the state draws the character exactly as laid out (nothing animated on it). */
export function isIdentityCharXf(x: CharXf): boolean {
	return (
		x.offset.every((v) => v === 0) &&
		x.anchor.every((v) => v === 0) &&
		x.scale.every((v) => v === 100) &&
		x.rotation === 0 &&
		x.rotationX === 0 &&
		x.rotationY === 0 &&
		x.skew === 0 &&
		x.opacity === 100 &&
		x.fillK === 0 &&
		x.fillHsb.every((v) => v === 0) &&
		x.fillOpacity === 100 &&
		x.strokeK === 0 &&
		x.strokeHsb.every((v) => v === 0) &&
		x.strokeOpacity === 100 &&
		x.strokeWidth === 0 &&
		x.trackBefore === 0 &&
		x.trackAfter === 0 &&
		x.lineAnchorK === 0 &&
		x.lineSpacing[0] === 0 &&
		x.lineSpacing[1] === 0 &&
		x.charOffset === 0 &&
		x.charValue === null &&
		x.blur[0] === 0 &&
		x.blur[1] === 0 &&
		Object.values(x.axes).every((v) => v === 0)
	);
}

/** One laid-out character as the selectors see it. */
export type AnimatorGlyph = TextUnitIndices & { isSpace: boolean };

export type AnimatorEvalContext = {
	/** Content time in flicks (keyframe time). */
	time: number;
	/** The layer identity the random seeds are mixed with (`clipLayerId(clipId)`). */
	layerId: bigint;
	/** Expression Selector evaluation (absent: the expression engine is not loaded; static Amount applies). */
	expressions?: TextSelectorExpressionHost;
};

const num = (a: Animatable<number> | undefined, t: number, d: number) => (a ? evaluate(a, t) : d);

/** Range Selector parameters at a time (fractions of `n` units). */
export function rangeParams(sel: TextRangeSelector, t: number, n: number): RangeParams {
	const index = sel.units === 'index';
	const div = index ? Math.max(1, n) : 100;
	return {
		start: num(sel.start, t, 0) / div,
		end: num(sel.end, t, index ? n : 100) / div,
		offset: num(sel.offset, t, 0) / div,
		amount: num(sel.amount, t, 100) / 100,
		shape: sel.shape,
		smoothness: num(sel.smoothness, t, 100) / 100,
		easeHigh: num(sel.easeHigh, t, 0) / 100,
		easeLow: num(sel.easeLow, t, 0) / 100,
	};
}

type Sel3 = [number, number, number];

/**
 * Extension point for selector kinds (e.g. an Expression Selector once an expression engine exists): given the
 * selector, the unit `i` of `n` and the selection of the selectors above it (`prev`), the selector's value per
 * dimension. `replaces`: the value replaces the selection instead of being combined by a mode (AE's Expression
 * Selector reads the selection as `selectorValue` and has no Mode). Range and Wiggly are registered below.
 */
export type TextSelectorEvaluator = {
	mode(sel: TextSelector): TextSelectorMode;
	basedOn(sel: TextSelector): TextSelectorBasedOn;
	replaces?: boolean;
	/** Prepares the selector at a time; the returned function is called per unit. */
	prepare(
		sel: TextSelector,
		ctx: AnimatorEvalContext & { n: number; seconds: number },
	): (i: number, n: number, prev: Sel3) => Sel3;
};

const SELECTOR_EVALUATORS = new Map<string, TextSelectorEvaluator>();

/** Registers the evaluator of a selector kind (see `TextSelectorEvaluator`). */
export function registerTextSelectorEvaluator(kind: string, e: TextSelectorEvaluator): void {
	SELECTOR_EVALUATORS.set(kind, e);
}

registerTextSelectorEvaluator('range', {
	mode: (s) => (s as TextRangeSelector).mode,
	basedOn: (s) => s.basedOn,
	prepare: (s, ctx) => {
		const sel = s as TextRangeSelector;
		const r = rangeParams(sel, ctx.time, ctx.n);
		const perm = sel.randomize
			? randomOrder(ctx.n, layerSeed(ctx.layerId, num(sel.randomSeed, ctx.time, 0)))
			: null;
		return (i, n) => {
			const j = perm?.[i] ?? i;
			const v = rangeValue(r, j, n);
			return [v, v, v];
		};
	},
});

registerTextSelectorEvaluator('wiggly', {
	mode: (s) => (s as TextWigglySelector).mode,
	basedOn: (s) => s.basedOn,
	prepare: (s, ctx) => {
		const sel = s as TextWigglySelector;
		const t = ctx.time;
		const w = {
			max: num(sel.maxAmount, t, 100) / 100,
			min: num(sel.minAmount, t, -100) / 100,
			wigglesPerSecond: num(sel.wigglesPerSecond, t, 2),
			correlation: num(sel.correlation, t, 50) / 100,
			temporalPhase: num(sel.temporalPhase, t, 0),
			spatialPhase: num(sel.spatialPhase, t, 0),
			lockDimensions: sel.lockDimensions,
			seed: layerSeed(ctx.layerId, num(sel.randomSeed, t, 0)),
		};
		return (i) => [0, 1, 2].map((d) => wigglyValue(w, ctx.seconds, i, d)) as Sel3;
	},
});

/**
 * The Expression Selector's per-unit evaluation, installed by the expression engine (`@jasper/expressions`
 * `installTextSelectorExpressions`): `amount` in percent per dimension, or null when the expression fails (the
 * selector then falls back to its static Amount, like a property whose expression errors).
 */
export type TextSelectorExpressionHost = (input: {
	selectorId: string;
	text: string;
	/** Content time (flicks). */
	time: number;
	textIndex: number;
	textTotal: number;
	/** Percent. */
	selectorValue: [number, number, number];
}) => [number, number, number] | null;

registerTextSelectorEvaluator('expression', {
	mode: () => 'add',
	basedOn: (s) => s.basedOn,
	replaces: true,
	prepare: (s, ctx) => {
		const sel = s as TextExpressionSelector;
		// The Amount's expression is per unit (below): its keyframed value is the static fallback.
		const stat = evaluateKeyframes(sel.amount, ctx.time);
		const expr = sel.amount.expression;
		const host = expr?.enabled && expr.text.trim() ? ctx.expressions : undefined;
		return (i, n, prev) => {
			const pv = prev.map((x) => x * 100) as Sel3;
			const r = host?.({
				selectorId: sel.id,
				text: expr!.text,
				time: ctx.time,
				textIndex: i + 1,
				textTotal: n,
				selectorValue: pv,
			});
			// Without an engine (or on error): the static Amount scales the selection above (EffectCraft fallback).
			const v = r ?? (pv.map((x) => (x * stat) / 100) as Sel3);
			return v.map((x) => Math.min(1, Math.max(-1, x / 100))) as Sel3;
		};
	},
});

/** Whether a selector kind has an evaluator (unknown kinds are skipped, like EffectCraft). */
export function isKnownSelectorKind(kind: string): boolean {
	return SELECTOR_EVALUATORS.has(kind);
}

/** Selection of every glyph by an animator's selectors, per dimension. */
export function animatorSelection(
	anim: Pick<TextAnimatorGroup, 'selectors'>,
	glyphs: readonly AnimatorGlyph[],
	counts: TextUnitCounts,
	ctx: AnimatorEvalContext,
): Sel3[] {
	const sels = anim.selectors.filter((s) => s.enabled && SELECTOR_EVALUATORS.has(s.kind));
	// No selectors: every character is fully affected.
	if (sels.length === 0) return glyphs.map(() => [1, 1, 1]);
	const acc: Sel3[] = glyphs.map(() => [0, 0, 0]);
	const seconds = ctx.time / FLICKS_PER_SECOND;
	sels.forEach((sel, si) => {
		const ev = SELECTOR_EVALUATORS.get(sel.kind)!;
		const mode = ev.mode(sel);
		const based = ev.basedOn(sel);
		const n = unitCount(based, counts);
		const values = ev.prepare(sel, { ...ctx, n, seconds });
		const replace = !!ev.replaces;
		const memo = new Map<string, Sel3>();
		glyphs.forEach((g, gi) => {
			const [i, cnt] = unitOf(based, g, counts);
			const prev: Sel3 =
				si === 0
					? replace
						? [1, 1, 1]
						: [modeInitial(mode), modeInitial(mode), modeInitial(mode)]
					: acc[gi]!;
			const key = `${i}|${prev[0]}|${prev[1]}|${prev[2]}`;
			let v = memo.get(key);
			if (!v) {
				v = values(i, cnt, prev);
				memo.set(key, v);
			}
			acc[gi] = replace
				? v
				: [
						modeCombine(mode, prev[0], v[0]),
						modeCombine(mode, prev[1], v[1]),
						modeCombine(mode, prev[2], v[2]),
					];
		});
	});
	return acc;
}

/** The animatable properties of an animator at a time (absent = not on this animator). */
type EvalProps = {
	pos?: Sel3;
	anchor?: Sel3;
	scale?: Sel3;
	rot?: number;
	rx?: number;
	ry?: number;
	skew?: number;
	skewAxis?: number;
	op?: number;
	fill?: RGBA;
	stroke?: RGBA;
	fillHsb: (number | undefined)[];
	strokeHsb: (number | undefined)[];
	fillOp?: number;
	strokeOp?: number;
	sw?: number;
	tracking?: number;
	trackingType: TextAnimatorProperties['trackingType'];
	lineAnchor?: number;
	lineSpacing?: [number, number];
	charOffset?: number;
	charValue?: number;
	charRange?: CharXf['charRange'];
	charAlign?: CharXf['charAlign'];
	blur?: [number, number];
	axes: [string, number][];
};

function evalProps(p: TextAnimatorProperties, t: number, threeD: boolean): EvalProps {
	const n = (a: Animatable<number> | undefined) => (a ? evaluate(a, t) : undefined);
	const v2 = (a: Animatable<[number, number]> | undefined) => (a ? evaluate(a, t) : undefined);
	const vec3 = (
		xy: Animatable<[number, number]> | undefined,
		z: Animatable<number> | undefined,
		d: number,
	): Sel3 | undefined => {
		if (!xy && !(threeD && z)) return undefined;
		const v = xy ? evaluate(xy, t) : [d, d];
		return [v[0], v[1], threeD && z ? evaluate(z, t) : d];
	};
	return {
		pos: vec3(p.position as Animatable<[number, number]> | undefined, p.positionZ, 0),
		anchor: vec3(p.anchor as Animatable<[number, number]> | undefined, p.anchorZ, 0),
		scale: vec3(p.scale as Animatable<[number, number]> | undefined, p.scaleZ, 100),
		rot: n(p.rotation),
		rx: n(p.rotationX),
		ry: n(p.rotationY),
		skew: n(p.skew),
		skewAxis: n(p.skewAxis),
		op: n(p.opacity),
		fill: p.fillColor ? (evaluate(p.fillColor as Animatable<RGBA>, t) as RGBA) : undefined,
		stroke: p.strokeColor ? (evaluate(p.strokeColor as Animatable<RGBA>, t) as RGBA) : undefined,
		fillHsb: [n(p.fillHue), n(p.fillSaturation), n(p.fillBrightness)],
		strokeHsb: [n(p.strokeHue), n(p.strokeSaturation), n(p.strokeBrightness)],
		fillOp: n(p.fillOpacity),
		strokeOp: n(p.strokeOpacity),
		sw: n(p.strokeWidth),
		tracking: n(p.tracking),
		trackingType: p.trackingType,
		lineAnchor: n(p.lineAnchor),
		lineSpacing: v2(p.lineSpacing as Animatable<[number, number]> | undefined),
		charOffset: n(p.characterOffset),
		charValue: n(p.characterValue),
		charRange: p.characterRange,
		charAlign: p.characterAlignment,
		blur: v2(p.blur as Animatable<[number, number]> | undefined),
		axes: Object.entries(p.axes ?? {}).map(([tag, a]) => [tag, evaluate(a, t)]),
	};
}

/**
 * Evaluates every enabled animator for every glyph at a content time. `threeD` = per-character 3D: without it Z
 * components and X / Y rotation have no effect (as in AE, where they only exist on 3D-enabled text).
 */
export function charTransforms(
	animators: readonly TextAnimatorGroup[] | undefined,
	glyphs: readonly AnimatorGlyph[],
	counts: TextUnitCounts,
	ctx: AnimatorEvalContext,
	threeD = false,
): CharXf[] {
	const out = glyphs.map(() => defaultCharXf());
	for (const anim of animators ?? []) {
		if (!anim.enabled) continue;
		const sel = animatorSelection(anim, glyphs, counts, ctx);
		const p = evalProps(anim.properties, ctx.time, threeD);
		sel.forEach((k3, gi) => {
			const k = k3[0];
			if (k3[0] === 0 && k3[1] === 0 && k3[2] === 0) return;
			const c = out[gi]!;
			for (let d = 0; d < 3; d++) {
				if (p.pos) c.offset[d]! += p.pos[d]! * k3[d]!;
				if (p.anchor) c.anchor[d]! += p.anchor[d]! * k3[d]!;
				if (p.scale) c.scale[d]! *= 1 + (p.scale[d]! / 100 - 1) * k3[d]!;
			}
			if (p.rot !== undefined) c.rotation += p.rot * k;
			if (p.rx !== undefined) c.rotationX += p.rx * k;
			if (p.ry !== undefined) c.rotationY += p.ry * k;
			if (p.skew !== undefined) c.skew += p.skew * k;
			if (p.skewAxis !== undefined) c.skewAxis = p.skewAxis;
			if (p.op !== undefined) c.opacity *= 1 + (p.op / 100 - 1) * k;
			if (p.fill) {
				c.fill = p.fill;
				c.fillK = Math.min(1, Math.max(0, c.fillK + k));
			}
			if (p.stroke) {
				c.stroke = p.stroke;
				c.strokeK = Math.min(1, Math.max(0, c.strokeK + k));
			}
			for (let d = 0; d < 3; d++) {
				const f = p.fillHsb[d];
				if (f !== undefined) c.fillHsb[d]! += f * k;
				const s = p.strokeHsb[d];
				if (s !== undefined) c.strokeHsb[d]! += s * k;
			}
			if (p.fillOp !== undefined) c.fillOpacity *= 1 + (p.fillOp / 100 - 1) * k;
			if (p.strokeOp !== undefined) c.strokeOpacity *= 1 + (p.strokeOp / 100 - 1) * k;
			if (p.sw !== undefined) c.strokeWidth += p.sw * k;
			if (p.tracking !== undefined) {
				const tr = p.tracking * k;
				if (p.trackingType === 'before') c.trackBefore += tr;
				else if (p.trackingType === 'after') c.trackAfter += tr;
				else {
					c.trackBefore += tr * 0.5;
					c.trackAfter += tr * 0.5;
				}
			}
			if (p.lineAnchor !== undefined && Math.abs(k) >= c.lineAnchorK) {
				c.lineAnchor = p.lineAnchor;
				c.lineAnchorK = Math.abs(k);
			}
			if (p.lineSpacing) {
				c.lineSpacing[0] += p.lineSpacing[0] * k;
				c.lineSpacing[1] += p.lineSpacing[1] * k;
			}
			if (p.charOffset !== undefined) c.charOffset += p.charOffset * k;
			if (p.charValue !== undefined) c.charValue = [p.charValue, k];
			if (p.charRange) c.charRange = p.charRange;
			if (p.charAlign) c.charAlign = p.charAlign;
			if (p.blur) {
				c.blur[0] += Math.abs(p.blur[0] * k3[0]);
				c.blur[1] += Math.abs(p.blur[1] * k3[1]);
			}
			for (const [tag, v] of p.axes) c.axes[tag] = (c.axes[tag] ?? 0) + v * k;
		});
	}
	return out;
}

/** Rust `f64::round` (half away from zero). */
export function roundHalfAway(x: number): number {
	return x < 0 ? -Math.round(-x) : Math.round(x);
}

const WHITE_SPACE = /^\p{White_Space}$/u;
const isLower = (c: number) => c >= 0x61 && c <= 0x7a;
const isUpper = (c: number) => c >= 0x41 && c <= 0x5a;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const validScalar = (c: number) => c >= 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff);
const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Character Offset / Character Value substitution of one character (`ch` = one code point); null = unchanged.
 * Preserve Case & Digits cycles letters within a–z / A–Z and digits within 0–9; Full Unicode moves through code
 * points.
 */
export function substituteCharacter(
	ch: string,
	x: Pick<CharXf, 'charValue' | 'charOffset' | 'charRange'>,
): string | null {
	if (WHITE_SPACE.test(ch)) return null;
	let code = ch.codePointAt(0) ?? 0;
	if (x.charValue) code += (x.charValue[0] - code) * x.charValue[1];
	const off = roundHalfAway(x.charOffset);
	const base = Math.max(0, roundHalfAway(code));
	let out: number;
	if (x.charRange === 'fullUnicode') {
		out = Math.max(0, base + off);
		if (!validScalar(out)) return null;
	} else {
		if (!validScalar(base)) return null;
		if (isLower(base)) out = 0x61 + mod(base - 0x61 + off, 26);
		else if (isUpper(base)) out = 0x41 + mod(base - 0x41 + off, 26);
		else if (isDigit(base)) out = 0x30 + mod(base - 0x30 + off, 10);
		else out = base;
	}
	const s = String.fromCodePoint(out);
	return s !== ch ? s : null;
}

/** RGB (0…1) → HSV (h 0…1). */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	let h: number;
	if (d < 1e-7) h = 0;
	else if (max === r) h = mod((g - b) / d, 6) / 6;
	else if (max === g) h = ((b - r) / d + 2) / 6;
	else h = ((r - g) / d + 4) / 6;
	return [h, max > 0 ? d / max : 0, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	const h6 = mod(h, 1) * 6;
	const i = Math.floor(h6);
	const f = h6 - i;
	const p = v * (1 - s);
	const q = v * (1 - s * f);
	const t = v * (1 - s * (1 - f));
	switch (i) {
		case 0:
			return [v, t, p];
		case 1:
			return [q, v, p];
		case 2:
			return [p, v, t];
		case 3:
			return [p, q, v];
		case 4:
			return [t, p, v];
		default:
			return [v, p, q];
	}
}

/** A style colour with an animator's RGB (weighted by `k`), HSB offsets and opacity applied. */
export function adjustColor(
	base: RGBA,
	rgb: RGBA | null,
	k: number,
	hsb: readonly [number, number, number],
	opacity: number,
): RGBA {
	let c: RGBA = rgb
		? [
				base[0] + (rgb[0] - base[0]) * k,
				base[1] + (rgb[1] - base[1]) * k,
				base[2] + (rgb[2] - base[2]) * k,
				base[3] + (rgb[3] - base[3]) * k,
			]
		: [...base];
	if (hsb[0] !== 0 || hsb[1] !== 0 || hsb[2] !== 0) {
		const [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
		const [r, g, b] = hsvToRgb(
			h + hsb[0] / 360,
			Math.min(1, Math.max(0, s + hsb[1] / 100)),
			Math.min(1, Math.max(0, v + hsb[2] / 100)),
		);
		c = [r, g, b, c[3]];
	}
	c[3] *= Math.min(1, Math.max(0, opacity / 100));
	return c;
}

/**
 * The text content a text clip shows at content time `t`: its Source Text hold keys (the last key at or before
 * `t`, the first key before it; none = `content`), then a Source Text expression (bound by the expression engine)
 * replaces the text — when it changes the text the styled runs no longer line up, so the base style applies to all
 * of it (as AE applies the first character's style).
 */
export function sourceTextContentAt(
	src: { text: TextContent; sourceTextKeyframes?: readonly Keyframe<TextContent>[] },
	t: number,
): TextContent {
	const keys = src.sourceTextKeyframes ?? [];
	let keyed = src.text;
	if (keys.length) {
		let k = keys[0]!;
		for (const x of keys) if (x.time <= t) k = x;
		keyed = k.value;
	}
	const b = expressionBindingOf(src.text);
	if (!b) return keyed;
	const v = b.evaluate(t);
	const text = typeof v === 'string' ? v : keyed.text;
	return text === keyed.text ? keyed : { ...keyed, text, runs: undefined };
}
