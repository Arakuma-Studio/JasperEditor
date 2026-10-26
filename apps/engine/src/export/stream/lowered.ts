// spec 13 AS-070 / AS-073 — lowered layers: a DOM layer whose content is static but whose picture moves (keyframed
// Motion / Opacity, the Transform effect with or without its Shutter Angle motion blur, S_Shake without motion blur
// or RGB split) is baked ONCE as a still of its layer box (`layer-bake`, recipe `layer-still`) and drawn here frame by
// frame as affine maps of that still, by the multi-tap kernel (kernel.ts `drawTaps`).
//
// The taps (Transform, S_Shake, their coverage stages) come from `loweredLayerTaps` (@jasper/project), shared with the
// Program preview's 2D canvas path; this module adds Motion⁻¹, the still's mip levels and the drawn rectangles.
// Differences to the browser's render (documented in docs/wp-notes/auto-subtitles.md): one resample instead of one
// per GPU pass plus the compositor's, the per-pixel jitter of capped shutters is the stratum centre, and the stage
// edges are ½ px ramps instead of the Transform's hard box test.
import {
	type Affine6 as Affine,
	clipContentTime,
	composeAffine as compose,
	defaultEffectRegistry,
	type EffectRegistry,
	invertAffine,
	isLoweredLayer,
	loweredLayerTaps,
	loweredMoves,
	loweredRefusal,
	type Rational,
	type RenderVisualClip,
	resolveLayerProps,
} from '@jasper/project';

export { type Affine, invertAffine, isLoweredLayer, loweredMoves, loweredRefusal };

/** The region of the layer (layer px) the still covers: the box grown by the content bleed, whole pixels. */
export type LoweredPicture = { x: number; y: number; w: number; h: number };

/** One output frame of a kernel-drawn member, in sequence pixels. */
export type TapFrame = {
	/** Drawn rectangle `[x0, y0, x1)` (sequence px, integers), null = nothing drawn. */
	rect: [number, number, number, number] | null;
	opacity: number;
	/** Picture (mip level) the taps sample. */
	level: number;
	/** `drawTaps` program with maps from sequence px to the level's picture px. */
	prog: number[];
};

/** A frame program of one tap without stages (what `drawLayer` draws). */
export function singleTap(inv: Affine, clip: readonly number[], weight = 1): number[] {
	return [1, weight, weight, ...inv, clip[0]!, clip[1]!, clip[2]!, clip[3]!, 0];
}

/** Translates a program's maps: output px → output px + (dx, dy) (a frame drawn into a larger canvas at an offset). */
export function shiftProgram(prog: readonly number[], dx: number, dy: number): number[] {
	const out = prog.slice();
	const n = out[0]! | 0;
	let p = 2;
	const shift = (q: number) => {
		// u(x + dx, y + dy) = m0·x + m1·y + (m0·dx + m1·dy + m2)
		out[q + 2] = out[q]! * dx + out[q + 1]! * dy + out[q + 2]!;
		out[q + 5] = out[q + 3]! * dx + out[q + 4]! * dy + out[q + 5]!;
	};
	for (let t = 0; t < n; t++) {
		// A tap: w, map (6), clip (4), nStages, then nStages × (map (6), rect (4)).
		shift(p + 1);
		p += 12;
		const ns = out[p - 1]! | 0;
		for (let s = 0; s < ns; s++) shift(p + s * 10);
		p += ns * 10;
	}
	return out;
}

type Stage = { map: Affine; rect: [number, number, number, number] };
type Tap = { w: number; map: Affine; stages: Stage[] };

const mipLevel = (s: number) => (s >= 0.5 || s <= 0 ? 0 : Math.min(12, Math.floor(Math.log2(1 / s) + 1e-9)));

/**
 * The frame programs of a lowered layer over `[f0, f1)`: Motion (layer map), the lowered effects in stack order and
 * the picture (`picture`, layer px; its mip levels follow the Motion scale like the sub-pixel kernel's). The layer
 * box is the clip's resolved box; the still is `picture.w × picture.h` px at 1 px per layer px.
 */
export function planLoweredFrames(o: {
	clip: RenderVisualClip;
	f0: number;
	f1: number;
	fps: Rational;
	picture: LoweredPicture;
	W: number;
	H: number;
	registry?: EffectRegistry;
}): { frames: TapFrame[]; levels: { w: number; h: number }[] } {
	const { clip: c, picture: pic } = o;
	const registry = o.registry ?? defaultEffectRegistry;
	const fpsN = o.fps.num / o.fps.den;
	const paramsAt = new Map();
	const levels: { w: number; h: number }[] = [];
	const levelIndex = new Map<number, number>();
	const levelOf = (L: number) => {
		let i = levelIndex.get(L);
		if (i === undefined) {
			i = levels.length;
			levelIndex.set(L, i);
			levels.push({ w: Math.max(1, Math.round(pic.w / 2 ** L)), h: Math.max(1, Math.round(pic.h / 2 ** L)) });
		}
		return i;
	};
	const frames: TapFrame[] = [];
	for (let f = o.f0; f < o.f1; f++) {
		const t = clipContentTime(c, f, o.fps);
		const props = resolveLayerProps(c, t);
		const m = props.matrix;
		const motion = invertAffine([m.a, m.c, m.e, m.b, m.d, m.f]);
		const opacity = Math.min(1, Math.max(0, props.opacity / 100));
		if (!motion || !(opacity > 0)) {
			frames.push({ rect: null, opacity: 0, level: levelOf(0), prog: [0, 1] });
			continue;
		}
		// The layer-space taps (Transform, S_Shake, the effect canvas) after Motion⁻¹: sequence px → source layer px.
		const lt = loweredLayerTaps({ clip: c, props, frame: f, fps: fpsN, registry, paramsAtCache: paramsAt });
		const taps = lt.taps.map((t) => ({
			w: t.w,
			map: compose(t.map, motion),
			stages: t.stages.map((st) => ({ map: compose(st.map, motion), rect: st.rect })),
		}));
		const wsum = lt.wsum;
		// Mip level from the Motion scale (layer px → sequence px), as the sub-pixel kernel picks it.
		const sx = Math.hypot(m.a, m.b);
		const sy = Math.hypot(m.c, m.d);
		const L = Math.min(mipLevel(sx), mipLevel(sy));
		const li = levelOf(L);
		const lv = levels[li]!;
		const kx = lv.w / pic.w;
		const ky = lv.h / pic.h;
		const toPicture: Affine = [kx, 0, -pic.x * kx, 0, ky, -pic.y * ky];
		const prog: number[] = [taps.length, wsum];
		let x0 = Number.POSITIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (const tap of taps) {
			const map = compose(toPicture, tap.map);
			prog.push(tap.w, ...map, 0, 0, lv.w, lv.h, tap.stages.length);
			for (const s of tap.stages) prog.push(...s.map, ...s.rect);
			// Bounds: the picture through the inverse of the tap's map.
			const fwd = invertAffine(map);
			if (!fwd) continue;
			for (const [u, v] of [
				[0, 0],
				[lv.w, 0],
				[lv.w, lv.h],
				[0, lv.h],
			] as const) {
				const x = fwd[0] * u + fwd[1] * v + fwd[2];
				const y = fwd[3] * u + fwd[4] * v + fwd[5];
				x0 = Math.min(x0, x);
				y0 = Math.min(y0, y);
				x1 = Math.max(x1, x);
				y1 = Math.max(y1, y);
			}
		}
		const rx0 = Math.max(0, Math.floor(x0) - 1);
		const ry0 = Math.max(0, Math.floor(y0) - 1);
		const rx1 = Math.min(o.W, Math.ceil(x1) + 1);
		const ry1 = Math.min(o.H, Math.ceil(y1) + 1);
		const visible = Number.isFinite(x0) && rx1 > rx0 && ry1 > ry0 && taps.length > 0;
		frames.push(
			visible
				? { rect: [rx0, ry0, rx1, ry1], opacity, level: li, prog }
				: { rect: null, opacity: 0, level: li, prog: [0, 1] },
		);
	}
	return { frames, levels };
}

