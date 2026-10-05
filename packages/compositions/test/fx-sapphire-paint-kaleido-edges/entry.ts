// Browser entry of the "sapphire-paint-kaleido-edges" GL test (bundled with esbuild, run in headless Chrome by
// ../fx-sapphire-paint-kaleido-edges-gl.test.ts): runs the family's registered effects through the real GPU host on
// synthetic pictures (or a loaded image) and reports pixels / PNGs.
import { defaultEffectRegistry, type EffectSpec, fxBuiltinUniforms, fxSeed, planGpuEffect } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Box = { x: number; y: number; w: number; h: number };

export type Pattern = 'split' | 'ramp' | 'shapes' | 'alphaSquare' | 'flat' | 'checker' | `image:${string}`;

const images = new Map<string, HTMLImageElement>();

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d')!;
	paint?.(ctx);
	return c;
}

function paintPattern(ctx: CanvasRenderingContext2D, b: Box, pattern: Pattern) {
	if (pattern.startsWith('image:')) {
		const img = images.get(pattern.slice(6));
		if (!img) throw new Error(`image ${pattern} not loaded`);
		ctx.drawImage(img, b.x, b.y, b.w, b.h);
		return;
	}
	switch (pattern) {
		case 'split':
			ctx.fillStyle = '#000';
			ctx.fillRect(b.x, b.y, b.w / 2, b.h);
			ctx.fillStyle = '#fff';
			ctx.fillRect(b.x + b.w / 2, b.y, b.w / 2, b.h);
			break;
		case 'ramp': {
			const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
			g.addColorStop(0, '#000');
			g.addColorStop(1, '#fff');
			ctx.fillStyle = g;
			ctx.fillRect(b.x, b.y, b.w, b.h);
			break;
		}
		case 'shapes':
			ctx.fillStyle = 'rgb(40, 60, 160)';
			ctx.fillRect(b.x, b.y, b.w, b.h);
			ctx.fillStyle = 'rgb(230, 60, 40)';
			ctx.fillRect(b.x + b.w * 0.15, b.y + b.h * 0.2, b.w * 0.3, b.h * 0.5);
			ctx.fillStyle = 'rgb(250, 220, 60)';
			ctx.beginPath();
			ctx.arc(b.x + b.w * 0.7, b.y + b.h * 0.5, b.h * 0.25, 0, Math.PI * 2);
			ctx.fill();
			break;
		case 'alphaSquare':
			ctx.fillStyle = '#fff';
			ctx.fillRect(b.x + b.w / 4, b.y + b.h / 4, b.w / 2, b.h / 2);
			break;
		case 'flat':
			ctx.fillStyle = 'rgb(128, 128, 128)';
			ctx.fillRect(b.x, b.y, b.w, b.h);
			break;
		case 'checker': {
			const n = 8;
			for (let j = 0; j < n; j++)
				for (let i = 0; i < n; i++) {
					ctx.fillStyle = (i + j) % 2 ? 'rgb(220, 80, 40)' : 'rgb(30, 120, 200)';
					ctx.fillRect(b.x + (i * b.w) / n, b.y + (j * b.h) / n, b.w / n + 1, b.h / n + 1);
				}
			break;
		}
	}
}

const spec = (id: string): EffectSpec => {
	const s = defaultEffectRegistry.get(id);
	if (!s?.gpu) throw new Error(`no GPU effect ${id}`);
	return s;
};

const withDefaults = (s: EffectSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});

export type RunOptions = {
	width?: number;
	height?: number;
	pattern?: Pattern;
	frame?: number;
	/** Clip id behind u_seed (with the effect instance and the Seed param, as in the app). */
	clipId?: string;
};

function run(id: string, over: Record<string, unknown>, o: RunOptions = {}) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = spec(id);
	const params = withDefaults(s, over);
	const box = { width: o.width ?? 64, height: o.height ?? 48 };
	const pad = s.gpu?.padding?.(params as never, { ...box, pxScale: 1, fps: 30 }) ?? 0;
	const padding =
		typeof pad === 'number'
			? { left: pad, top: pad, right: pad, bottom: pad }
			: { left: 0, top: 0, right: 0, bottom: 0, ...pad };
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = o.frame ?? 0;
	const seed = fxSeed(o.clipId ?? 'clip1', 'fx1', params as never);
	const plan = planGpuEffect(
		s,
		{ id: 'fx1', params: params as never },
		{
			width: box.width,
			height: box.height,
			pxScale: layout.pxScale,
			fps: 30,
			frame,
			duration: 300,
			seed,
			progress: 0,
		},
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) =>
		paintPattern(ctx, layout.box, o.pattern ?? 'shapes'),
	);
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
					duration: 300,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: Object.fromEntries(plan.textures.map((t) => [t.uniform, null])) as never,
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	return { out, input, layout, plan };
}

const pixel = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;

const api = {
	async loadImage(name: string, url: string) {
		const img = new Image();
		img.src = url;
		await img.decode();
		images.set(name, img);
		return { width: img.naturalWidth, height: img.naturalHeight };
	},

	ids(): string[] {
		return defaultEffectRegistry
			.list()
			.filter((s) => s.id.startsWith('jasper.s.') && s.gpu)
			.map((s) => s.id);
	},

	/** Pixels at layer-box-relative points (x, y in layer px). */
	probe(id: string, over: Record<string, unknown>, o: RunOptions, points: [number, number][]) {
		const { out, layout } = run(id, over, o);
		const b = layout.box;
		return {
			canvas: [layout.width, layout.height],
			box: [b.x, b.y, b.w, b.h],
			pixels: points.map(([x, y]) => pixel(out, b.x + x, b.y + y)),
		};
	},

	/** Mean absolute difference (0..255) between the output and the input over the layer box. */
	diffFromInput(id: string, over: Record<string, unknown>, o: RunOptions) {
		const { out, input, layout } = run(id, over, o);
		const b = layout.box;
		const a = out.getContext('2d')!.getImageData(b.x, b.y, b.w, b.h).data;
		const c = input.getContext('2d')!.getImageData(b.x, b.y, b.w, b.h).data;
		let d = 0;
		for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - c[i]!);
		return d / a.length;
	},

	/** A hash of the whole output (determinism checks). */
	signature(id: string, over: Record<string, unknown>, o: RunOptions) {
		const { out } = run(id, over, o);
		const d = out.getContext('2d')!.getImageData(0, 0, out.width, out.height).data;
		let h = 0x811c9dc5;
		for (let i = 0; i < d.length; i++) {
			h ^= d[i]!;
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	},

	/** The output as a PNG data URL (visual checks). */
	png(id: string, over: Record<string, unknown>, o: RunOptions) {
		const t0 = performance.now();
		const { out } = run(id, over, o);
		return { url: out.toDataURL('image/png'), ms: performance.now() - t0 };
	},
};

(window as unknown as { __pke: typeof api }).__pke = api;
