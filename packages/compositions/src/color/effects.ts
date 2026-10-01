// The colour stage as Remotion canvas effects (remotion 4.0.499 `createEffect`, see
// docs/research/remotion-4.0.499-notes.md): `@remotion/media` `<Video>` and `<Img>` run an effect chain on the
// decoded frame — in the Player and in renders (the render's delayRender waits for the chain) — so the layer keeps
// Remotion's own media scheduling. One `colorLut` pass per colour run (WebGL2), and `cssFilter` passes (2D canvas
// `filter`) for non-colour effects that sit between/before colour runs so the stack order is preserved.
import type { Lut } from '@jasper/project';
import { createEffect } from 'remotion';
import { applyLutRgba8 } from './cpu.ts';
import { type ColorGl, createColorGl, destroyColorGl, drawThroughLut, sourceSize } from './gl.ts';
import { colorStageStatus } from './status.ts';

export type ColorLutParams = {
	/** Run key (`colorRunKey`): the memo identity of the pass and the LUT texture cache key. */
	key: string;
	lut: Lut;
};

type LutState = {
	target: HTMLCanvasElement;
	gl: WebGL2RenderingContext | null;
	res: ColorGl | null;
	lost: boolean;
	onLost: () => void;
	onRestored: () => void;
};

function ensureResources(state: LutState): ColorGl | null {
	if (state.res) return state.res;
	const gl = state.gl ?? state.target.getContext('webgl2');
	if (!gl) throw new Error('WEBGL_UNAVAILABLE: the colour stage needs WebGL2 (no context)');
	state.gl = gl;
	if (gl.isContextLost()) return null;
	state.res = createColorGl(gl);
	return state.res;
}

/** One colour-run pass: the source through the run's baked 3D LUT (tetrahedral `texelFetch`, CG-040). */
export const colorLut = createEffect<ColorLutParams, LutState>({
	type: 'jasper.color-lut',
	label: 'Colour grade (baked LUT)',
	documentationLink: null,
	backend: 'webgl2',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p || typeof p.key !== 'string' || !p.lut) throw new Error('colorLut needs {key, lut}');
	},
	setup(target) {
		const state: LutState = {
			target,
			gl: null,
			res: null,
			lost: false,
			onLost: () => {
				if (state.lost) return;
				state.lost = true;
				state.res = null; // resources die with the context
				colorStageStatus.contextLost();
			},
			onRestored: () => {
				if (!state.lost) return;
				state.lost = false;
				colorStageStatus.contextRestored();
			},
		};
		target.addEventListener('webglcontextlost', state.onLost);
		target.addEventListener('webglcontextrestored', state.onRestored);
		return state;
	},
	apply({ source, target, state, params, width, height, flipSourceY }) {
		const res = state.lost ? null : ensureResources(state);
		if (!res) return; // lost: the layer re-renders ungraded (status store)
		const size = sourceSize(source);
		drawThroughLut(
			res,
			source as TexImageSource,
			size.width && size.height ? size : { width, height },
			params.lut,
			params.key,
			target.width,
			target.height,
			flipSourceY,
		);
	},
	cleanup(state) {
		state.target.removeEventListener('webglcontextlost', state.onLost);
		state.target.removeEventListener('webglcontextrestored', state.onRestored);
		if (state.lost) colorStageStatus.contextRestored();
		if (state.res) destroyColorGl(state.res);
		state.res = null;
	},
});

/**
 * The same colour-run pass on the CPU (2D canvas, see cpu.ts): chosen when WebGL2 is a software rasterizer.
 * Identical tetrahedral maths; the result equals the TypeScript reference.
 */
export const colorLutCpu = createEffect<ColorLutParams, null>({
	type: 'jasper.color-lut-cpu',
	label: 'Colour grade (baked LUT, CPU)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => `cpu:${p.key}`,
	schema: {},
	validateParams: (p) => {
		if (!p || typeof p.key !== 'string' || !p.lut) throw new Error('colorLutCpu needs {key, lut}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const ctx = target.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, width, height);
		ctx.drawImage(source, 0, 0, width, height);
		const img = ctx.getImageData(0, 0, width, height);
		applyLutRgba8(params.lut, img.data);
		ctx.putImageData(img, 0, 0);
	},
	cleanup: () => {},
});

export type CssFilterParams = { key: string; filter: string };

/** A non-colour effect inside the colour chain (e.g. a blur before a grade): the CSS filter on a 2D canvas. */
export const cssFilter = createEffect<CssFilterParams, null>({
	type: 'jasper.css-filter',
	label: 'CSS filter',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => `${p.key}:${p.filter}`,
	schema: {},
	validateParams: (p) => {
		if (!p || typeof p.filter !== 'string') throw new Error('cssFilter needs {filter}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const ctx = target.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, width, height);
		ctx.filter = params.filter;
		ctx.drawImage(source, 0, 0, width, height);
		ctx.filter = 'none';
	},
	cleanup: () => {},
});
