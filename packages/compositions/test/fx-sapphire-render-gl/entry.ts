import {
	defaultEffectRegistry,
	type EffectSpec,
	fxBuiltinUniforms,
	fxSeed,
	gpuPadding,
	planGpuEffect,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Paint = { kind: 'solid'; color: string } | { kind: 'none' };
export type RunOpts = {
	id: string;
	params?: Record<string, unknown>;
	width: number;
	height: number;
	frame?: number;
	seed?: number;
	paint: Paint;
};

function spec(id: string): EffectSpec {
	const s = defaultEffectRegistry.get(id);
	if (!s) throw new Error(`unknown effect ${id}`);
	return s;
}

function canvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

function run(o: RunOpts) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = spec(o.id);
	const params = {
		...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
		...(o.params ?? {}),
	} as never;
	const box = { width: o.width, height: o.height };
	const padding = gpuPadding(s, params, { ...box, pxScale: 1, fps: 30 });
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = o.frame ?? 0;
	// as the host: u_seed = hash(clip, effect instance, Seed param)
	const seed = o.seed ?? fxSeed('clip1', 'fx1', params);
	const plan = planGpuEffect(
		s,
		{ id: 'fx1', params },
		{ ...box, pxScale: layout.pxScale, fps: 30, frame, duration: 150, seed, progress: 0 },
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height);
	const ictx = input.getContext('2d')!;
	const b = layout.box;
	if (o.paint.kind === 'solid') {
		ictx.fillStyle = o.paint.color;
		ictx.fillRect(b.x, b.y, b.w, b.h);
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
					duration: 150,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: {} as never,
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	return { out, layout };
}

const api = {
	/** Pixels at layer-box coordinates (premultiplied canvas readback = straight RGBA). */
	pixels(o: RunOpts & { at: [number, number][] }) {
		const { out, layout } = run(o);
		const ctx = out.getContext('2d')!;
		return {
			px: o.at.map(
				([x, y]) =>
					Array.from(
						ctx.getImageData(Math.floor(layout.box.x + x), Math.floor(layout.box.y + y), 1, 1).data,
					) as Px,
			),
		};
	},
	/** Whole output as a flat RGBA array digest (determinism checks) + mean alpha in the box. */
	stats(o: RunOpts) {
		const { out, layout } = run(o);
		const d = out.getContext('2d')!.getImageData(0, 0, out.width, out.height).data;
		let h = 0x811c9dc5;
		let alpha = 0;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			for (let k = 0; k < 4; k++) h = Math.imul(h ^ d[i + k]!, 0x01000193);
			const x = (i / 4) % out.width;
			const y = Math.floor(i / 4 / out.width);
			const b = layout.box;
			if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
				alpha += d[i + 3]!;
				n++;
			}
		}
		return { hash: h >>> 0, alpha: alpha / n };
	},
};

(window as unknown as { __srt: typeof api }).__srt = api;
