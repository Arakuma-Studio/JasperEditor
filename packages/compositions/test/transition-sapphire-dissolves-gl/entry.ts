// Browser entry of the Sapphire dissolves GL test (bundled with esbuild, run in headless Chrome by
// ../transition-sapphire-dissolves-gl.test.ts): plans transition stages of the sapphire-dissolves family exactly as
// TransitionStage does (planGpuTransition + runShaderPlan on the fx GPU host) over procedural sides and reports
// pixels / timings.
import '../gl-poison.ts';
import {
	planGpuTransition,
	TRANSITION_FAMILIES,
	type TransitionSides,
	type TransitionSpec,
	type TrSide,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';

type Px = [number, number, number, number];

const SPECS: readonly TransitionSpec[] =
	TRANSITION_FAMILIES.find((f) => f.file === 'sapphire-dissolves')?.transitions ?? [];

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	paint?.(c.getContext('2d')!);
	return c;
}

/** Side pictures: 'a' = dark red with a white disc (highlight) in the middle, 'b' = blue with a yellow bar. */
function picture(kind: string, w: number, h: number): HTMLCanvasElement {
	return canvas(w, h, (ctx) => {
		if (kind === 'a') {
			ctx.fillStyle = 'rgb(160, 20, 20)';
			ctx.fillRect(0, 0, w, h);
			ctx.fillStyle = '#fff';
			ctx.beginPath();
			ctx.arc(w / 2, h / 2, h / 8, 0, Math.PI * 2);
			ctx.fill();
		} else if (kind === 'b') {
			ctx.fillStyle = 'rgb(20, 40, 170)';
			ctx.fillRect(0, 0, w, h);
			ctx.fillStyle = 'rgb(240, 220, 40)';
			ctx.fillRect(0, (h * 3) / 4, w, h / 8);
		} else if (kind === 'stripes' || kind === 'stripes2') {
			// Vertical colour stripes (period 12 px); 'stripes2' is the same picture moved 4 px to the right.
			const off = kind === 'stripes2' ? 4 : 0;
			for (let x = -12; x < w + 12; x += 12) {
				ctx.fillStyle = 'rgb(230, 200, 40)';
				ctx.fillRect(x + off, 0, 6, h);
				ctx.fillStyle = 'rgb(30, 60, 140)';
				ctx.fillRect(x + off + 6, 0, 6, h);
			}
		} else if (kind === 'halves') {
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, w / 2, h);
			ctx.fillStyle = '#000';
			ctx.fillRect(w / 2, 0, w / 2, h);
		} else {
			ctx.fillStyle = kind;
			ctx.fillRect(0, 0, w, h);
		}
	});
}

export type RunArgs = {
	id: string;
	params?: Record<string, unknown>;
	/** Frame inside the span and the span length (progress = (frame + 1) / (duration + 1) two-sided). */
	frame: number;
	duration: number;
	sides?: TransitionSides;
	a?: string;
	b?: string;
	width?: number;
	height?: number;
	probes?: [number, number][];
};

function render(args: RunArgs): { data: Uint8ClampedArray; W: number; H: number } {
	const spec = SPECS.find((s) => s.id === args.id || s.label === args.id);
	if (!spec) throw new Error(`unknown ${args.id}`);
	const W = args.width ?? 96;
	const H = args.height ?? 54;
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const sides = args.sides ?? 'both';
	const mk = (kind: string) => {
		const c = picture(kind, W, H);
		return {
			c,
			side: { width: W, height: H, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 } as TrSide,
		};
	};
	const pics = {
		out: sides === 'in' ? null : mk(args.a ?? 'a'),
		in: sides === 'out' ? null : mk(args.b ?? 'b'),
	};
	const params = {
		...Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
		...(args.params ?? {}),
	};
	const staged = planGpuTransition(
		spec,
		{ id: 'trn_sd', params: params as never, frame: args.frame, duration: args.duration, sides },
		{ width: W, height: H, fps: 30 },
		{ out: pics.out?.side ?? null, in: pics.in?.side ?? null },
	);
	const tex = (s: 'out' | 'in' | null) => {
		const p = s ? pics[s] : null;
		return p ? { source: p.c, width: W, height: H, version: `${s}-${args.a}-${args.b}` } : null;
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
	return { data: out.getContext('2d')!.getImageData(0, 0, W, H).data, W, H };
}

function run(args: RunArgs) {
	const { data, W, H } = render(args);
	let checksum = 0;
	for (let i = 0; i < data.length; i += 7) checksum = (checksum * 31 + data[i]!) % 1000000007;
	const probes = (args.probes ?? [[W / 2, H / 2]]).map(
		([x, y]) =>
			Array.from(
				data.slice((Math.floor(y) * W + Math.floor(x)) * 4, (Math.floor(y) * W + Math.floor(x)) * 4 + 4),
			) as Px,
	);
	let sum = [0, 0, 0, 0];
	for (let i = 0; i < data.length; i += 4) sum = sum.map((v, k) => v + data[i + k]!);
	const mean = sum.map((v) => v / (W * H)) as Px;
	return { probes, checksum, mean };
}

const api = {
	ids: () => SPECS.map((s) => s.id),
	run,
	/** Mean absolute difference (0..255, all channels) between two renders. */
	compare(a: RunArgs, b: RunArgs) {
		const x = render(a).data;
		const y = render(b).data;
		let d = 0;
		for (let i = 0; i < x.length; i++) d += Math.abs(x[i]! - y[i]!);
		return d / x.length;
	},
	/** Compile + first frame and a second frame time (ms) of every dissolve. */
	timings() {
		const out: Record<string, [number, number]> = {};
		for (const s of SPECS) {
			const t0 = performance.now();
			run({ id: s.id, frame: 5, duration: 11 });
			const t1 = performance.now();
			run({ id: s.id, frame: 6, duration: 11 });
			const t2 = performance.now();
			out[s.label] = [Math.round(t1 - t0), Math.round(t2 - t1)];
		}
		return out;
	},
};

(window as unknown as { __sd: typeof api }).__sd = api;
