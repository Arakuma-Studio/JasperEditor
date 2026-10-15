import { planGpuTransition, TRANSITION_SPECS, type TransitionSides, type TrSide } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';

type Px = [number, number, number, number];
const W = 64;
const H = 36;

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	paint?.(c.getContext('2d')!);
	return c;
}

function picture(name: string): HTMLCanvasElement {
	return canvas(W, H, (ctx) => {
		if (name === 'halves') {
			ctx.fillStyle = '#f00';
			ctx.fillRect(0, 0, W / 2, H);
			ctx.fillStyle = '#0f0';
			ctx.fillRect(W / 2, 0, W / 2, H);
		} else if (name === 'stripes') {
			for (let x = 0; x < W; x += 4) {
				ctx.fillStyle = (x / 4) % 2 ? '#fff' : '#000';
				ctx.fillRect(x, 0, 4, H);
			}
		} else if (name === 'checker') {
			for (let y = 0; y < H; y += 6)
				for (let x = 0; x < W; x += 6) {
					ctx.fillStyle = (x / 6 + y / 6) % 2 ? '#ff0' : '#00f';
					ctx.fillRect(x, y, 6, 6);
				}
		} else {
			ctx.fillStyle = name;
			ctx.fillRect(0, 0, W, H);
		}
	});
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const side = (c: HTMLCanvasElement): TrSide => ({
	width: c.width,
	height: c.height,
	compToCanvas: IDENTITY,
	opacity: 1,
});

export type RunOpts = {
	id: string;
	params?: Record<string, unknown>;
	frame: number;
	duration: number;
	sides?: TransitionSides;
	from?: string | null;
	to?: string | null;
	points: [number, number][];
};

function run(o: RunOpts): Px[] {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = TRANSITION_SPECS.find((s) => s.id === o.id);
	if (!spec) throw new Error(`unknown transition ${o.id}`);
	const params = { ...Object.fromEntries(spec.params.map((p) => [p.name, p.default])), ...(o.params ?? {}) };
	const sides = o.sides ?? 'both';
	const pics = {
		out: sides !== 'in' && o.from !== null ? picture(o.from ?? 'red') : null,
		in: sides !== 'out' && o.to !== null ? picture(o.to ?? 'blue') : null,
	};
	const staged = planGpuTransition(
		spec,
		{ id: 'trn_sso', params: params as never, frame: o.frame, duration: o.duration, sides },
		{ width: W, height: H, fps: 30 },
		{ out: pics.out ? side(pics.out) : null, in: pics.in ? side(pics.in) : null },
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
	const ctx = out.getContext('2d')!;
	return o.points.map(
		([x, y]) => Array.from(ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px,
	);
}

function frame(o: Omit<RunOpts, 'points'>): number[] {
	const pts: [number, number][] = [];
	for (let y = 1; y < H; y += 3) for (let x = 1; x < W; x += 3) pts.push([x, y]);
	return run({ ...o, points: pts }).flat();
}

const api = {
	run,
	frame,
};

(window as unknown as { __sso: typeof api }).__sso = api;
