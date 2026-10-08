// Browser entry of the sapphire-textures-clouds GL test (bundled with esbuild, run in headless Chrome by
// ../fx-sapphire-textures-clouds-gl.test.ts): runs the family's generators through the real GPU host
// (src/fx/host.ts) at a given frame and seed, and reports pixel statistics / PNGs.
import '../gl-poison.ts';
import { type EffectSpec, FX_FAMILIES, fxBuiltinUniforms, fxSeed, planGpuEffect } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
const SAPPHIRE_TEXTURES_CLOUDS_EFFECTS =
	FX_FAMILIES.find((f) => f.file === 'sapphire-textures-clouds')?.effects ?? [];
type Opts = {
	width?: number;
	height?: number;
	frame?: number;
	/** Clip id behind `u_seed` (`fxSeed(clip, 'fx1', params)`, as in the compositions; default 'clip1'). */
	clip?: string;
	/** Input picture: an opaque colour (CSS), 'transparent', or 'half' (left half opaque grey, right transparent). */
	input?: string;
};

const spec = (id: string): EffectSpec => {
	const s = SAPPHIRE_TEXTURES_CLOUDS_EFFECTS.find((e) => e.id === id);
	if (!s) throw new Error(`unknown effect ${id}`);
	return s;
};
const defaults = (s: EffectSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});

function canvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

function run(id: string, over: Record<string, unknown>, o: Opts = {}): HTMLCanvasElement {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = spec(id);
	const params = defaults(s, over);
	const box = { width: o.width ?? 160, height: o.height ?? 90 };
	const frame = o.frame ?? 0;
	const seed = fxSeed(o.clip ?? 'clip1', 'fx1', params as never);
	const layout = fxCanvasLayout(box, { left: 0, top: 0, right: 0, bottom: 0 }, 8192);
	const plan = planGpuEffect(
		s,
		{ id: 'fx1', params: params as never },
		{ ...box, pxScale: layout.pxScale, fps: 30, frame, duration: 300, seed, progress: 0 },
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height);
	const ctx = input.getContext('2d')!;
	const fill = o.input ?? '#808080';
	if (fill === 'half') {
		ctx.fillStyle = '#808080';
		ctx.fillRect(0, 0, Math.floor(layout.width / 2), layout.height);
	} else if (fill !== 'transparent') {
		ctx.fillStyle = fill;
		ctx.fillRect(0, 0, layout.width, layout.height);
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
					duration: 300,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: {},
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	return out;
}

function stats(c: HTMLCanvasElement) {
	const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
	const n = d.length / 4;
	let sum = 0;
	let sq = 0;
	let alpha = 0;
	let hash = 2166136261;
	const chroma = [0, 0, 0];
	for (let i = 0; i < d.length; i += 4) {
		const l = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
		sum += l;
		sq += l * l;
		alpha += d[i + 3]!;
		for (let k = 0; k < 3; k++) chroma[k]! += d[i + k]!;
		hash = Math.imul(hash ^ (d[i]! ^ (d[i + 1]! << 8) ^ (d[i + 2]! << 16)), 16777619) >>> 0;
	}
	const mean = sum / n;
	return {
		mean,
		std: Math.sqrt(Math.max(0, sq / n - mean * mean)),
		alpha: alpha / n,
		rgb: chroma.map((v) => v / n),
		hash,
	};
}

/** Mean absolute difference of two canvases (0..255). */
function diff(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
	const x = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data;
	const y = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data;
	let s = 0;
	for (let i = 0; i < x.length; i++) if (i % 4 !== 3) s += Math.abs(x[i]! - y[i]!);
	return s / ((x.length / 4) * 3);
}

const px = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;

const api = {
	ids: () => SAPPHIRE_TEXTURES_CLOUDS_EFFECTS.map((s) => s.id),
	/** Every family effect with default params at a small size, frames 0 and 45; errors by id. */
	catalogue() {
		const errors: string[] = [];
		for (const s of SAPPHIRE_TEXTURES_CLOUDS_EFFECTS)
			for (const frame of [0, 45])
				try {
					run(s.id, {}, { width: 64, height: 36, frame });
				} catch (e) {
					errors.push(`${s.id}@${frame}: ${(e as Error).message}`);
				}
		return errors;
	},
	stats: (id: string, over: Record<string, unknown> = {}, o: Opts = {}) => stats(run(id, over, o)),
	diff: (id: string, a: [Record<string, unknown>, Opts], b: [Record<string, unknown>, Opts]) =>
		diff(run(id, a[0], a[1]), run(id, b[0], b[1])),
	pixel: (id: string, over: Record<string, unknown>, o: Opts, x: number, y: number) =>
		px(run(id, over, o), x, y),
	png: (id: string, over: Record<string, unknown> = {}, o: Opts = {}) =>
		run(id, over, o).toDataURL('image/png'),
};

(window as unknown as { __stc: typeof api }).__stc = api;
