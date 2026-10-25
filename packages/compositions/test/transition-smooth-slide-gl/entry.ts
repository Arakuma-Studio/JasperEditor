// Browser entry of transition-smooth-slide-gl.test.ts: runs Smooth Slide on the fx GPU host over synthetic sides
// and returns whole frames (RGBA bytes) so the test can compare them with the CPU reference.
import { planGpuTransition, SMOOTH_SLIDE, type TransitionSides } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';

export const W = 64;
export const H = 36;

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	paint?.(c.getContext('2d')!);
	return c;
}

/**
 * Side pictures: `gradA` (R = x ramp, G = y ramp, B = 40), `gradB` (R = 40, G = y ramp, B = x ramp) — linear ramps
 * through texel centres, so bilinear sampling is the analytic ramp — `stripes` (2 px black / white rows) or a CSS colour.
 */
function picture(name: string): HTMLCanvasElement {
	return canvas(W, H, (ctx) => {
		if (name === 'gradA' || name === 'gradB') {
			const img = ctx.createImageData(W, H);
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++) {
					const o = (y * W + x) * 4;
					const rx = Math.round((255 * x) / (W - 1));
					const ry = Math.round((255 * y) / (H - 1));
					img.data[o] = name === 'gradA' ? rx : 40;
					img.data[o + 1] = ry;
					img.data[o + 2] = name === 'gradA' ? 40 : rx;
					img.data[o + 3] = 255;
				}
			ctx.putImageData(img, 0, 0);
			return;
		}
		if (name === 'stripes') {
			for (let y = 0; y < H; y += 2) {
				ctx.fillStyle = (y / 2) % 2 ? '#fff' : '#000';
				ctx.fillRect(0, y, W, 2);
			}
			return;
		}
		ctx.fillStyle = name;
		ctx.fillRect(0, 0, W, H);
	});
}

export type RunOpts = {
	params?: Record<string, unknown>;
	frame: number;
	duration: number;
	sides?: TransitionSides;
	from?: string;
	to?: string;
};

function frame(o: RunOpts): number[] {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = SMOOTH_SLIDE;
	const params = { ...Object.fromEntries(spec.params.map((p) => [p.name, p.default])), ...(o.params ?? {}) };
	const sides = o.sides ?? 'both';
	const pics = {
		out: sides !== 'in' ? picture(o.from ?? 'gradA') : null,
		in: sides !== 'out' ? picture(o.to ?? 'gradB') : null,
	};
	const side = (c: HTMLCanvasElement | null) =>
		c ? { width: c.width, height: c.height, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 } : null;
	const staged = planGpuTransition(
		spec,
		{ id: 'trn_smooth', params: params as never, frame: o.frame, duration: o.duration, sides },
		{ width: W, height: H, fps: 30 },
		{ out: side(pics.out), in: side(pics.in) },
	);
	const tex = (s: 'out' | 'in' | null) => {
		const p = s ? pics[s] : null;
		return p ? { source: p, width: p.width, height: p.height, version: `${s}${o.from}${o.to}` } : null;
	};
	const out = canvas(W, H);
	runShaderPlan(
		h,
		staged.plan,
		canvas(1, 1),
		{
			builtins: staged.builtins,
			textures: { u_trFrom: tex(staged.fromSide), u_trTo: tex(staged.toSide) },
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	return Array.from(out.getContext('2d')!.getImageData(0, 0, W, H).data);
}

const api = { frame, W, H };
(window as unknown as { __slide: typeof api }).__slide = api;
