// GL mask rasteriser (wp masks) on the shared fx GPU host: analytic coverage + feather of a layer's masks
// (`MASK_FRAGMENT_SHADER`, the exact counterpart of the CPU `rasterizeMaskPack`), as two Remotion canvas effects
// of the fx chain:
// - `fxMaskApply`: the layer's Opacity masks — premultiplied picture × combined coverage (after every effect,
//   before Motion / opacity / blend, as Premiere renders Opacity);
// - `fxMasked`: an effect limited to its masks — runs the wrapped effect into a scratch canvas, then
//   mix(original, effected, coverage) (Premiere's per-effect masks).
// Mask geometry arrives as resolved masks (normalised layer coordinates) + the layer box in the chain canvas; the
// prepared/packed data is cached by content key, and the float data texture is uploaded only when it changes.
import {
	boxToCanvas,
	MASK_DATA_WIDTH,
	MASK_FRAGMENT_SHADER,
	type MaskPack,
	packMasks,
	prepareMasks,
	type ResolvedMask,
} from '@jasper/project';
import { createEffect, type EffectDescriptor } from 'remotion';
import { blit, compileShader, ensureCanvas, type FxHost, fxHost, texture2d, upload } from './host.ts';

type MaskGl = {
	program: WebGLProgram;
	locs: Map<string, WebGLUniformLocation | null>;
	src: WebGLTexture;
	orig: WebGLTexture;
	data: WebGLTexture;
	dataKey: string | null;
};

const programs = new WeakMap<FxHost, MaskGl>();

function maskGl(h: FxHost): MaskGl {
	const hit = programs.get(h);
	if (hit) return hit;
	const { gl } = h;
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, MASK_FRAGMENT_SHADER);
	if (typeof fs === 'string') throw new Error(`FX_SHADER_ERROR: mask rasteriser: ${fs}`);
	const p = gl.createProgram()!;
	gl.attachShader(p, h.vs);
	gl.attachShader(p, fs);
	gl.bindAttribLocation(p, 0, 'a_pos');
	gl.linkProgram(p);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
		throw new Error(`FX_SHADER_ERROR: mask rasteriser: ${gl.getProgramInfoLog(p) ?? 'link error'}`);
	const data = texture2d(gl, gl.NEAREST);
	const m: MaskGl = {
		program: p,
		locs: new Map(),
		src: texture2d(gl, gl.LINEAR),
		orig: texture2d(gl, gl.LINEAR),
		data,
		dataKey: null,
	};
	programs.set(h, m);
	return m;
}

function loc(h: FxHost, m: MaskGl, name: string): WebGLUniformLocation | null {
	if (m.locs.has(name)) return m.locs.get(name)!;
	const l = h.gl.getUniformLocation(m.program, name);
	m.locs.set(name, l);
	return l;
}

export type MaskPassMode = 'apply' | 'mix' | 'coverage';

/**
 * Runs the mask pass into `out` (a 2D context of the chain size): `apply` = src × coverage, `mix` =
 * mix(orig, src, coverage), `coverage` = white × coverage. `pack` null = no active mask (coverage 1).
 */
export function runMaskPass(
	h: FxHost,
	opts: {
		pack: MaskPack | null;
		packKey: string;
		mode: MaskPassMode;
		src: TexImageSource | null;
		orig?: TexImageSource | null;
		width: number;
		height: number;
	},
	out: CanvasRenderingContext2D,
): void {
	const { gl } = h;
	if (h.lost || gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the fx GPU context is lost');
	const { width: W, height: H, pack } = opts;
	const m = maskGl(h);
	ensureCanvas(h, W, H);
	gl.disable(gl.BLEND);
	gl.disable(gl.DEPTH_TEST);
	gl.disable(gl.SCISSOR_TEST);
	if (opts.src) upload(h, m.src, opts.src);
	if (opts.orig) upload(h, m.orig, opts.orig);
	if (pack && m.dataKey !== opts.packKey) {
		gl.bindTexture(gl.TEXTURE_2D, m.data);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA32F,
			MASK_DATA_WIDTH,
			pack.dataHeight,
			0,
			gl.RGBA,
			gl.FLOAT,
			pack.data,
		);
		m.dataKey = opts.packKey;
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, W, H);
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(m.program);
	const set1i = (n: string, v: number) => {
		const l = loc(h, m, n);
		if (l) gl.uniform1i(l, v);
	};
	const fl = loc(h, m, 'u_flipY');
	if (fl) gl.uniform1f(fl, 1);
	set1i('u_passMode', opts.mode === 'apply' ? 0 : opts.mode === 'mix' ? 1 : 2);
	set1i('u_maskCount', pack?.count ?? 0);
	const grid = loc(h, m, 'u_grid');
	if (grid) gl.uniform2i(grid, pack?.grid[0] ?? 1, pack?.grid[1] ?? 1);
	set1i('u_tile', pack?.tile ?? 16);
	set1i('u_listBase', pack?.listBase ?? 0);
	const size = loc(h, m, 'u_size');
	if (size) gl.uniform2f(size, W, H);
	const bind = (unit: number, tex: WebGLTexture, name: string) => {
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, tex);
		set1i(name, unit);
	};
	bind(0, opts.src ? m.src : h.dummy2d, 'u_src');
	bind(1, opts.orig ? m.orig : h.dummy2d, 'u_orig');
	bind(2, pack ? m.data : h.dummy2d, 'u_maskData');
	gl.bindVertexArray(h.vao);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.bindVertexArray(null);
	gl.activeTexture(gl.TEXTURE0);
	if (gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the fx GPU context was lost while drawing');
	blit(h, out, W, H);
}

export type FxMaskGeometry = {
	masks: readonly ResolvedMask[];
	/** The layer box inside the chain canvas (canvas px). */
	box: { x: number; y: number; w: number; h: number };
	/** Canvas px per layer px. */
	pxScale: number;
};

const PACK_CACHE_LIMIT = 32;
const packCache = new Map<string, MaskPack | null>();

/** Identity of a mask geometry on a canvas (the descriptor key and the pack cache key). */
export function maskGeometryKey(g: FxMaskGeometry, width: number, height: number): string {
	return `${width}x${height}|${g.box.x},${g.box.y},${g.box.w},${g.box.h}|${g.pxScale}|${JSON.stringify(g.masks)}`;
}

/** The packed masks of a geometry on a `width × height` canvas (null: no active mask), cached. */
export function packedMasks(
	g: FxMaskGeometry,
	width: number,
	height: number,
): { pack: MaskPack | null; key: string } {
	const key = maskGeometryKey(g, width, height);
	if (packCache.has(key)) {
		const v = packCache.get(key)!;
		packCache.delete(key);
		packCache.set(key, v);
		return { pack: v, key };
	}
	const pack = packMasks(prepareMasks(g.masks, boxToCanvas(g.box), g.pxScale), width, height);
	packCache.set(key, pack);
	while (packCache.size > PACK_CACHE_LIMIT) packCache.delete(packCache.keys().next().value!);
	return { pack, key };
}

const ctx2d = (c: HTMLCanvasElement) => {
	const ctx = c.getContext('2d');
	if (!ctx) throw new Error('fx: no 2D context for the effect canvas');
	return ctx;
};

const unavailable = () => new Error('WEBGL_UNAVAILABLE: masks need WebGL2');

export type FxMaskApplyParams = { key: string; geometry: FxMaskGeometry };

/** Opacity masks: the layer picture × the combined coverage of its masks. */
export const fxMaskApply = createEffect<FxMaskApplyParams, null>({
	type: 'jasper.fx-mask',
	label: 'Opacity masks',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p?.geometry) throw new Error('fxMaskApply needs {key, geometry}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const h = fxHost();
		if (!h) throw unavailable();
		const { pack, key } = packedMasks(params.geometry, width, height);
		runMaskPass(
			h,
			{ pack, packKey: key, mode: 'apply', src: source as TexImageSource, width, height },
			ctx2d(target),
		);
	},
	cleanup: () => {},
});

export type FxMaskedParams = {
	key: string;
	geometry: FxMaskGeometry;
	inner: EffectDescriptor;
	/** color-grade: descriptors applied after `inner` (on its output) before the one mask mix. */
	followedBy?: EffectDescriptor[];
};

const scratch = new Map<string, HTMLCanvasElement>();
const innerStates = new WeakMap<object, WeakMap<HTMLCanvasElement, unknown>>();

function scratchCanvas(w: number, h: number, slot = 0): HTMLCanvasElement {
	const k = `${w}x${h}#${slot}`;
	let c = scratch.get(k);
	if (!c) {
		c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		scratch.set(k, c);
		while (scratch.size > 8) scratch.delete(scratch.keys().next().value!);
	}
	return c;
}

/** An effect limited to its masks: mix(original, effect(original), coverage). */
export const fxMasked = createEffect<FxMaskedParams, null>({
	type: 'jasper.fx-masked',
	label: 'Masked effect',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) =>
		`${p.key}|${p.inner.effectKey}${(p.followedBy ?? []).map((d) => `|${d.effectKey}`).join('')}`,
	schema: {},
	validateParams: (p) => {
		if (!p?.geometry || !p.inner) throw new Error('fxMasked needs {key, geometry, inner}');
	},
	setup: () => null,
	apply({ source, target, params, width, height, gpuDevice, flipSourceY }) {
		const h = fxHost();
		if (!h) throw unavailable();
		const { pack, key } = packedMasks(params.geometry, width, height);
		const runInner = (d: EffectDescriptor, src: CanvasImageSource, slot: number): HTMLCanvasElement => {
			const def = d.definition;
			const target = scratchCanvas(width, height, slot);
			let states = innerStates.get(def);
			if (!states) {
				states = new WeakMap();
				innerStates.set(def, states);
			}
			if (!states.has(target)) states.set(target, def.setup(target));
			ctx2d(target).clearRect(0, 0, width, height);
			def.apply({
				source: src,
				target,
				state: states.get(target),
				params: d.params,
				width,
				height,
				gpuDevice,
				flipSourceY,
			});
			return target;
		};
		let fx = runInner(params.inner, source as CanvasImageSource, 0);
		(params.followedBy ?? []).forEach((d, i) => {
			fx = runInner(d, fx, (i + 1) % 2 === 1 ? 1 : 0);
		});
		runMaskPass(
			h,
			{ pack, packKey: key, mode: 'mix', src: fx, orig: source as TexImageSource, width, height },
			ctx2d(target),
		);
	},
	cleanup: () => {},
});
