// Browser entry of the Sapphire Render family GL test (fx-sapphire-render-gl.test.ts): runs the family's effects on
// the real GPU host (src/fx/host.ts) over a picture (a photo data URL, a solid or a transparent canvas) and returns
// pixels or PNG data URLs. Pattern of test/fx-gl/entry.ts.
import '../gl-poison.ts';
import {
	defaultEffectRegistry,
	type EffectSpec,
	FX_FAMILIES,
	fxBuiltinUniforms,
	fxSeed,
	gpuPadding,
	planGpuEffect,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Paint = { kind: 'image'; key: string } | { kind: 'solid'; color: string } | { kind: 'none' };
export type RunOpts = {
	id: string;
	params?: Record<string, unknown>;
	width: number;
	height: number;
	frame?: number;
	seed?: number;
	paint: Paint;
};

const images = new Map<string, HTMLImageElement>();

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
	if (o.paint.kind === 'image') ictx.drawImage(images.get(o.paint.key)!, b.x, b.y, b.w, b.h);
	else if (o.paint.kind === 'solid') {
		ictx.fillStyle = o.paint.color;
		ictx.fillRect(b.x, b.y, b.w, b.h);
	}
	const out = canvas(layout.width, layout.height);
	const t0 = performance.now();
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
	h.gl.finish();
	return { out, layout, plan, ms: performance.now() - t0 };
}

const api = {
	async loadImage([key, url]: [string, string]) {
		const img = new Image();
		img.src = url;
		await img.decode();
		images.set(key, img);
		return [img.naturalWidth, img.naturalHeight];
	},
	/** The effect output as a PNG data URL (composited over black) and timing. */
	png(o: RunOpts) {
		const { out, ms } = run(o);
		const c = canvas(out.width, out.height);
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, c.width, c.height);
		ctx.drawImage(out, 0, 0);
		return { url: c.toDataURL('image/png'), ms };
	},
	/** Pixels at layer-box coordinates (premultiplied canvas readback = straight RGBA). */
	pixels(o: RunOpts & { at: [number, number][] }) {
		const { out, layout } = run(o);
		const ctx = out.getContext('2d')!;
		return {
			canvas: [layout.width, layout.height],
			box: [layout.box.x, layout.box.y, layout.box.w, layout.box.h],
			px: o.at.map(
				([x, y]) =>
					Array.from(
						ctx.getImageData(Math.floor(layout.box.x + x), Math.floor(layout.box.y + y), 1, 1).data,
					) as Px,
			),
		};
	},
	/** Whole output as a flat RGBA array digest (determinism checks) + mean luma/alpha in the box. */
	stats(o: RunOpts) {
		const { out, layout } = run(o);
		const d = out.getContext('2d')!.getImageData(0, 0, out.width, out.height).data;
		let h = 0x811c9dc5;
		let luma = 0;
		let alpha = 0;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			for (let k = 0; k < 4; k++) h = Math.imul(h ^ d[i + k]!, 0x01000193);
			const x = (i / 4) % out.width;
			const y = Math.floor(i / 4 / out.width);
			const b = layout.box;
			if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
				luma += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
				alpha += d[i + 3]!;
				n++;
			}
		}
		return { hash: h >>> 0, luma: luma / n, alpha: alpha / n, canvas: [out.width, out.height] };
	},
	ids() {
		return FX_FAMILIES.find((f) => f.file === 'sapphire-render-textures')!.effects.map((s) => s.id);
	},
};

(window as unknown as { __srt: typeof api }).__srt = api;
