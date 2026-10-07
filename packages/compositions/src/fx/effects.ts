// The fx framework's Remotion canvas effects (remotion 4.0.499 `createEffect`, docs/research/remotion-4.0.499-notes.md):
// all `2d`-backend effects, so a layer's chain never allocates WebGL contexts of its own — shader passes and LUT
// passes run on the page's shared GPU host (fx/host.ts) and are copied into the chain's 2D canvases. The same
// descriptors run in `Internals.runEffectChain` (FxPicture, Player and renders) and in `<HtmlInCanvas effects>`
// (DOM layers). Crop and flips are 2D passes here because inside the chain they must happen in stack order.
import type { FxEffectPlan, Lut } from '@jasper/project';
import { createEffect } from 'remotion';
import type { LayerTap } from '../types.ts';
import { planComposite } from './composite-plan.ts';
import { type FxRunInputs, FxShaderError, fxHost, runLutPass, runShaderPlan } from './host.ts';
import { type FxMaskGeometry, packedMasks, runMaskPass } from './mask.ts';
import { fxStatus } from './status.ts';

export type FxShaderParams = {
	/** Identity of everything that changes the output (plan key + uniform values + input versions). */
	key: string;
	plan: FxEffectPlan;
	inputs: FxRunInputs;
	/**
	 * Player: a shader that fails to compile is reported (fxStatus → the layer re-plans without it, chip) and this
	 * draw passes the picture through. Renders (false): the error propagates and fails the render.
	 */
	preview: boolean;
};

const ctx2d = (c: HTMLCanvasElement) => {
	const ctx = c.getContext('2d');
	if (!ctx) throw new Error('fx: no 2D context for the effect canvas');
	return ctx;
};

const unavailable = () => new Error('WEBGL_UNAVAILABLE: GPU shader effects need WebGL2');

/** One planned shader effect instance (every pass) on the shared GPU host. */
export const fxShader = createEffect<FxShaderParams, null>({
	type: 'jasper.fx-shader',
	label: 'GPU shader effect',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p || typeof p.key !== 'string' || !p.plan) throw new Error('fxShader needs {key, plan, inputs}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const host = fxHost();
		if (!host) throw unavailable();
		if (width !== params.plan.canvas.width || height !== params.plan.canvas.height)
			throw new Error(
				`fx: chain is ${width}×${height} but ${params.plan.effectId} was planned for ${params.plan.canvas.width}×${params.plan.canvas.height}`,
			);
		const out = ctx2d(target);
		try {
			runShaderPlan(host, params.plan, source as TexImageSource, params.inputs, out);
		} catch (e) {
			if (!params.preview) throw e;
			if (e instanceof FxShaderError) fxStatus.shaderFailed(e.effectId, e.message);
			else console.warn('[fx]', (e as Error).message);
			out.globalCompositeOperation = 'copy';
			out.drawImage(source, 0, 0, width, height);
			out.globalCompositeOperation = 'source-over';
		}
	},
	cleanup: () => {},
});

export type FxLutParams = { key: string; lut: Lut };

/** A colour run (baked LUT) inside an fx chain, on the shared GPU host (same shader as the colour stage). */
export const fxLut = createEffect<FxLutParams, null>({
	type: 'jasper.fx-lut',
	label: 'Colour grade (baked LUT, fx host)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p || typeof p.key !== 'string' || !p.lut) throw new Error('fxLut needs {key, lut}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const host = fxHost();
		if (!host) throw unavailable();
		runLutPass(host, params.lut, params.key, source as TexImageSource, ctx2d(target), width, height);
	},
	cleanup: () => {},
});

export type FxBoxParams = {
	key: string;
	/** The layer box inside the chain canvas (canvas px). */
	box: { x: number; y: number; w: number; h: number };
};

/** Crop inside the chain: everything outside the inset rect of the box is cleared (the CSS `inset()` clip). */
export const fxCrop = createEffect<FxBoxParams & { insets: [number, number, number, number] }, null>({
	type: 'jasper.fx-crop',
	label: 'Crop (fx chain)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => `${p.key}:${p.insets.join(',')}:${p.box.x},${p.box.y},${p.box.w},${p.box.h}`,
	schema: {},
	validateParams: (p) => {
		if (!p?.box || !p.insets) throw new Error('fxCrop needs {box, insets}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const ctx = ctx2d(target);
		const { box, insets } = params;
		const [l, t, r, b] = insets;
		ctx.clearRect(0, 0, width, height);
		ctx.save();
		ctx.beginPath();
		ctx.rect(
			box.x + l * box.w,
			box.y + t * box.h,
			Math.max(0, box.w * (1 - l - r)),
			Math.max(0, box.h * (1 - t - b)),
		);
		ctx.clip();
		ctx.drawImage(source, 0, 0, width, height);
		ctx.restore();
	},
	cleanup: () => {},
});

/** Horizontal / vertical flip about the layer box centre (S03:FX-051), inside the chain. */
export const fxFlip = createEffect<FxBoxParams & { horizontal: boolean }, null>({
	type: 'jasper.fx-flip',
	label: 'Flip (fx chain)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => `${p.key}:${p.horizontal ? 'h' : 'v'}:${p.box.x},${p.box.y},${p.box.w},${p.box.h}`,
	schema: {},
	validateParams: (p) => {
		if (!p?.box) throw new Error('fxFlip needs {box, horizontal}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const ctx = ctx2d(target);
		const { box } = params;
		const cx = box.x + box.w / 2;
		const cy = box.y + box.h / 2;
		ctx.clearRect(0, 0, width, height);
		ctx.save();
		ctx.translate(cx, cy);
		ctx.scale(params.horizontal ? -1 : 1, params.horizontal ? 1 : -1);
		ctx.translate(-cx, -cy);
		ctx.drawImage(source, 0, 0, width, height);
		ctx.restore();
	},
	cleanup: () => {},
});

export type FxTapParams = {
	key: string;
	tap: LayerTap;
	meta: { compToCanvas: readonly number[] | null; opacity: number };
};

/**
 * Transition framework: the last step of a GPU-transition side's chain. Hands the finished layer picture (every
 * effect applied, layer canvas layout) to the transition stage and leaves the layer's own output empty — the stage
 * draws both sides composited.
 */
export const fxTap = createEffect<FxTapParams, null>({
	type: 'jasper.fx-transition-tap',
	label: 'Transition side (fx chain)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p?.tap) throw new Error('fxTap needs {key, tap, meta}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		params.tap.deliver(source as CanvasImageSource, width, height, params.meta);
		ctx2d(target).clearRect(0, 0, width, height);
	},
	cleanup: () => {},
});

// ---------------------------------------------------------------- edit-structure: adjustment layers

export type FxStashParams = { key: string; holder: { canvas: HTMLCanvasElement | null } };

/** Keeps a copy of the picture (the composite below an adjustment layer) and passes it through. */
export const fxStash = createEffect<FxStashParams, null>({
	type: 'jasper.fx-adjustment-stash',
	label: 'Adjustment layer (original)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p?.holder) throw new Error('fxStash needs {key, holder}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		let c = params.holder.canvas;
		if (!c) {
			c = document.createElement('canvas');
			params.holder.canvas = c;
		}
		if (c.width !== width) c.width = width;
		if (c.height !== height) c.height = height;
		const sc = ctx2d(c);
		sc.globalCompositeOperation = 'copy';
		sc.drawImage(source, 0, 0, width, height);
		sc.globalCompositeOperation = 'source-over';
		const out = ctx2d(target);
		out.globalCompositeOperation = 'copy';
		out.drawImage(source, 0, 0, width, height);
		out.globalCompositeOperation = 'source-over';
	},
	cleanup: () => {},
});

export type FxMixParams = {
	key: string;
	holder: { canvas: HTMLCanvasElement | null };
	opacity: number;
	/** keyframes-blend: the adjustment clip's blend mode (BLEND_MODES id), its Dissolve seed and pixel mapping. */
	blend: string;
	seed: number;
	noise?: { x: number; y: number; scale: number };
	region: { x: number; y: number; w: number; h: number } | null;
	/**
	 * wp masks × edit-structure: the adjustment layer's Opacity masks limit where it applies — the result is
	 * mix(original, adjusted mix, coverage), i.e. the opacity is multiplied by the masks' coverage.
	 */
	masks?: FxMaskGeometry | null;
};

export const fxAdjustmentMix = createEffect<FxMixParams, null>({
	type: 'jasper.fx-adjustment-mix',
	label: 'Adjustment layer (mix)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p?.holder) throw new Error('fxAdjustmentMix needs {key, holder, opacity, blend, region}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const orig = params.holder.canvas;
		const masked = !!params.masks?.masks.length && !!orig;
		const holder = params.holder as { scratch?: HTMLCanvasElement; masked?: HTMLCanvasElement };
		let maskCanvas: HTMLCanvasElement | null = null;
		if (masked) {
			maskCanvas = holder.masked ?? document.createElement('canvas');
			holder.masked = maskCanvas;
			if (maskCanvas.width !== width) maskCanvas.width = width;
			if (maskCanvas.height !== height) maskCanvas.height = height;
		}
		const out = ctx2d(maskCanvas ?? target);
		const k = Math.min(1, Math.max(0, params.opacity));
		// keyframes-blend: a blend mode composites the effects' output (× opacity) onto the original on the GPU with the
		// clip blend formulas (= the native kernel): the result then replaces the original inside the region.
		let blended: CanvasImageSource | null = null;
		if (params.blend !== 'normal' && orig) {
			const t = holder.scratch ?? document.createElement('canvas');
			holder.scratch = t;
			if (t.width !== width) t.width = width;
			if (t.height !== height) t.height = height;
			const host = fxHost();
			if (!host) throw new Error('WEBGL_UNAVAILABLE: blend modes need WebGL2');
			const item = { kind: 'clip' as const, key: 'adjusted', mode: params.blend, seed: params.seed };
			const pic = { width, height, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: k };
			const { plan, textures, builtins } = planComposite(
				[item],
				new Map([['adjusted', pic]]),
				{ width, height },
				params.noise ? { noise: params.noise } : {},
			);
			runShaderPlan(
				host,
				plan,
				orig,
				{
					builtins,
					textures: {
						[textures[0]!.uniform]: {
							source: source as TexImageSource,
							width,
							height,
							version: `adj:${params.key}:${Math.random()}`,
						},
					},
					samples: { sources: [], offsets: [] },
				},
				ctx2d(t),
			);
			blended = t;
		}
		out.globalCompositeOperation = 'copy';
		if (orig) out.drawImage(orig, 0, 0, width, height);
		else out.clearRect(0, 0, width, height);
		out.save();
		if (params.region) {
			out.beginPath();
			out.rect(params.region.x, params.region.y, params.region.w, params.region.h);
			out.clip();
		}
		if (blended) {
			out.globalCompositeOperation = 'copy';
			out.drawImage(blended, 0, 0, width, height);
		} else {
			// Premultiplied lerp: (1 − k) · original + k · adjusted (copy with alpha, then additive).
			out.globalCompositeOperation = 'copy';
			out.globalAlpha = 1 - k;
			if (orig) out.drawImage(orig, 0, 0, width, height);
			out.globalCompositeOperation = 'lighter';
			out.globalAlpha = k;
			if (k > 0) out.drawImage(source, 0, 0, width, height);
		}
		out.restore();
		out.globalAlpha = 1;
		out.globalCompositeOperation = 'source-over';
		if (maskCanvas && orig && params.masks) {
			const h = fxHost();
			if (!h) throw new Error('WEBGL_UNAVAILABLE: masks need WebGL2');
			const { pack, key } = packedMasks(params.masks, width, height);
			runMaskPass(
				h,
				{ pack, packKey: key, mode: 'mix', src: maskCanvas, orig, width, height },
				ctx2d(target),
			);
		}
	},
	cleanup: () => {},
});
