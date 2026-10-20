import { defaultEffectRegistry, type EffectSpec, fxBuiltinUniforms, planGpuEffect } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Box = { x: number; y: number; w: number; h: number };

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d')!;
	paint?.(ctx);
	return c;
}

const px = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;

const specOf = (id: string): EffectSpec => {
	const s = defaultEffectRegistry.get(id);
	if (!s) throw new Error(`unknown effect ${id}`);
	return s;
};

const defaults = (spec: EffectSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
	...over,
});

const SCENES: Record<string, (ctx: CanvasRenderingContext2D, b: Box) => void> = {
	/** Night scene: dark gradient, bright coloured point lights, shapes, a white bar and a skin-tone face. */
	night(ctx, b) {
		const g = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
		g.addColorStop(0, '#101830');
		g.addColorStop(1, '#302010');
		ctx.fillStyle = g;
		ctx.fillRect(b.x, b.y, b.w, b.h);
		const s = b.w / 64;
		const lights = ['#ffffff', '#ffd080', '#80c0ff', '#ff8080', '#a0ffa0'];
		for (let i = 0; i < 18; i++) {
			const x = b.x + b.w * (((i * 37) % 97) / 97);
			const y = b.y + b.h * (0.1 + 0.35 * (((i * 53) % 89) / 89));
			ctx.fillStyle = lights[i % lights.length]!;
			ctx.beginPath();
			ctx.arc(x, y, Math.max(0.6, s * 0.35), 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.fillStyle = '#d04040';
		ctx.fillRect(b.x + b.w * 0.08, b.y + b.h * 0.62, b.w * 0.18, b.h * 0.28);
		ctx.fillStyle = '#3070e0';
		ctx.fillRect(b.x + b.w * 0.3, b.y + b.h * 0.7, b.w * 0.14, b.h * 0.2);
		ctx.fillStyle = '#f0f0f0';
		ctx.fillRect(b.x + b.w * 0.48, b.y + b.h * 0.55, b.w * 0.012, b.h * 0.4);
		ctx.fillStyle = '#c8906c';
		ctx.beginPath();
		ctx.ellipse(b.x + b.w * 0.75, b.y + b.h * 0.72, b.w * 0.09, b.h * 0.2, 0, 0, Math.PI * 2);
		ctx.fill();
	},
	/** Left half white, right half black (edges, sharpen, blur profiles). */
	edge(ctx, b) {
		ctx.fillStyle = '#000';
		ctx.fillRect(b.x, b.y, b.w, b.h);
		ctx.fillStyle = '#fff';
		ctx.fillRect(b.x, b.y, b.w / 2, b.h);
	},
	/** One bright dot in the middle of black (point-spread functions: bokeh shapes). */
	dot(ctx, b) {
		ctx.fillStyle = '#000';
		ctx.fillRect(b.x, b.y, b.w, b.h);
		ctx.fillStyle = '#fff';
		ctx.fillRect(b.x + Math.floor(b.w / 2) - 1, b.y + Math.floor(b.h / 2) - 1, 2, 2);
	},
	/** A horizontal grey ramp quantised to 12 bands (banding). */
	bands(ctx, b) {
		for (let i = 0; i < 12; i++) {
			const v = Math.round(60 + i * 3);
			ctx.fillStyle = `rgb(${v},${v},${v + 4})`;
			ctx.fillRect(b.x + (b.w * i) / 12, b.y, Math.ceil(b.w / 12) + 1, b.h);
		}
	},
	flat(ctx, b) {
		ctx.fillStyle = '#c84';
		ctx.fillRect(b.x, b.y, b.w, b.h);
	},
	/** Salt-and-pepper noise on grey (median). */
	speckle(ctx, b) {
		ctx.fillStyle = '#808080';
		ctx.fillRect(b.x, b.y, b.w, b.h);
		for (let i = 0; i < (b.w * b.h) / 40; i++) {
			const x = b.x + ((i * 7919) % Math.floor(b.w));
			const y = b.y + ((i * 104729) % Math.floor(b.h));
			ctx.fillStyle = i % 2 ? '#fff' : '#000';
			ctx.fillRect(Math.floor(x), Math.floor(y), 1, 1);
		}
	},
	empty() {},
	/** Skin-tone left half, blue right half (Beauty's skin key). */
	skin(ctx, b) {
		ctx.fillStyle = '#c8906c';
		ctx.fillRect(b.x, b.y, b.w / 2, b.h);
		ctx.fillStyle = '#2050c0';
		ctx.fillRect(b.x + b.w / 2, b.y, b.w / 2, b.h);
	},
};

const MEDIA: Record<string, (w: number, h: number) => HTMLCanvasElement> = {
	/** Depth: near (white) bottom half, far (black) top half. */
	depthSplit: (w, h) =>
		canvas(w, h, (ctx) => {
			ctx.fillStyle = '#000';
			ctx.fillRect(0, 0, w, h);
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, h / 2, w, h / 2);
		}),
	/** A white disc kernel on black. */
	disc: (w, h) =>
		canvas(w, h, (ctx) => {
			ctx.fillStyle = '#000';
			ctx.fillRect(0, 0, w, h);
			ctx.fillStyle = '#fff';
			ctx.beginPath();
			ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.04, 0, Math.PI * 2);
			ctx.fill();
		}),
};

export type RunOptions = {
	effectId: string;
	params?: Record<string, unknown>;
	width: number;
	height: number;
	/** A scene name of SCENES. */
	scene: string;
	/** Media params: param name → MEDIA name. */
	media?: Record<string, string>;
	frame?: number;
	/** Pixels to read (layer px, relative to the layer box). */
	probes?: [number, number][];
	/** Pixels to read in canvas px. */
	canvasProbes?: [number, number][];
	seed?: number;
};

function run(o: RunOptions) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = specOf(o.effectId);
	const params = defaults(spec, o.params);
	const box = { width: o.width, height: o.height };
	const pad = spec.gpu?.padding?.(params as never, { ...box, pxScale: 1, fps: 30 }) ?? 0;
	const padding =
		typeof pad === 'number'
			? { left: pad, top: pad, right: pad, bottom: pad }
			: { left: 0, top: 0, right: 0, bottom: 0, ...pad };
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = o.frame ?? 0;
	const seed = o.seed ?? 0.25;
	const textures: Record<string, unknown> = {};
	for (const p of spec.params.filter((x) => x.type === 'media')) {
		const m = o.media?.[p.name];
		if (!m) {
			textures[`u_${p.name}`] = null;
			continue;
		}
		const src = MEDIA[m]?.(o.width, o.height);
		if (!src) throw new Error(`unknown media ${m}`);
		textures[`u_${p.name}`] = { source: src, width: src.width, height: src.height, version: m.slice(0, 64) };
		(params as Record<string, unknown>)[p.name] = { mediaId: `m-${p.name}` };
	}
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: params as never },
		{
			width: box.width,
			height: box.height,
			pxScale: layout.pxScale,
			fps: 30,
			frame,
			duration: 60,
			seed,
			progress: 0,
		},
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => {
		const b = layout.box;
		(SCENES[o.scene] ?? SCENES.flat!)(ctx, b);
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
	const b = layout.box;
	return {
		box: [b.x, b.y, b.w, b.h],
		probes: (o.probes ?? []).map(([x, y]) => px(out, b.x + x, b.y + y)),
		canvasProbes: (o.canvasProbes ?? []).map(([x, y]) => px(out, x, y)),
	};
}

const api = { run };
(window as unknown as { __sbs: typeof api }).__sbs = api;
