// The fx framework's Remotion canvas effects (remotion 4.0.499 `createEffect`, docs/research/remotion-4.0.499-notes.md):
// all `2d`-backend effects, so a layer's chain never allocates WebGL contexts of its own — shader passes and LUT
// passes run on the page's shared GPU host (fx/host.ts) and are copied into the chain's 2D canvases. The same
// descriptors run in `Internals.runEffectChain` (FxPicture, Player and renders) and in `<HtmlInCanvas effects>`
// (DOM layers). Crop and flips are 2D passes here because inside the chain they must happen in stack order.
import type { FxEffectPlan, Lut } from '@jasper/project';
import { createEffect } from 'remotion';
import type { LayerTap } from '../types.ts';
import { type FxRunInputs, FxShaderError, fxHost, runLutPass, runShaderPlan } from './host.ts';
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
