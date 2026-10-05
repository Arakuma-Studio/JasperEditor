// Browser entry of the Premiere Adjust/Color/Keying family GL tests (fx-premiere-adjust-color-keying-gl.test.ts) and
// of the contact-sheet script (fx-pacg/shots.ts): drives the real GPU host (src/fx/host.ts) with one family effect on
// a picture (a test image or a painted pattern) and returns pixels or a PNG. Same `run` contract as fx-gl/entry.ts.
import { defaultEffectRegistry, type EffectSpec, fxBuiltinUniforms, planGpuEffect } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Paint = (ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }) => void;

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d', { willReadFrequently: true })!;
	paint?.(ctx);
	return c;
}

const images = new Map<string, HTMLImageElement>();
async function image(url: string): Promise<HTMLImageElement> {
	const hit = images.get(url);
	if (hit) return hit;
	const img = new Image();
	img.src = url;
	await img.decode();
	images.set(url, img);
	return img;
}

const spec = (id: string): EffectSpec => {
	const s = defaultEffectRegistry.get(id);
	if (!s?.gpu) throw new Error(`no gpu effect ${id}`);
	return s;
};

const withDefaults = (s: EffectSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});

/** A painted pattern (named) or an image (data URL) filling the layer box. */
export type Picture =
	| { kind: 'image'; url: string }
	| { kind: 'solid'; color: string }
	| { kind: 'ramp'; from?: string; to?: string }
	| { kind: 'split'; left: string; right: string }
	| { kind: 'bars' }
	| { kind: 'disc'; color?: string }
	| { kind: 'text'; text: string; color?: string };

async function painter(pic: Picture): Promise<Paint> {
	switch (pic.kind) {
		case 'image': {
			const img = await image(pic.url);
			return (ctx, b) => ctx.drawImage(img, b.x, b.y, b.w, b.h);
		}
		case 'solid':
			return (ctx, b) => {
				ctx.fillStyle = pic.color;
				ctx.fillRect(b.x, b.y, b.w, b.h);
			};
		case 'ramp':
			return (ctx, b) => {
				const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
				g.addColorStop(0, pic.from ?? '#000');
				g.addColorStop(1, pic.to ?? '#fff');
				ctx.fillStyle = g;
				ctx.fillRect(b.x, b.y, b.w, b.h);
			};
		case 'split':
			return (ctx, b) => {
				ctx.fillStyle = pic.left;
				ctx.fillRect(b.x, b.y, b.w / 2, b.h);
				ctx.fillStyle = pic.right;
				ctx.fillRect(b.x + b.w / 2, b.y, b.w / 2, b.h);
			};
		case 'bars':
			return (ctx, b) => {
				const cols = ['#fff', '#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f', '#000'];
				cols.forEach((c, i) => {
					ctx.fillStyle = c;
					ctx.fillRect(b.x + (b.w * i) / cols.length, b.y, Math.ceil(b.w / cols.length), b.h);
				});
			};
		case 'text':
			return (ctx, b) => {
				ctx.fillStyle = pic.color ?? '#e8b030';
				ctx.font = `bold ${Math.round(b.h * 0.45)}px sans-serif`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(pic.text, b.x + b.w / 2, b.y + b.h / 2, b.w * 0.95);
			};
		case 'disc':
			return (ctx, b) => {
				ctx.fillStyle = pic.color ?? '#fff';
				ctx.beginPath();
				ctx.arc(b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) * 0.3, 0, Math.PI * 2);
				ctx.fill();
			};
	}
}

async function textureOf(pic: Picture, w: number, h: number) {
	const paint = await painter(pic);
	const c = canvas(w, h, (ctx) => paint(ctx, { x: 0, y: 0, w, h }));
	return { source: c, width: w, height: h, version: JSON.stringify(pic) };
}

export type RunRequest = {
	id: string;
	params?: Record<string, unknown>;
	picture: Picture;
	box: { width: number; height: number };
	/** Media params: param name → picture (drawn at `size` or the box size). */
	media?: Record<string, Picture & { size?: [number, number] }>;
	frame?: number;
	/** Background behind the result in PNGs (checkerboard shows transparency). */
	background?: 'checker' | 'black' | 'none';
};

async function run(req: RunRequest) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = spec(req.id);
	const params = withDefaults(s, req.params);
	const box = req.box;
	const pad = s.gpu?.padding?.(params as never, { ...box, pxScale: 1, fps: 30 }) ?? 0;
	const padding =
		typeof pad === 'number'
			? { left: pad, top: pad, right: pad, bottom: pad }
			: { left: 0, top: 0, right: 0, bottom: 0, ...pad };
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = req.frame ?? 0;
	const plan = planGpuEffect(
		s,
		{ id: 'fx1', params: params as never },
		{
			width: box.width,
			height: box.height,
			pxScale: layout.pxScale,
			fps: 30,
			frame,
			duration: 30,
			seed: 0.25,
			progress: 0,
		},
		{ width: layout.width, height: layout.height },
	);
	const paint = await painter(req.picture);
	const input = canvas(layout.width, layout.height, (ctx) => paint(ctx, layout.box));
	const out = canvas(layout.width, layout.height);
	const textures: Record<string, unknown> = {};
	for (const t of plan.textures) {
		const m = req.media?.[t.param];
		textures[t.uniform] = m ? await textureOf(m, m.size?.[0] ?? box.width, m.size?.[1] ?? box.height) : null;
	}
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
					duration: 30,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [0.25] },
			],
			textures: textures as never,
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	const ms = performance.now() - t0;
	return { out, layout, plan, ms };
}

const api = {
	/** Pixels at layer-px positions (relative to the layer box; may be outside it, into the padding). */
	async pixels(req: RunRequest, at: [number, number][]) {
		const { out, layout } = await run(req);
		const ctx = out.getContext('2d')!;
		return {
			canvas: [layout.width, layout.height],
			pixels: at.map(
				([x, y]) =>
					Array.from(
						ctx.getImageData(Math.floor(layout.box.x + x), Math.floor(layout.box.y + y), 1, 1).data,
					) as Px,
			),
		};
	},
	/** The result as a PNG data URL over a checkerboard/black background, scaled to `maxWidth`. */
	async png(req: RunRequest, maxWidth = 480) {
		const { out, layout, ms } = await run(req);
		const scale = Math.min(1, maxWidth / layout.width);
		const w = Math.round(layout.width * scale);
		const hh = Math.round(layout.height * scale);
		const c = canvas(w, hh, (ctx) => {
			if (req.background !== 'none') {
				const sq = 8;
				for (let y = 0; y < hh; y += sq)
					for (let x = 0; x < w; x += sq) {
						ctx.fillStyle = req.background === 'black' ? '#000' : ((x + y) / sq) % 2 === 0 ? '#bbb' : '#777';
						ctx.fillRect(x, y, sq, sq);
					}
			}
			ctx.drawImage(out, 0, 0, w, hh);
		});
		return { url: c.toDataURL('image/png'), ms };
	},
};

(window as unknown as { __pacg: typeof api }).__pacg = api;
