// Crop on the native path (S01:FX-002/003, schema v8, docs/wp-notes/crop-order.md). The source chain applies a
// clip's effects in stack order, so a crop is cut where it sits:
// - a hard crop (Edge Feather 0 on every frame) is `crop`+`pad` in whole pixels, a per-frame rectangle mask when its
//   edges are keyframed (`cropMaskFilter`), or the sub-pixel kernel's anti-aliased clip (stream/plan.ts) — the kernel
//   clips after the source chain, which equals the stack position because every effect the native path draws after a
//   crop commutes with it (colour LUTs act on straight colour; a flip after a crop mirrors its window, `stackCrops`);
// - a feathered crop multiplies the alpha by the Edge Feather profile of `render/crop.ts` (`cropEdgeCoverage`, the
//   formula the preview shader runs): a `W×1` x-profile and a `1×H` y-profile drawn by `geq` from per-frame edge and
//   feather expressions, replicated to the box and multiplied (`lut2`), then with the alpha (`alphaMultiply`). It
//   stays in the source chain at its place on every path, the sub-pixel one included (its edges are exact there).
// Adjustment layers apply their crops as the region after their effects (`adjustmentCropFilters`), each window
// mirrored by the flips after its crop, like the composition's `mix` step.
import {
	type Animatable,
	clipContentTime,
	cropMayFeather,
	evaluate,
	isAnimated,
	mirrorCropInsets,
	type Rational,
	type RenderVisualClip,
} from '@jasper/project';
import {
	alphaMultiply,
	CROP_EDGES,
	cropMaskFilter,
	FIT_TOLERANCE,
	fitPieces,
	frameIndex,
	num,
	piecewiseExpr,
} from './keyframed.ts';

type ClipEffect = RenderVisualClip['effects'][number];

const CROP = 'jasper.crop';
const FLIP_H = 'jasper.flip-horizontal';
const FLIP_V = 'jasper.flip-vertical';
const FEATHER_MAX = 1000;

const rate = (r: Rational) => `${r.num}/${r.den}`;

/** True when the crop instance takes the feathered path (its Edge Feather may be above 0 on some frame). */
export function isFeatheredCrop(fx: Pick<ClipEffect, 'effectId' | 'enabled' | 'params'>): boolean {
	return fx.enabled && fx.effectId === CROP && cropMayFeather(fx.params);
}

/** The flips after stack index `index` (enabled ones, odd counts): a crop there has its window mirrored. */
export function flipsAfter(effects: readonly ClipEffect[], index: number): { h: boolean; v: boolean } {
	let h = false;
	let v = false;
	for (let j = index + 1; j < effects.length; j++) {
		const e = effects[j]!;
		if (!e.enabled) continue;
		if (e.effectId === FLIP_H) h = !h;
		else if (e.effectId === FLIP_V) v = !v;
	}
	return { h, v };
}

/** A crop instance with its edge params swapped by a mirror (keyframes and expressions travel with their edge). */
export function mirroredCrop(fx: ClipEffect, h: boolean, v: boolean): ClipEffect {
	if (!h && !v) return fx;
	const p = { ...fx.params };
	if (h) [p.left, p.right] = [fx.params.right, fx.params.left] as [Animatable<never>, Animatable<never>];
	if (v) [p.top, p.bottom] = [fx.params.bottom, fx.params.top] as [Animatable<never>, Animatable<never>];
	for (const k of ['left', 'right', 'top', 'bottom'] as const) if (p[k] === undefined) delete p[k];
	return { ...fx, params: p };
}

/** Per-frame samples of a crop's edges (px of the `bw × bh` box, after `mirror`) and feather (px), frames [f0, f1). */
function sampleCrop(
	c: RenderVisualClip,
	fx: ClipEffect,
	o: { f0: number; f1: number; fps: Rational; bw: number; bh: number; mirror?: { h: boolean; v: boolean } },
): { x0: Float64Array; x1: Float64Array; y0: Float64Array; y1: Float64Array; f: Float64Array } {
	const n = o.f1 - o.f0;
	const s = {
		x0: new Float64Array(n),
		x1: new Float64Array(n),
		y0: new Float64Array(n),
		y1: new Float64Array(n),
		f: new Float64Array(n),
	};
	const val = (a: unknown, t: number) => {
		const v = a ? Number(evaluate(a as Animatable<number>, t)) : 0;
		return Number.isFinite(v) ? v : 0;
	};
	for (let k = 0; k < n; k++) {
		const t = clipContentTime(c, o.f0 + k, o.fps);
		const ins = CROP_EDGES.map((e) => Math.min(100, Math.max(0, val(fx.params[e], t))) / 100) as [
			number,
			number,
			number,
			number,
		];
		const [l, tp, r, b] = mirrorCropInsets(ins, !!o.mirror?.h, !!o.mirror?.v);
		s.x0[k] = l * o.bw;
		s.x1[k] = (1 - r) * o.bw;
		s.y0[k] = tp * o.bh;
		s.y1[k] = (1 - b) * o.bh;
		s.f[k] = Math.min(FEATHER_MAX, Math.max(0, val(fx.params.feather, t)));
	}
	return s;
}

/**
 * `geq` expression of one axis's coverage at pixel `P` (X or Y): `cropEdgeCoverage(P + ½ − e0, f) ·
 * cropEdgeCoverage(e1 − P − ½, f)` with e0, e1, f per frame (registers 1–3; 0 is the piecewise index, 4 the ramp).
 */
export function axisCoverageExpr(P: 'X' | 'Y', e0: string, e1: string, f: string): string {
	const ramp = (t: string) =>
		`(st(4,${t});if(lte(ld(4),0),0,if(gte(ld(4),ld(3)),ld(4)-ld(3)/2,ld(4)*ld(4)/(2*ld(3)))))`;
	const edge = (d: string) => `clip(${ramp(`${d}+0.5`)}-${ramp(`${d}-0.5`)},0,1)`;
	return `st(3,${f});st(1,${e0});st(2,${e1});${edge(`${P}+0.5-ld(1)`)}*${edge(`ld(2)-${P}-0.5`)}`;
}

/**
 * A feathered crop as one element of a comma-joined chain (RGBA in, RGBA out, `bw × bh`): the alpha × the Edge
 * Feather profile at its per-frame edges (see the file comment). `mirror`: the window mirrored by later flips
 * (adjustment-layer regions).
 */
export function cropFeatherFilter(o: {
	clip: RenderVisualClip;
	effect: ClipEffect;
	f0: number;
	f1: number;
	fps: Rational;
	bw: number;
	bh: number;
	label: string;
	mirror?: { h: boolean; v: boolean };
}): string {
	const { fps, bw, bh, label } = o;
	const n = Math.max(1, o.f1 - o.f0);
	const s = sampleCrop(o.clip, o.effect, { ...o, f1: o.f0 + n });
	const T = frameIndex(fps, 0, false, 'T');
	const expr = (v: Float64Array, tol: number) => piecewiseExpr(fitPieces(v, tol), T);
	// Edges within 0.01 px and feather within 0.01 px of the samples (coverage error < 0.01 / pixel).
	const tol = Math.min(FIT_TOLERANCE.px, 0.01);
	const ex = axisCoverageExpr('X', expr(s.x0, tol), expr(s.x1, tol), expr(s.f, tol));
	const ey = axisCoverageExpr('Y', expr(s.y0, tol), expr(s.y1, tol), expr(s.f, tol));
	const src = (w: number, h: number) =>
		`color=c=white:s=${w}x${h}:r=${rate(fps)}:d=${num(((n + 1) * fps.den) / fps.num)},format=gray,trim=end_frame=${n}`;
	const lum = (e: string) => `geq=lum='clip(round(255*(${e})),0,255)'`;
	const factor =
		`${src(bw, 1)},${lum(ex)},scale=${bw}:${bh}:flags=neighbor[${label}fx];` +
		`${src(1, bh)},${lum(ey)},scale=${bw}:${bh}:flags=neighbor[${label}fy];` +
		`[${label}fx][${label}fy]lut2=c0='floor(x*y/255+0.5)'`;
	return alphaMultiply(`${label}m`, factor);
}

/**
 * The chain element of a hard crop at its stack position (`null` when it cuts nothing): `crop`+`pad` at whole pixels,
 * or the per-frame rectangle mask for keyframed edges.
 */
export function hardCropFilter(o: {
	clip: RenderVisualClip;
	effect: ClipEffect;
	params: Readonly<Record<string, unknown>>;
	f0: number;
	f1: number;
	fps: Rational;
	bw: number;
	bh: number;
	label: string;
}): string | null {
	const { effect: applied, bw, bh } = o;
	if (o.f1 - o.f0 > 1 && CROP_EDGES.some((e) => isAnimated(applied.params[e])))
		return cropMaskFilter({
			clip: o.clip,
			effect: applied,
			f0: o.f0,
			f1: o.f1,
			fps: o.fps,
			bw,
			bh,
			label: o.label,
		});
	const v = (k: string) => Number(o.params[k] ?? 0);
	const l = Math.round((v('left') / 100) * bw);
	const r = Math.round((v('right') / 100) * bw);
	const t = Math.round((v('top') / 100) * bh);
	const b = Math.round((v('bottom') / 100) * bh);
	if (!l && !r && !t && !b) return null;
	const cw = Math.max(1, bw - l - r);
	const ch = Math.max(1, bh - t - b);
	return `crop=${cw}:${ch}:${l}:${t},pad=${bw}:${bh}:${l}:${t}:color=black@0`;
}

/**
 * edit-structure × crop-order: an adjustment layer's crops as the region after its effects — every enabled crop, its
 * window mirrored by the flips after it (they all commute with the native adjustment effects: colour, flips), hard
 * ones cut, feathered ones fade the region in (the composition's `mix` region, AdjustmentScope.tsx).
 */
export function adjustmentCropFilters(o: {
	clip: RenderVisualClip;
	f0: number;
	f1: number;
	fps: Rational;
	bw: number;
	bh: number;
	label: string;
	/** Evaluated params at `f0` by stack index (static crops). */
	paramsAt: (index: number) => Readonly<Record<string, unknown>>;
}): string[] {
	const out: string[] = [];
	o.clip.effects.forEach((fx, index) => {
		if (!fx.enabled || fx.effectId !== CROP) return;
		const m = flipsAfter(o.clip.effects, index);
		const label = `${o.label}cr${index}`;
		if (isFeatheredCrop(fx)) {
			out.push(cropFeatherFilter({ ...o, effect: fx, label, mirror: m }));
			return;
		}
		const mirrored = mirroredCrop(fx, m.h, m.v);
		const p = o.paramsAt(index);
		const params =
			m.h || m.v
				? {
						...p,
						...(m.h ? { left: p.right, right: p.left } : {}),
						...(m.v ? { top: p.bottom, bottom: p.top } : {}),
					}
				: p;
		const f = hardCropFilter({ ...o, effect: mirrored, params, label });
		if (f) out.push(f);
	});
	return out;
}
