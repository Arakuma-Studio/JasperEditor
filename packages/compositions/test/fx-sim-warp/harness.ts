// Browser-side harness of the simulation-warp family tests (bundled with esbuild, run in headless Chrome): runs one
// GPU effect through the real fx host (src/fx/host.ts) on a painted layer and returns the output canvas — the
// contract of test/fx-psdg/harness.ts plus what simulations need: paramsAt, CPU pixels of media params, structures.
import {
	defaultEffectRegistry,
	type EffectParams,
	type EffectSpec,
	type FxPixels,
	type FxStructures,
	fxBuiltinUniforms,
	gpuPadding,
	planGpuEffect,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { type FxCanvasLayout, fxCanvasLayout } from '../../src/fx/plan.ts';

export type Px = [number, number, number, number];
export type Box = { x: number; y: number; w: number; h: number };
export type Paint = (ctx: CanvasRenderingContext2D, b: Box) => void;

export function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d', { willReadFrequently: true })!;
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

/** Pixels of a canvas as FxPixels (straight RGBA). */
export function pixelsOf(c: HTMLCanvasElement, key: string): FxPixels {
	return { width: c.width, height: c.height, data: c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data, key };
}

export type RunExtra = {
	frame?: number;
	duration?: number;
	fps?: number;
	textures?: Record<string, { source: TexImageSource; width: number; height: number; version: string } | null>;
	pixels?: Record<string, FxPixels>;
	seed?: number;
	paramsAt?: (f: number) => EffectParams;
	structures?: FxStructures;
	instanceKey?: string;
};

export function run(
	s: EffectSpec,
	params: Record<string, unknown>,
	box: { width: number; height: number },
	paint: Paint,
	extra: RunExtra = {},
): { out: HTMLCanvasElement; layout: FxCanvasLayout; input: HTMLCanvasElement; ms: number } {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const fps = extra.fps ?? 30;
	const duration = extra.duration ?? 300;
	const frame = extra.frame ?? 0;
	const seed = extra.seed ?? 0.25;
	const padding = gpuPadding(s, params as never, { ...box, pxScale: 1, fps });
	const layout = fxCanvasLayout(box, padding, 8192);
	const t0 = performance.now();
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
			progress: duration > 1 ? Math.min(1, frame / (duration - 1)) : 0,
			...(extra.paramsAt ? { paramsAt: extra.paramsAt } : {}),
			...(extra.instanceKey ? { instanceKey: extra.instanceKey } : {}),
			pixels: (name: string) => extra.pixels?.[name] ?? null,
			...(extra.structures ? { structures: extra.structures } : {}),
		},
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => paint(ctx, layout.box));
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
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: (extra.textures ?? {}) as never,
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	return { out, layout, input, ms: performance.now() - t0 };
}

export const solid =
	(color: string): Paint =>
	(ctx, b) => {
		ctx.fillStyle = color;
		ctx.fillRect(b.x, b.y, b.w, b.h);
	};

/** A colourful deterministic test picture (gradient + shapes). */
export const picture: Paint = (ctx, b) => {
	const g = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
	g.addColorStop(0, 'rgb(220,40,30)');
	g.addColorStop(0.5, 'rgb(40,200,80)');
	g.addColorStop(1, 'rgb(30,60,220)');
	ctx.fillStyle = g;
	ctx.fillRect(b.x, b.y, b.w, b.h);
	ctx.fillStyle = '#fff';
	ctx.fillRect(b.x + b.w * 0.15, b.y + b.h * 0.2, b.w * 0.2, b.h * 0.2);
	ctx.fillStyle = '#000';
	ctx.fillRect(b.x + b.w * 0.6, b.y + b.h * 0.55, b.w * 0.15, b.h * 0.25);
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

/** Sum of |difference| / 255 over all bytes. */
export function sumDiff(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
	const da = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data;
	const db = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data;
	if (da.length !== db.length) return Number.POSITIVE_INFINITY;
	let m = 0;
	for (let i = 0; i < da.length; i++) m += Math.abs(da[i]! - db[i]!) / 255;
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

/** Brightness-weighted centre of mass (x, y) of a canvas (r + g + b); [-1, -1] when black. */
export function centroidLum(c: HTMLCanvasElement): [number, number] {
	const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
	let sx = 0;
	let sy = 0;
	let m = 0;
	for (let y = 0; y < c.height; y++)
		for (let x = 0; x < c.width; x++) {
			const i = (y * c.width + x) * 4;
			const a = d[i]! + d[i + 1]! + d[i + 2]!;
			sx += a * x;
			sy += a * y;
			m += a;
		}
	return m > 0 ? [sx / m, sy / m] : [-1, -1];
}

/** Alpha-weighted centre of mass (x, y) of a canvas; [-1, -1] when empty. */
export function centroid(c: HTMLCanvasElement): [number, number] {
	const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
	let sx = 0;
	let sy = 0;
	let m = 0;
	for (let y = 0; y < c.height; y++)
		for (let x = 0; x < c.width; x++) {
			const a = d[(y * c.width + x) * 4 + 3]!;
			sx += a * x;
			sy += a * y;
			m += a;
		}
	return m > 0 ? [sx / m, sy / m] : [-1, -1];
}

/** True when any byte is NaN-like garbage: alpha below colour (broken premultiplication) beyond rounding. */
export function premulOk(c: HTMLCanvasElement): boolean {
	const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
	for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 0 && (d[i]! > 0 || d[i + 1]! > 0 || d[i + 2]! > 0)) return false;
	return true;
}
