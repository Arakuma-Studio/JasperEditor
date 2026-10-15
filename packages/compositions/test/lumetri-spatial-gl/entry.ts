import {
	defaultEffectRegistry,
	type EffectSpec,
	fxBuiltinUniforms,
	LUMETRI_SPATIAL_EFFECT_ID,
	planGpuEffect,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Box = { x: number; y: number; w: number; h: number };

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d', { willReadFrequently: true })!;
	paint?.(ctx);
	return c;
}

const spec = (): EffectSpec => defaultEffectRegistry.get(LUMETRI_SPATIAL_EFFECT_ID)!;

const SCENES: Record<string, (ctx: CanvasRenderingContext2D, b: Box) => void> = {
	grey(ctx, b) {
		ctx.fillStyle = '#a0a0a0';
		ctx.fillRect(b.x, b.y, b.w, b.h);
	},
	/** Red field with isolated blue specks (the key has speckle holes: Denoise). */
	speckle(ctx, b) {
		ctx.fillStyle = '#d02020';
		ctx.fillRect(b.x, b.y, b.w, b.h);
		ctx.fillStyle = '#2030d0';
		for (let y = 3; y < b.h; y += 7) for (let x = 3; x < b.w; x += 7) ctx.fillRect(b.x + x, b.y + y, 1, 1);
	},
	/** Left half red, right half blue (key edge: Blur). */
	split(ctx, b) {
		ctx.fillStyle = '#d02020';
		ctx.fillRect(b.x, b.y, b.w / 2, b.h);
		ctx.fillStyle = '#2030d0';
		ctx.fillRect(b.x + b.w / 2, b.y, b.w / 2, b.h);
	},
	/** Left half light grey, right half dark grey (sharpen). */
	edge(ctx, b) {
		ctx.fillStyle = '#404040';
		ctx.fillRect(b.x, b.y, b.w, b.h);
		ctx.fillStyle = '#c0c0c0';
		ctx.fillRect(b.x, b.y, b.w / 2, b.h);
	},
	alpha(ctx, b) {
		ctx.fillStyle = '#d02020';
		ctx.fillRect(b.x, b.y, b.w / 2, b.h);
	},
};

export type RunOptions = {
	params?: Record<string, unknown>;
	width: number;
	height: number;
	scene: string;
	probes?: [number, number][];
	/** Independently painted fixture colors, in 8-bit RGB. */
	colors?: [number, number, number][];
};

async function run(o: RunOptions) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = spec();
	const params = { ...Object.fromEntries(s.params.map((p) => [p.name, p.default])), ...o.params };
	const box = { width: o.width, height: o.height };
	const layout = fxCanvasLayout(box, { left: 0, top: 0, right: 0, bottom: 0 }, 8192);
	const plan = planGpuEffect(
		s,
		{ id: 'fx1', params: params as never },
		{
			width: box.width,
			height: box.height,
			pxScale: layout.pxScale,
			fps: 30,
			frame: 0,
			duration: 60,
			seed: 0.5,
			progress: 0,
		},
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => {
		if (o.colors) {
			const width = layout.width / o.colors.length;
			o.colors.forEach((color, i) => {
				ctx.fillStyle = `rgb(${color.join(',')})`;
				ctx.fillRect(i * width, 0, width, layout.height);
			});
		} else SCENES[o.scene]!(ctx, layout.box);
	});
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
					frame: 0,
					fps: 30,
					duration: 60,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [0.5] },
			],
			textures: {},
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	const W = layout.width;
	const H = layout.height;
	const got = out.getContext('2d')!.getImageData(0, 0, W, H).data;
	const at = (x: number, y: number): Px => {
		const i = (Math.floor(y) * W + Math.floor(x)) * 4;
		return [got[i]!, got[i + 1]!, got[i + 2]!, got[i + 3]!];
	};
	return {
		probes: (o.probes ?? []).map(([x, y]) => at(x, y)),
	};
}

const api = { run };
(window as unknown as { __lms: typeof api }).__lms = api;
