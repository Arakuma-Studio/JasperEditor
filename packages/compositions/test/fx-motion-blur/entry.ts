// Browser entry of the motion-blur GL test (bundled with esbuild, run in headless Chrome by
// ../fx-motion-blur-gl.test.ts): runs effects and transitions through the real GPU host on simple test pictures (a
// thin bright line on black, a grid), with keyframed params (`keys` → `ctx.paramsAt`, piecewise linear between keys
// at fractional frames, as the shared keyframe evaluator does for linear keys) and an optional preview scale, and
// reports intensity profiles across the smear, checksums, PNGs and timings.
import {
	defaultEffectRegistry,
	defineShaderEffect,
	type EffectParams,
	type EffectSpec,
	fxBuiltinUniforms,
	GLSL_MB_POSES,
	gpuPadding,
	hashString,
	planGpuEffect,
	planGpuTransition,
	TRANSITION_SPECS,
	type TransitionSpec,
	type TrSide,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	paint?.(c.getContext('2d')!);
	return c;
}

/**
 * Test pictures: 'vline' (black, a 2-px white vertical line in the middle — smears horizontally), 'hline' (the same,
 * horizontal), 'grid' (colour quadrants + black grid + white disc), 'dot' (a white dot on black), 'none'.
 */
function paint(
	ctx: CanvasRenderingContext2D,
	b: { x: number; y: number; w: number; h: number },
	kind: string,
) {
	if (kind === 'none') return;
	if (kind === 'vline' || kind === 'hline' || kind === 'dot') {
		ctx.fillStyle = '#000';
		ctx.fillRect(b.x, b.y, b.w, b.h);
		ctx.fillStyle = '#fff';
		const s = Math.max(1, (2 * b.w) / 320);
		if (kind === 'vline') ctx.fillRect(b.x + b.w / 2 - s / 2, b.y, s, b.h);
		else if (kind === 'hline') ctx.fillRect(b.x, b.y + b.h / 2 - s / 2, b.w, s);
		else {
			ctx.beginPath();
			ctx.arc(b.x + b.w / 2, b.y + b.h / 2, 2 * s, 0, Math.PI * 2);
			ctx.fill();
		}
		return;
	}
	const cols = ['#d33', '#3b3', '#33d', '#dd3'];
	for (let i = 0; i < 4; i++) {
		ctx.fillStyle = cols[i]!;
		ctx.fillRect(b.x + (i % 2) * (b.w / 2), b.y + Math.floor(i / 2) * (b.h / 2), b.w / 2, b.h / 2);
	}
	ctx.strokeStyle = '#000';
	ctx.lineWidth = Math.max(1, b.w / 160);
	const step = b.w / 16;
	for (let x = step; x < b.w; x += step) {
		ctx.beginPath();
		ctx.moveTo(b.x + x, b.y);
		ctx.lineTo(b.x + x, b.y + b.h);
		ctx.stroke();
	}
	for (let y = step; y < b.h; y += step) {
		ctx.beginPath();
		ctx.moveTo(b.x, b.y + y);
		ctx.lineTo(b.x + b.w, b.y + y);
		ctx.stroke();
	}
	ctx.fillStyle = '#fff';
	ctx.beginPath();
	ctx.arc(b.x + b.w / 2, b.y + b.h / 2, b.h / 8, 0, Math.PI * 2);
	ctx.fill();
}

/** A keyframe: params (numbers / vec2 / points) at a clip-local frame. */
export type Key = { frame: number; params: Record<string, unknown> };

const lerpValue = (a: unknown, b: unknown, t: number): unknown => {
	if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
	if (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
		return a.map((x, i) => lerpValue(x, b[i], t));
	return t < 1 ? a : b;
};

/** Params at a (fractional) frame: linear between the keys, held before the first and after the last. */
function paramsAtKeys(base: EffectParams, keys: readonly Key[]) {
	const sorted = [...keys].sort((x, y) => x.frame - y.frame);
	return (f: number): EffectParams => {
		if (sorted.length === 0) return base;
		let a = sorted[0]!;
		let b = sorted[sorted.length - 1]!;
		if (f <= a.frame) return { ...base, ...a.params } as EffectParams;
		if (f >= b.frame) return { ...base, ...b.params } as EffectParams;
		for (let i = 0; i + 1 < sorted.length; i++)
			if (f >= sorted[i]!.frame && f <= sorted[i + 1]!.frame) {
				a = sorted[i]!;
				b = sorted[i + 1]!;
				break;
			}
		const t = (f - a.frame) / Math.max(1e-9, b.frame - a.frame);
		const out: Record<string, unknown> = { ...base };
		for (const k of new Set([...Object.keys(a.params), ...Object.keys(b.params)]))
			out[k] = lerpValue(a.params[k] ?? base[k], b.params[k] ?? base[k], t);
		return out as EffectParams;
	};
}

export type EffectArgs = {
	id: string;
	params?: Record<string, unknown>;
	keys?: Key[];
	width: number;
	height: number;
	paint?: string;
	frame?: number;
	seed?: number;
	/** Preview scale (Program monitor playback resolution; 1 = Full). */
	scale?: number;
	/** A row (layer px y) to report as luma 0..255 over the whole canvas width. */
	row?: number;
	/** A column (layer px x) to report as luma over the whole canvas height. */
	column?: number;
	probes?: [number, number][];
	png?: boolean;
	/** Repeat the draw this many times and report the mean time (ms). */
	repeat?: number;
};

export type Out = {
	probes: Px[];
	checksum: number;
	canvas: [number, number];
	box: [number, number, number, number];
	row?: number[];
	column?: number[];
	png?: string;
	ms?: number;
	uniforms?: Record<string, number[]>;
};

const luma = (d: Uint8ClampedArray, i: number) => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;

function report(out: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }, a: EffectArgs) {
	const ctx = out.getContext('2d')!;
	const all = ctx.getImageData(0, 0, out.width, out.height).data;
	let sum = 0;
	for (let i = 0; i < all.length; i += 1) sum = (sum * 31 + all[i]!) >>> 0;
	const s = box.w / Math.max(1, a.width);
	const probes = (a.probes ?? []).map(
		([x, y]) =>
			Array.from(ctx.getImageData(Math.floor(box.x + x * s), Math.floor(box.y + y * s), 1, 1).data) as Px,
	);
	const r: Partial<Out> = { probes, checksum: sum };
	if (a.row !== undefined) {
		const y = Math.min(out.height - 1, Math.max(0, Math.floor(box.y + a.row * s)));
		r.row = Array.from({ length: out.width }, (_, x) => luma(all, (y * out.width + x) * 4));
	}
	if (a.column !== undefined) {
		const x = Math.min(out.width - 1, Math.max(0, Math.floor(box.x + a.column * s)));
		r.column = Array.from({ length: out.height }, (_, y) => luma(all, (y * out.width + x) * 4));
	}
	if (a.png) r.png = out.toDataURL('image/png');
	return r;
}

function runEffect(a: EffectArgs): Out {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = defaultEffectRegistry.get(a.id) as EffectSpec | undefined;
	if (!spec) throw new Error(`unknown effect ${a.id}`);
	const params = {
		...Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
		...(a.params ?? {}),
	} as EffectParams;
	const frame = a.frame ?? 0;
	const seed = a.seed ?? 0.25;
	const at = a.keys?.length ? paramsAtKeys(params, a.keys) : undefined;
	const p = at ? at(frame) : params;
	const paramsAt = at ? (f: number) => (f === frame ? p : at(f)) : undefined;
	const box = { width: a.width, height: a.height };
	const scale = a.scale ?? 1;
	const padding = gpuPadding(spec, p, { ...box, pxScale: scale, fps: 30, frame, paramsAt });
	const layout = fxCanvasLayout(box, padding, 8192, scale);
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: p },
		{ ...box, pxScale: layout.pxScale, fps: 30, frame, duration: 60, seed, progress: 0, paramsAt },
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => paint(ctx, layout.box, a.paint ?? 'vline'));
	const out = canvas(layout.width, layout.height);
	const draw = () =>
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
						fps: 30,
						duration: 60,
						compSize: { width: 1920, height: 1080 },
					}),
					{ name: 'u_seed', type: 'float', value: [seed] },
				],
				textures: Object.fromEntries(plan.textures.map((t) => [t.uniform, null])) as never,
				samples: { sources: [], offsets: [] },
			},
			out.getContext('2d')!,
		);
	draw();
	let ms: number | undefined;
	if (a.repeat) {
		out.getContext('2d')!.getImageData(0, 0, 1, 1);
		const t0 = performance.now();
		for (let i = 0; i < a.repeat; i++) {
			draw();
			out.getContext('2d')!.getImageData(0, 0, 1, 1); // wait for the GPU
		}
		ms = (performance.now() - t0) / a.repeat;
	}
	const r = report(out, layout.box, a);
	const mb = plan.uniforms.find((u) => u.name === 'u_mbPlan');
	return {
		...(r as Out),
		canvas: [layout.width, layout.height],
		box: [layout.box.x, layout.box.y, layout.box.w, layout.box.h],
		...(ms !== undefined ? { ms } : {}),
		uniforms: mb ? { u_mbPlan: [...mb.value] } : {},
	};
}

export type TransitionArgs = {
	id: string;
	params?: Record<string, unknown>;
	frame: number;
	duration: number;
	width: number;
	height: number;
	/** Pictures of A and B ('vline', 'hline', 'grid', 'dot'). */
	from?: string;
	to?: string;
	row?: number;
	column?: number;
	probes?: [number, number][];
	png?: boolean;
	repeat?: number;
};

function runTransition(a: TransitionArgs): Out {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = TRANSITION_SPECS.find((s) => s.id === a.id) as TransitionSpec | undefined;
	if (!spec?.gpu) throw new Error(`unknown GPU transition ${a.id}`);
	const params = { ...Object.fromEntries(spec.params.map((p) => [p.name, p.default])), ...(a.params ?? {}) };
	const W = a.width;
	const H = a.height;
	const pic = (kind: string) => canvas(W, H, (ctx) => paint(ctx, { x: 0, y: 0, w: W, h: H }, kind));
	const side = (c: HTMLCanvasElement): TrSide => ({
		width: c.width,
		height: c.height,
		compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1],
		opacity: 1,
	});
	const A = pic(a.from ?? 'vline');
	const B = pic(a.to ?? 'vline');
	const staged = planGpuTransition(
		spec,
		{ id: 'trn_test', params: params as never, frame: a.frame, duration: a.duration, sides: 'both' },
		{ width: W, height: H, fps: 30 },
		{ out: side(A), in: side(B) },
	);
	const tex = (s: 'out' | 'in' | null) => {
		const c = s === 'out' ? A : s === 'in' ? B : null;
		return c ? { source: c, width: c.width, height: c.height, version: `${s}${a.from}${a.to}${W}` } : null;
	};
	const textures: Record<string, unknown> = { u_trFrom: tex(staged.fromSide), u_trTo: tex(staged.toSide) };
	for (const m of staged.plan.textures)
		if (m.uniform !== 'u_trFrom' && m.uniform !== 'u_trTo') textures[m.uniform] = null;
	const out = canvas(W, H);
	const draw = () =>
		runShaderPlan(
			h,
			staged.plan,
			canvas(1, 1),
			{ builtins: staged.builtins, textures: textures as never, samples: { sources: [], offsets: [] } },
			out.getContext('2d')!,
		);
	draw();
	let ms: number | undefined;
	if (a.repeat) {
		const t0 = performance.now();
		for (let i = 0; i < a.repeat; i++) {
			draw();
			out.getContext('2d')!.getImageData(0, 0, 1, 1);
		}
		ms = (performance.now() - t0) / a.repeat;
	}
	const box = { x: 0, y: 0, w: W, h: H };
	const r = report(out, box, { ...a, width: W, height: H } as EffectArgs);
	return { ...(r as Out), canvas: [W, H], box: [0, 0, W, H], ...(ms !== undefined ? { ms } : {}) };
}

/** Micro-benchmark of a custom single-pass shader (dev aid): mean ms over `repeat` draws at width × height. */
function bench(a: {
	frag: string;
	uniforms: Record<string, unknown>;
	width: number;
	height: number;
	repeat: number;
}) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = defineShaderEffect({
		id: `test.bench-${hashString(a.frag + JSON.stringify(Object.keys(a.uniforms)))}`,
		label: 'bench',
		category: 'Stylize',
		description: 'bench',
		params: [],
		gpu: { uniforms: () => a.uniforms as never, passes: [{ include: [GLSL_MB_POSES], frag: a.frag }] },
	});
	const box = { width: a.width, height: a.height };
	const layout = fxCanvasLayout(box, { left: 0, right: 0, top: 0, bottom: 0 }, 8192, 1);
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: {} },
		{ ...box, pxScale: 1, fps: 30, frame: 0, duration: 60, seed: 0.3, progress: 0 },
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => paint(ctx, layout.box, 'grid'));
	const out = canvas(layout.width, layout.height);
	const draw = () => {
		runShaderPlan(
			h,
			plan,
			input,
			{
				builtins: [
					...fxBuiltinUniforms({
						canvas: layout,
						box: layout.box,
						pxScale: 1,
						frame: 0,
						fps: 30,
						duration: 60,
						compSize: box,
					}),
					{ name: 'u_seed', type: 'float', value: [0.3] },
				],
				textures: {},
				samples: { sources: [], offsets: [] },
			},
			out.getContext('2d')!,
		);
		out.getContext('2d')!.getImageData(0, 0, 1, 1);
	};
	draw();
	const t0 = performance.now();
	for (let i = 0; i < a.repeat; i++) draw();
	return (performance.now() - t0) / a.repeat;
}

const api = { runEffect, runTransition, bench, info: () => ({ webgl2: !!fxHost() }) };

(window as unknown as { __mb: typeof api }).__mb = api;
