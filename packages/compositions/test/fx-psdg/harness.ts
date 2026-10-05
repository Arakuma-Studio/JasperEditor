// Browser-side harness of the premiere-stylize-distort-generate family tests (bundled with esbuild, run in headless
// Chrome): runs one GPU effect through the real fx host (src/fx/host.ts) on a painted layer and returns the output
// canvas. Same contract as test/fx-gl/entry.ts `run`, plus time samples built from the hook's offsets and frames.
import {
	defaultEffectRegistry,
	type EffectSpec,
	fxBuiltinUniforms,
	fxTimeSamples,
	planGpuEffect,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { type FxCanvasLayout, fxCanvasLayout } from '../../src/fx/plan.ts';

export type Px = [number, number, number, number];
export type Box = { x: number; y: number; w: number; h: number };
export type Paint = (ctx: CanvasRenderingContext2D, b: Box, frameOffset: number) => void;

export function canvas(
	w: number,
	h: number,
	paint?: (ctx: CanvasRenderingContext2D) => void,
): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d')!;
	paint?.(ctx);
	return c;
}

export const px = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;

export function spec(id: string): EffectSpec {
	const s = defaultEffectRegistry.get(id);
	if (!s) throw new Error(`unknown effect ${id}`);
	return s;
}

export const defaults = (s: EffectSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});

export type RunExtra = {
	/** Clip-local frame (default 0) and clip duration (default 60). */
	frame?: number;
	duration?: number;
	fps?: number;
	/** Media textures by uniform name (`u_<param>`). */
	textures?: Record<
		string,
		{ source: TexImageSource; width: number; height: number; version: string } | null
	>;
	seed?: number;
	/** Transition driving the layer (u_progress / u_side). */
	transition?: { progress: number; side: 'out' | 'in' } | null;
};

/**
 * Runs `s` with `params` on a layer of size `box` painted by `paint` (layer px = canvas px). Time samples requested
 * by the effect's hook are painted by `paint` with their frame offset (so a test can draw "motion").
 */
export function run(
	s: EffectSpec,
	params: Record<string, unknown>,
	box: { width: number; height: number },
	paint: Paint,
	extra: RunExtra = {},
): { out: HTMLCanvasElement; layout: FxCanvasLayout; input: HTMLCanvasElement } {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const fps = extra.fps ?? 30;
	const duration = extra.duration ?? 60;
	const frame = extra.frame ?? 0;
	const seed = extra.seed ?? 0.25;
	const pad = s.gpu?.padding?.(params as never, { ...box, pxScale: 1, fps }) ?? 0;
	const padding =
		typeof pad === 'number'
			? { left: pad, top: pad, right: pad, bottom: pad }
			: { left: 0, top: 0, right: 0, bottom: 0, ...pad };
	const layout = fxCanvasLayout(box, padding, 8192);
	const plan = planGpuEffect(
		s,
		{ id: 'fx1', params: params as never },
		{
			width: box.width,
			height: box.height,
			pxScale: layout.pxScale,
			fps,
			frame,
			duration,
			seed,
			progress: extra.transition?.progress ?? (duration > 1 ? Math.min(1, frame / (duration - 1)) : 0),
		},
		{ width: layout.width, height: layout.height },
	);
	const offsets = fxTimeSamples(s, params as never, {
		frame,
		fps,
		duration,
		headHandle: 0,
		tailHandle: 0,
		seed,
	});
	const sources = offsets.map((o) => canvas(layout.width, layout.height, (ctx) => paint(ctx, layout.box, o)));
	const input = canvas(layout.width, layout.height, (ctx) => paint(ctx, layout.box, 0));
	const out = canvas(layout.width, layout.height);
	runShaderPlan(
		h,
		plan,
		input,
		{
			builtins: [
				...fxBuiltinUniforms({
					canvas: layout,
					box: layout.box,
					pxScale: layout.pxScale,
					frame,
					fps,
					duration,
					transition: extra.transition ?? null,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: (extra.textures ?? {}) as never,
			samples: { sources, offsets },
		},
		out.getContext('2d')!,
	);
	return { out, layout, input };
}

/** Paints a solid rectangle over the layer box. */
export const solid =
	(color: string): Paint =>
	(ctx, b) => {
		ctx.fillStyle = color;
		ctx.fillRect(b.x, b.y, b.w, b.h);
	};

/** Paints a picture stretched over the layer box; time samples are shifted right by 6 px per frame of offset. */
export const picture =
	(img: CanvasImageSource): Paint =>
	(ctx, b, o) => {
		ctx.drawImage(img, b.x - o * 6, b.y, b.w, b.h);
	};

/** Max |difference| of two canvases' RGBA bytes. */
export function maxDiff(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
	const da = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data;
	const db = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data;
	if (da.length !== db.length) return 255;
	let m = 0;
	for (let i = 0; i < da.length; i++) m = Math.max(m, Math.abs(da[i]! - db[i]!));
	return m;
}

/** Mean of the RGBA bytes of a canvas region. */
export function mean(c: HTMLCanvasElement, x = 0, y = 0, w = c.width, h = c.height): Px {
	const d = c.getContext('2d')!.getImageData(x, y, w, h).data;
	const s = [0, 0, 0, 0];
	for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 4; k++) s[k]! += d[i + k]!;
	const n = d.length / 4;
	return s.map((v) => v / n) as Px;
}
