// Crop in the effect stack (S01:FX-002/003, schema v8, docs/wp-notes/crop-order.md). Crop applies where it sits in
// the stack, like every standard effect in Premiere; every renderer (Player, Remotion, the native builder and its
// sub-pixel kernel, adjustment layers, overlays) shares the geometry and the Edge Feather profile defined here.
//
// Edge Feather profile (work note §2): each crop edge multiplies the picture's alpha by a linear ramp that is 0 on
// the edge and 1 at `feather` layer pixels inside it; a pixel takes the ramp's average over its square (box filter),
// so `feather = 0` is the exact area coverage of a hard edge and the profile is continuous in `feather`. The four
// edges multiply. Feather is in layer pixels (the clip's intrinsic box: Premiere applies standard effects before
// Motion), so it scales with Motion Scale.

/** Crop insets as fractions of the layer box: left, top, right, bottom (each 0…1). */
export type CropInsets = [number, number, number, number];

/** Largest Edge Feather (px), the registry's range. */
export const CROP_FEATHER_MAX = 1000;

/** The Crop effect id (`CROP_EFFECT.id`; no registry import here, which would make a module cycle). */
const CROP_ID = 'jasper.crop';
const FLIP_H = 'jasper.flip-horizontal';
const FLIP_V = 'jasper.flip-vertical';

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The insets of evaluated crop params (percent, clamped to 0…100) as fractions. */
export function cropInsets(params: Readonly<Record<string, unknown>>): CropInsets {
	const f = (k: string) => Math.min(100, Math.max(0, finite(params[k]))) / 100;
	return [f('left'), f('top'), f('right'), f('bottom')];
}

/** The Edge Feather of evaluated crop params in layer pixels (0…1000; nonfinite = 0). */
export function cropFeather(params: Readonly<Record<string, unknown>>): number {
	return Math.min(CROP_FEATHER_MAX, Math.max(0, finite(params.feather)));
}

/**
 * True when a crop's Edge Feather is (or may become) non-zero: an evaluated value > 0, or an Animatable whose value
 * or any keyframe is > 0, or that has an enabled expression. Renderers that cannot vary their crop path per frame
 * take the feathered path for the whole clip (at feather 0 it yields the hard edge's area coverage).
 */
export function cropMayFeather(params: Readonly<Record<string, unknown>>): boolean {
	const v = params.feather;
	if (typeof v === 'number') return Number.isFinite(v) && v > 0;
	if (!v || typeof v !== 'object') return false;
	const a = v as { value?: unknown; keyframes?: { value?: unknown }[]; expression?: { enabled?: boolean } };
	if (finite(a.value) > 0) return true;
	if (a.expression?.enabled) return true;
	return (a.keyframes ?? []).some((k) => finite(k.value) > 0);
}

/** Integral of the feather ramp `clamp(u / f, 0, 1)` from −∞ to `t` (f = 0: the step's integral max(t, 0)). */
function rampIntegral(t: number, f: number): number {
	if (t <= 0) return 0;
	if (t >= f) return t - f / 2;
	return (t * t) / (2 * f);
}

/**
 * Coverage of one crop edge for the pixel whose centre lies `d` pixels inside the edge (negative: outside), with a
 * feather of `f` pixels: the ramp's average over the pixel `[d − ½, d + ½]`. The same formula runs in the preview
 * shader (`CROP_FEATHER_GPU`) and the native mask (`cropFeatherMask`).
 */
export function cropEdgeCoverage(d: number, f: number): number {
	const ff = Math.max(0, f);
	return Math.min(1, Math.max(0, rampIntegral(d + 0.5, ff) - rampIntegral(d - 0.5, ff)));
}

/**
 * Alpha factor of a crop for the pixel centred at `(x, y)` of a `w × h` box (any pixel unit; `feather` in the same
 * unit): the product of the four edge coverages.
 */
export function cropCoverageAt(
	x: number,
	y: number,
	w: number,
	h: number,
	insets: Readonly<CropInsets>,
	feather: number,
): number {
	const [l, t, r, b] = insets;
	return (
		cropEdgeCoverage(x - l * w, feather) *
		cropEdgeCoverage((1 - r) * w - x, feather) *
		cropEdgeCoverage(y - t * h, feather) *
		cropEdgeCoverage((1 - b) * h - y, feather)
	);
}

/** Insets mirrored by a horizontal and/or vertical flip of the box (a flip after the crop mirrors its window). */
export function mirrorCropInsets(
	insets: Readonly<CropInsets>,
	horizontal: boolean,
	vertical: boolean,
): CropInsets {
	const [l, t, r, b] = insets;
	return [horizontal ? r : l, vertical ? b : t, horizontal ? l : r, vertical ? t : b];
}

type StackEffect = { effectId: string; enabled: boolean; params: Readonly<Record<string, unknown>> };

/** One enabled crop of a stack, its window mirrored by the flip effects after it (the window it leaves visible). */
export type StackCrop<E extends StackEffect = StackEffect> = {
	fx: E;
	/** Stack index of the crop. */
	index: number;
	/** The crop's insets mirrored by the flips after it (the visible window in the finished layer box). */
	insets: CropInsets;
	feather: number;
};

/**
 * The enabled crops of a stack (evaluated params) in stack order, each with its visible window: a horizontal /
 * vertical flip AFTER a crop mirrors it, one before does not (the crop then cuts the flipped picture).
 */
export function stackCrops<E extends StackEffect>(effects: readonly E[]): StackCrop<E>[] {
	const out: StackCrop<E>[] = [];
	effects.forEach((fx, index) => {
		if (!fx.enabled || fx.effectId !== CROP_ID) return;
		let h = false;
		let v = false;
		for (let j = index + 1; j < effects.length; j++) {
			const e = effects[j]!;
			if (!e.enabled) continue;
			if (e.effectId === FLIP_H) h = !h;
			else if (e.effectId === FLIP_V) v = !v;
		}
		out.push({
			fx,
			index,
			insets: mirrorCropInsets(cropInsets(fx.params), h, v),
			feather: cropFeather(fx.params),
		});
	});
	return out;
}

/** Intersection of crop windows (the largest inset per side), or null for none. */
export function intersectCropInsets(list: readonly Readonly<CropInsets>[]): CropInsets | null {
	if (list.length === 0) return null;
	const out: CropInsets = [0, 0, 0, 0];
	for (const s of list) for (let i = 0; i < 4; i++) out[i] = Math.max(out[i]!, s[i]!);
	return out;
}

/**
 * The visible window the crops of a stack leave in the layer box (percent insets, flips after a crop mirror it,
 * several crops intersect), or null without an enabled crop. Overlays, Fit/Fill and anchors use it; it is the
 * picture's extent when the only geometry effects are crops and flips (other geometric effects after a crop move
 * the window; the corner pin is the layer map, D-27).
 */
export function cropWindow(
	effects: readonly StackEffect[],
): { left: number; top: number; right: number; bottom: number } | null {
	const w = intersectCropInsets(stackCrops(effects).map((c) => c.insets));
	return w ? { left: w[0] * 100, top: w[1] * 100, right: w[2] * 100, bottom: w[3] * 100 } : null;
}

/**
 * The crop shown as the pinned "Crop" section of Properties / Effect Controls and saved as a preset's intrinsic Crop:
 * the stack's first effect when it is a crop (crop-order: a crop placed after another effect is an ordinary stack
 * effect, listed and reordered with the others, so its position is never lost).
 */
export function pinnedCropOf<E extends { effectId: string }>(effects: readonly E[] | undefined): E | null {
	const first = effects?.[0];
	return first && first.effectId === CROP_ID ? first : null;
}
