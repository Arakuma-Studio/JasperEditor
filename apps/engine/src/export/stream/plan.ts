// Sub-pixel layers of the native export (wave1b native-subpixel, S03:DM-010/012, ENG-032, ARCHITECTURE D-34).
// FFmpeg's LGPL filters place and size pictures in whole pixels only (`overlay`, `pad`, `crop` take integers; `scale`
// makes integer sizes; `perspective` is GPL), which steps slow moves by 1 px. A layer whose Motion is keyframed or
// lands between pixels is therefore drawn by our warp kernel (the same bilinear, premultiplied, pixel-centre sampler
// the warp stage uses, S09:TRK-033) into a small frame around the layer, streamed to the composite as raw RGBA on a
// pipe and overlaid at a whole-pixel offset: the fraction is in the warped pixels, so the motion is exact.
//
// Per layer:
// - a decoder ffmpeg runs the layer's source chain (`layerSourceChain`: seek, speed, box scale, effects incl.
//   keyframed crop masks), pre-scaled where the layer is drawn smaller than its box, to the next ⅛-octave level at
//   or above the drawn size (the kernel then minifies by < 9 %: no aliasing; levels change rarely during a zoom, so
//   the scaler is rarely re-created);
// - every frame: `resolveLayerProps` (shared evaluator, KF-010) → layer map → the inverse map from the output frame
//   to the decoded picture, the drawn rectangle and the opacity; the kernel (kernel.ts) anti-aliases the picture's
//   edges by coverage, like a browser draws a transformed layer box;
// - the output frame is the layer's bounds over the whole clip in size, placed per frame at an integer offset
//   from a piecewise-linear fit (`overlay` x/y expressions; offsets recomputed from the fit so JS and ffmpeg agree).
import {
	type Animatable,
	activeMasks,
	clipContentTime,
	evaluate,
	invertMat3,
	type Mat3,
	multiplyMat3,
	type Rational,
	type RenderVisualClip,
	type ResolvedLayerProps,
	type ResolvedMask,
	resolveLayerProps,
} from '@jasper/project';
import { FIT_TOLERANCE, fitPieces, frameIndex, pieceValue, piecewiseExpr, roundC } from '../keyframed.ts';

/** A layer drawn by the warp kernel and streamed to the composite. */
export type StreamLayerPlan = {
	/** Decoder: ffmpeg inputs and filtergraph (output: `srcW×srcH` RGBA frames). */
	inputs: string[][];
	filter: string;
	srcW: number;
	srcH: number;
	/** Streamed frame size. */
	outW: number;
	outH: number;
	fps: Rational;
	/** One per layer frame (`inv`: output px → decoded px). */
	frames: StreamFrame[];
	/** `overlay` offset expressions (export time) and their per-frame values. */
	x: string;
	y: string;
	offsets: { x: number[]; y: number[] };
};

/** One output frame: output px → picture px (affine 2×3, null = transparent), drawn rect, opacity, picture size. */
export type StreamFrame = {
	inv: number[] | null;
	rect: [number, number, number, number] | null;
	opacity: number;
	cw: number;
	ch: number;
	/** Visible part of the picture (crop, S01:FX-003), picture px `[u0, v0, u1, v1]`. */
	clip: [number, number, number, number];
	/**
	 * wp masks: the layer's Opacity masks at this frame — the kernel multiplies the decoded picture by their coverage
	 * (rasterised at the picture's `cw×ch` size, `pxScale` picture px per layer px) before the warp, as the
	 * composition multiplies the layer canvas before its transform. `key` identifies the coverage (cache).
	 */
	mask?: { key: string; masks: ResolvedMask[]; pxScale: number } | null;
};

const CROP = 'jasper.crop';
const CROP_EDGES = ['left', 'top', 'right', 'bottom'] as const;

/** The crop as fractions of the box at content time `t` (`[l, t, r, b]`), or null without an enabled crop. */
function cropAt(c: RenderVisualClip, t: number): [number, number, number, number] | null {
	const fx = c.effects.find((e) => e.enabled && e.effectId === CROP);
	if (!fx) return null;
	const v = CROP_EDGES.map((e) => {
		const a = fx.params[e] as Animatable<number> | undefined;
		return Math.min(100, Math.max(0, a ? Number(evaluate(a, t)) : 0)) / 100;
	}) as [number, number, number, number];
	// The composition crops first, then flips (S03:RND-010 stage order): an odd number of flips mirrors the crop.
	const flips = (id: string) => c.effects.filter((e) => e.enabled && e.effectId === id).length % 2 === 1;
	if (flips('jasper.flip-horizontal')) [v[0], v[2]] = [v[2], v[0]];
	if (flips('jasper.flip-vertical')) [v[1], v[3]] = [v[3], v[1]];
	return v;
}

/**
 * Pre-scale level (octaves) of a drawn scale, like a mipmap: the largest power-of-two reduction whose size is still
 * at least the drawn one, so the kernel minifies by less than 2× (from the full picture down to half size, as the
 * browser samples it).
 */
const level = (s: number) => (s >= 0.5 || s <= 0 ? 0 : Math.min(12, Math.floor(Math.log2(1 / s) + 1e-9)));
const isInt = (x: number) => Math.abs(x - Math.round(x)) < 1e-6;

/**
 * True when a layer must be drawn sub-pixel: keyframed Motion, or a static Motion whose scaled size, quarter-turn
 * rotation or position is not whole pixels (the filter path rounds those).
 */
export function needsSubpixel(
	c: RenderVisualClip,
	props: ResolvedLayerProps,
	box: { bw: number; bh: number },
): boolean {
	const t = c.transform;
	if (!t) return false;
	if (
		t.position.keyframes.length > 0 ||
		t.anchor.keyframes.length > 0 ||
		t.scale.keyframes.length > 0 ||
		t.scaleWidth.keyframes.length > 0 ||
		t.rotation.keyframes.length > 0
	)
		return true;
	// A crop with keyframes, or with edges between pixels (the filter path rounds them).
	const crop = c.effects.find((e) => e.enabled && e.effectId === CROP);
	if (crop) {
		const anims = CROP_EDGES.map((e) => crop.params[e] as Animatable<number> | undefined);
		if (anims.some((a) => a && a.keyframes.length > 0)) return true;
		const [l, tp, r, b] = anims.map((a) => (a ? Number(a.value) : 0) / 100);
		if (![l! * box.bw, r! * box.bw, tp! * box.bh, b! * box.bh].every(isInt)) return true;
	}
	const tv = props.transform!;
	const sx = (tv.uniformScale ? tv.scale : tv.scaleWidth) / 100;
	const sy = tv.scale / 100;
	const w = Math.abs(sx) * box.bw;
	const h = Math.abs(sy) * box.bh;
	if (!isInt(c.intrinsicBox.width) || !isInt(c.intrinsicBox.height) || !isInt(w) || !isInt(h)) return true;
	const deg = (((tv.rotation % 360) + 540) % 360) - 180;
	const quarter = [0, 90, -90, 180, -180].some((q) => Math.abs(deg - q) < 1e-9);
	if (!quarter) return true;
	const turned = Math.abs(Math.abs(deg) - 90) < 1e-9;
	const m = props.matrix;
	const cx = m.a * (box.bw / 2) + m.c * (box.bh / 2) + m.e;
	const cy = m.b * (box.bw / 2) + m.d * (box.bh / 2) + m.f;
	return !isInt(cx - (turned ? h : w) / 2) || !isInt(cy - (turned ? w : h) / 2);
}

export type StreamPlanOptions = {
	clip: RenderVisualClip;
	f0: number;
	f1: number;
	R0: number;
	fps: Rational;
	props: ResolvedLayerProps;
	/** The layer's source chain (decoded box size `bw×bh`), as built by `layerSourceChain` for the decoder. */
	chain: {
		input: string;
		filters: string[];
		width: number;
		height: number;
		resize: { index: number; options: string } | null;
	};
	inputs: string[][];
	W: number;
	H: number;
};

/** Plans the streamed drawing of a layer over `[f0, f1)`. */
export function planStreamLayer(o: StreamPlanOptions): StreamLayerPlan {
	const { clip: c, f0, f1, fps, chain } = o;
	const n = f1 - f0;
	const bw = chain.width;
	const bh = chain.height;
	// Decoded px → layer px (the chain delivers the rounded intrinsic box).
	const kx = c.intrinsicBox.width / bw;
	const ky = c.intrinsicBox.height / bh;

	// ---- samples: layer map, mip levels, opacity
	const maps: (Mat3 | null)[] = [];
	const opac = new Float64Array(n);
	const crops: ([number, number, number, number] | null)[] = [];
	const masksAt: ResolvedMask[][] = [];
	const lw = new Float64Array(n);
	const lh = new Float64Array(n);
	for (let k = 0; k < n; k++) {
		const time = clipContentTime(c, f0 + k, fps);
		const p = k === 0 ? o.props : resolveLayerProps(c, time);
		crops.push(cropAt(c, time));
		masksAt.push(activeMasks(p.masks));
		const m = p.matrix;
		const sx = Math.hypot(m.a, m.b) * kx;
		const sy = Math.hypot(m.c, m.d) * ky;
		lw[k] = level(sx);
		lh[k] = level(sy);
		const visible = sx > 1e-9 && sy > 1e-9 && p.opacity > 0;
		opac[k] = visible ? p.opacity / 100 : 0;
		maps.push(visible ? [m.a * kx, m.c * ky, m.e, m.b * kx, m.d * ky, m.f, 0, 0, 1] : null);
	}
	const pw = Array.from(lw, (l) => Math.max(1, Math.round(bw / 2 ** l)));
	const ph = Array.from(lh, (l) => Math.max(1, Math.round(bh / 2 ** l)));
	const srcW = Math.max(...pw);
	const srcH = Math.max(...ph);
	const levels = pw.some((v, k) => v !== bw || ph[k] !== bh);

	// ---- decoder: source chain → mip size (per frame, piecewise constant) → fixed frame (top-left)
	const filters = [...chain.filters];
	if (levels) {
		const T = frameIndex(fps);
		const sizeExpr = (v: number[]) =>
			v.every((x) => x === v[0]) ? String(v[0]) : `'round(${piecewiseExpr(fitPieces(v, 0.01), T)})'`;
		const perFrame = !pw.every((v) => v === pw[0]) || !ph.every((v) => v === ph[0]);
		const size = perFrame ? `w=${sizeExpr(pw)}:h=${sizeExpr(ph)}:eval=frame` : `${pw[0]}:${ph[0]}`;
		if (chain.resize) filters.splice(chain.resize.index, 1, `scale=${size}${chain.resize.options}`);
		else filters.push(`scale=${size}:flags=bicubic`, 'format=rgba');
		if (perFrame) filters.push(`pad=w=${srcW}:h=${srcH}:x=0:y=0:color=black@0:eval=frame`);
	}
	const filter = `${chain.input}${filters.join(',')}`;

	// ---- per frame: map from decoded px to sequence px, its bounds (real, clamped to the frame ± 2 px)
	const fwd: (Mat3 | null)[] = [];
	const x0 = new Float64Array(n);
	const y0 = new Float64Array(n);
	const x1 = new Float64Array(n);
	const y1 = new Float64Array(n);
	const clips: [number, number, number, number][] = [];
	for (let k = 0; k < n; k++) {
		const cr = crops[k] ?? [0, 0, 0, 0];
		const clipRect: [number, number, number, number] = [
			cr[0] * pw[k]!,
			cr[1] * ph[k]!,
			(1 - cr[2]) * pw[k]!,
			(1 - cr[3]) * ph[k]!,
		];
		clips.push(clipRect);
		const map = clipRect[2] > clipRect[0] && clipRect[3] > clipRect[1] ? maps[k] : null;
		if (!map) {
			fwd.push(null);
			x0[k] = Number.NaN;
			continue;
		}
		// Decoded (mip) px → box px → sequence px.
		const f = multiplyMat3(map, [bw / pw[k]!, 0, 0, 0, bh / ph[k]!, 0, 0, 0, 1]);
		fwd.push(f);
		let ax = Number.POSITIVE_INFINITY;
		let ay = Number.POSITIVE_INFINITY;
		let bx = Number.NEGATIVE_INFINITY;
		let by = Number.NEGATIVE_INFINITY;
		for (const [u, v] of [
			[clipRect[0], clipRect[1]],
			[clipRect[2], clipRect[1]],
			[clipRect[2], clipRect[3]],
			[clipRect[0], clipRect[3]],
		] as const) {
			const x = f[0] * u + f[1] * v + f[2];
			const y = f[3] * u + f[4] * v + f[5];
			ax = Math.min(ax, x);
			ay = Math.min(ay, y);
			bx = Math.max(bx, x);
			by = Math.max(by, y);
		}
		x0[k] = Math.min(Math.max(ax, -2), o.W);
		y0[k] = Math.min(Math.max(ay, -2), o.H);
		x1[k] = Math.max(Math.min(bx, o.W + 2), x0[k]!);
		y1[k] = Math.max(Math.min(by, o.H + 2), y0[k]!);
	}
	// Invisible frames take the bounds of the nearest visible one (keeps the offset fit smooth).
	const first = fwd.findIndex((f) => f !== null);
	for (let k = 0; k < n; k++) {
		if (fwd[k]) continue;
		const j = first < 0 ? -1 : k < first ? first : k - 1;
		if (j < 0) [x0[k], y0[k], x1[k], y1[k]] = [0, 0, 1, 1];
		else [x0[k], y0[k], x1[k], y1[k]] = [x0[j]!, y0[j]!, x1[j]!, y1[j]!];
	}

	// ---- the frame's offset: round(fit(left − 2)), ≥ 1.4 px left of the drawing (bilinear fringe: 1 px)
	const offsets = (lo: Float64Array) => {
		const v = lo.map((x) => x - 2);
		for (let nudge = 0; ; nudge++) {
			const pieces = fitPieces(
				v.map((x) => x + nudge * 0.0013),
				FIT_TOLERANCE.px,
			);
			const at = Array.from({ length: n }, (_, k) => pieceValue(pieces, k));
			// JS and ffmpeg must round alike: no value may sit on a .5 tie.
			if (nudge < 20 && at.some((x) => Math.abs(Math.abs(x % 1) - 0.5) < 1e-6)) continue;
			return { pieces, ints: at.map(roundC) };
		}
	};
	const ox = offsets(x0);
	const oy = offsets(y0);
	let outW = 1;
	let outH = 1;
	for (let k = 0; k < n; k++) {
		outW = Math.max(outW, Math.ceil(x1[k]! + 1) - ox.ints[k]!);
		outH = Math.max(outH, Math.ceil(y1[k]! + 1) - oy.ints[k]!);
	}

	// ---- per-frame warp specs (output px → decoded px)
	const frames: StreamFrame[] = [];
	let lastMask: StreamFrame['mask'] = null;
	const maskOf = (k: number): StreamFrame['mask'] => {
		const ms = masksAt[k]!;
		if (ms.length === 0) return null;
		const pxScale = pw[k]! / Math.max(1e-9, c.intrinsicBox.width);
		const key = `${pw[k]}x${ph[k]}|${pxScale}|${JSON.stringify(ms)}`;
		// Equal geometry across frames shares one object (one rasterisation, see run.ts).
		if (lastMask?.key === key) return lastMask;
		lastMask = { key, masks: ms, pxScale };
		return lastMask;
	};
	for (let k = 0; k < n; k++) {
		const f = fwd[k];
		if (!f || !(opac[k]! > 0)) {
			frames.push({ inv: null, rect: null, opacity: 0, cw: pw[k]!, ch: ph[k]!, clip: clips[k]! });
			continue;
		}
		const X = ox.ints[k]!;
		const Y = oy.ints[k]!;
		const local: Mat3 = [f[0], f[1], f[2] - X, f[3], f[4], f[5] - Y, 0, 0, 1];
		const inv = invertMat3(local);
		const rect: [number, number, number, number] = [
			Math.max(0, Math.floor(x0[k]! - X) - 1),
			Math.max(0, Math.floor(y0[k]! - Y) - 1),
			Math.min(outW, Math.ceil(x1[k]! - X) + 1),
			Math.min(outH, Math.ceil(y1[k]! - Y) + 1),
		];
		frames.push(
			inv && rect[2] > rect[0] && rect[3] > rect[1]
				? {
						inv: Array.from(inv).slice(0, 6),
						rect,
						opacity: opac[k]!,
						cw: pw[k]!,
						ch: ph[k]!,
						clip: clips[k]!,
						mask: maskOf(k),
					}
				: { inv: null, rect: null, opacity: 0, cw: pw[k]!, ch: ph[k]!, clip: clips[k]! },
		);
	}
	const mainT = frameIndex(fps, f0 - o.R0);
	const pos = (p: { pieces: ReturnType<typeof fitPieces>; ints: number[] }) =>
		p.ints.every((v) => v === p.ints[0]) ? String(p.ints[0]) : `'round(${piecewiseExpr(p.pieces, mainT)})'`;
	return {
		inputs: o.inputs,
		filter,
		srcW: levels ? srcW : bw,
		srcH: levels ? srcH : bh,
		outW,
		outH,
		fps,
		frames,
		x: pos(ox),
		y: pos(oy),
		offsets: { x: ox.ints, y: oy.ints },
	};
}
