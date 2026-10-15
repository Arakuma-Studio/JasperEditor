import {
	defaultEffectRegistry,
	type EffectSpec,
	fxBuiltinUniforms,
	gpuPadding,
	planGpuEffect,
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

function paintTest(
	ctx: CanvasRenderingContext2D,
	b: { x: number; y: number; w: number; h: number },
	kind: string,
) {
	if (kind === 'none') return;
	if (kind === 'dots') {
		// Black with three white dots (S_WarpDrops centres) at 25 %, 50 %, 75 % across.
		ctx.fillStyle = '#000';
		ctx.fillRect(b.x, b.y, b.w, b.h);
		ctx.fillStyle = '#fff';
		for (const [x, y] of [
			[0.25, 0.3],
			[0.5, 0.6],
			[0.75, 0.35],
		] as const) {
			ctx.beginPath();
			ctx.arc(b.x + x * b.w, b.y + y * b.h, b.h / 30, 0, Math.PI * 2);
			ctx.fill();
		}
		return;
	}
	if (kind === 'solid') {
		ctx.fillStyle = '#808080';
		ctx.fillRect(b.x, b.y, b.w, b.h);
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

export type RunArgs = {
	id: string;
	params?: Record<string, unknown>;
	width: number;
	height: number;
	/** 'grid' (default), 'solid' or 'none' (transparent). */
	paint?: string;
	frame?: number;
	seed?: number;
	/** Media params: param name → painted fixture kind. */
	media?: Record<string, string>;
	/** Pixels to read, in layer px (may be outside the box when padded). */
	probes?: [number, number][];
};

function run(a: RunArgs) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = defaultEffectRegistry.get(a.id) as EffectSpec | undefined;
	if (!spec) throw new Error(`unknown effect ${a.id}`);
	const params = { ...Object.fromEntries(spec.params.map((p) => [p.name, p.default])), ...(a.params ?? {}) };
	const box = { width: a.width, height: a.height };
	const padding = gpuPadding(spec, params as never, { ...box, pxScale: 1, fps: 30 });
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = a.frame ?? 0;
	const seed = a.seed ?? 0.25;
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: params as never },
		{ ...box, pxScale: layout.pxScale, fps: 30, frame, duration: 60, seed, progress: 0 },
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => paintTest(ctx, layout.box, a.paint ?? 'grid'));
	const textures: Record<string, unknown> = {};
	for (const t of plan.textures) {
		const m = a.media?.[t.param];
		if (!m) textures[t.uniform] = null;
		else {
			const src = canvas(a.width, a.height, (ctx) =>
				paintTest(ctx, { x: 0, y: 0, w: a.width, h: a.height }, m),
			);
			textures[t.uniform] = { source: src, width: a.width, height: a.height, version: m };
		}
	}
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
					fps: 30,
					duration: 60,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: textures as never,
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	return readPicture(out, { ...layout.box, w: a.width, h: a.height }, a.probes);
}

function readPicture(
	picture: HTMLCanvasElement,
	box: { x: number; y: number; w: number; h: number },
	points: [number, number][] = [],
) {
	const ctx = picture.getContext('2d')!;
	const probes = points.map(
		([x, y]) => Array.from(ctx.getImageData(Math.floor(x + box.x), Math.floor(y + box.y), 1, 1).data) as Px,
	);
	const all = ctx.getImageData(box.x, box.y, box.w, box.h).data;
	let checksum = 0;
	for (const value of all) checksum = (checksum * 31 + value) >>> 0;
	return { probes, checksum };
}

const api = {
	source(a: Pick<RunArgs, 'width' | 'height' | 'paint' | 'probes'>) {
		const box = { x: 0, y: 0, w: a.width, h: a.height };
		const input = canvas(a.width, a.height, (ctx) => paintTest(ctx, box, a.paint ?? 'grid'));
		return readPicture(input, box, a.probes);
	},
	run,
	ids() {
		return defaultEffectRegistry
			.list()
			.filter((s) => s.id.startsWith('jasper.s.') && s.bin === 'Sapphire Distort')
			.map((s) => s.id);
	},
};

(window as unknown as { __dw: typeof api }).__dw = api;
