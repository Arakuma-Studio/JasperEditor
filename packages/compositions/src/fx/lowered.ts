// spec 13 AS-075 — the Program preview of lowered layers (text whose glyphs stay still while the Transform effect and
// S_Shake move it, `isLoweredLayer`): instead of the GPU chain (DOM capture → WebGL passes → read back every frame,
// the dominant cost of subtitle playback in software GL), the captured picture is drawn through the effects' own
// per-frame maps with Canvas 2D: one `drawImage` per shutter tap, clipped to each stage rectangle, summed with
// `lighter` at weight w / Σw. The maps are `loweredLayerTaps` (@jasper/project), the same the native export's kernel
// draws, so preview and export agree; renders keep the GPU chain (the reference the export is compared with).
import {
	type Affine6,
	composeAffine,
	invertAffine,
	isLoweredLayer,
	loweredLayerTaps,
	type RenderVisualClip,
	type ResolvedLayerProps,
	textContentPad,
} from '@jasper/project';
import { createEffect } from 'remotion';

export type FxLoweredParams = {
	key: string;
	/** `drawTaps` program in canvas px: `[n, wsum, …taps]`, a tap = w, map (6), clip (4), nStages, stages × 10. */
	prog: number[];
	/**
	 * The part of the captured picture that can hold paint (canvas px `[x0, y0, x1, y1]`: the box and the text's own
	 * paint, not the effects' padding, which is transparent before the effects): the only part each tap draws.
	 */
	src: [number, number, number, number];
};

/**
 * The canvas-px program of a lowered layer at a frame, or null when the layer is not lowered: the layer-space taps
 * moved into the effect canvas (`c = (q + padding) · pxScale`), stage rectangles kept in layer px.
 */
export function loweredCanvasProgram(o: {
	clip: RenderVisualClip;
	props: ResolvedLayerProps;
	/** Sequence frame. */
	frame: number;
	fps: number;
	layout: { padding: { left: number; top: number }; pxScale: number; width: number; height: number };
	paramsAtCache?: Parameters<typeof loweredLayerTaps>[0]['paramsAtCache'];
}): FxLoweredParams | null {
	if (!isLoweredLayer(o.clip)) return null;
	const lt = loweredLayerTaps({
		clip: o.clip,
		props: o.props,
		frame: o.frame,
		fps: o.fps,
		...(o.paramsAtCache ? { paramsAtCache: o.paramsAtCache } : {}),
	});
	const s = o.layout.pxScale;
	const fromLayer: Affine6 = [s, 0, s * o.layout.padding.left, 0, s, s * o.layout.padding.top];
	const toLayer = invertAffine(fromLayer)!;
	const prog: number[] = [lt.taps.length, lt.wsum];
	for (const t of lt.taps) {
		const map = composeAffine(fromLayer, composeAffine(t.map, toLayer));
		prog.push(t.w, ...map, 0, 0, o.layout.width, o.layout.height, t.stages.length);
		for (const st of t.stages) prog.push(...composeAffine(st.map, toLayer), ...st.rect);
	}
	// The text's paint pads the canvas by whole pixels (fx/plan.ts `planLayerFx` `contentPadding`).
	const cp = 'text' in o.clip.source ? Math.ceil(Math.max(0, textContentPad(o.clip.source.text))) : 0;
	const W = o.layout.width;
	const H = o.layout.height;
	const src: [number, number, number, number] = [
		Math.max(0, Math.floor((o.layout.padding.left - cp) * s)),
		Math.max(0, Math.floor((o.layout.padding.top - cp) * s)),
		Math.min(W, Math.ceil((o.layout.padding.left + o.props.box.width + cp) * s)),
		Math.min(H, Math.ceil((o.layout.padding.top + o.props.box.height + cp) * s)),
	];
	return { key: `${prog.map((x) => Math.round(x * 1e4) / 1e4).join(',')}|${src.join(',')}`, prog, src };
}

/** Canvas 2D `setTransform` arguments of an affine `[m0…m5]` (x' = m0·x + m1·y + m2, y' = m3·x + m4·y + m5). */
const setAffine = (ctx: CanvasRenderingContext2D, m: readonly number[]) =>
	ctx.setTransform(m[0]!, m[3]!, m[1]!, m[4]!, m[2]!, m[5]!);

export const fxLowered = createEffect<FxLoweredParams, null>({
	type: 'jasper.fx-lowered',
	label: 'Lowered layer',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!Array.isArray(p?.prog)) throw new Error('fxLowered needs {key, prog}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const ctx = target.getContext('2d');
		if (!ctx) throw new Error('fx: no 2D context for the effect canvas');
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, width, height);
		const p = params.prog;
		const n = p[0]! | 0;
		const wsum = p[1]!;
		if (n < 1 || !(wsum > 0)) return;
		let i = 2;
		for (let t = 0; t < n; t++) {
			const w = p[i]!;
			const map = p.slice(i + 1, i + 7) as Affine6;
			const clip = p.slice(i + 7, i + 11);
			const ns = p[i + 11]! | 0;
			const stages = p.slice(i + 12, i + 12 + ns * 10);
			i += 12 + ns * 10;
			const fwd = invertAffine(map);
			if (!fwd || !(w > 0)) continue;
			ctx.save();
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = 'low';
			ctx.globalCompositeOperation = n > 1 ? 'lighter' : 'source-over';
			for (let s = 0; s < ns; s++) {
				const sm = invertAffine(stages.slice(s * 10, s * 10 + 6) as Affine6);
				if (!sm) continue;
				const r = stages.slice(s * 10 + 6, s * 10 + 10);
				setAffine(ctx, sm);
				ctx.beginPath();
				ctx.rect(r[0]!, r[1]!, r[2]! - r[0]!, r[3]! - r[1]!);
				ctx.clip();
			}
			setAffine(ctx, fwd);
			ctx.beginPath();
			ctx.rect(clip[0]!, clip[1]!, clip[2]! - clip[0]!, clip[3]! - clip[1]!);
			ctx.clip();
			ctx.globalAlpha = Math.min(1, w / wsum);
			const [sx0, sy0, sx1, sy1] = params.src ?? [0, 0, width, height];
			if (sx1 > sx0 && sy1 > sy0)
				ctx.drawImage(source, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0, sy0, sx1 - sx0, sy1 - sy0);
			ctx.restore();
		}
	},
	cleanup: () => {},
});
