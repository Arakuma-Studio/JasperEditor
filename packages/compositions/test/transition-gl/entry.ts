// Browser entry of the transition GL test (bundled with esbuild, run in headless Chrome by ../transition-gl.test.ts):
// drives the real fx GPU host with planned transition stages (planGpuTransition + runShaderPlan, exactly what
// TransitionStage does) and reports pixels. Compiles the whole transition GLSL library and runs EVERY registered GPU
// transition (wave-3 families get this check for free) two-sided, one-sided and reversed.
import {
	defineShaderTransition,
	GLSL_LIBRARY,
	GLSL_TR_LIBRARY,
	planGpuTransition,
	TRANSITION_BINS,
	TRANSITION_SPECS,
	type TransitionSides,
	type TransitionSpec,
	type TrSide,
} from '@jasper/project';
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
const px = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;
const solid = (color: string, w = W, h = H) =>
	canvas(w, h, (ctx) => {
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, w, h);
	});
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const full = (c: HTMLCanvasElement, compToCanvas = IDENTITY, opacity = 1): { c: HTMLCanvasElement; side: TrSide } => ({
	c,
	side: { width: c.width, height: c.height, compToCanvas, opacity },
});
const defaults = (spec: TransitionSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
	...over,
});

/** One stage frame: `frame` of a `duration`-frame transition with the given side pictures. */
function run(
	spec: TransitionSpec,
	params: Record<string, unknown>,
	opts: {
		frame: number;
		duration: number;
		sides?: TransitionSides;
		out?: { c: HTMLCanvasElement; side: TrSide } | null;
		in?: { c: HTMLCanvasElement; side: TrSide } | null;
	},
) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const pics = { out: opts.out ?? null, in: opts.in ?? null };
	const staged = planGpuTransition(
		spec,
		{ id: 'trn_test', params: params as never, frame: opts.frame, duration: opts.duration, sides: opts.sides ?? 'both' },
		{ width: W, height: H, fps: 30 },
		{ out: pics.out?.side ?? null, in: pics.in?.side ?? null },
	);
	const tex = (s: 'out' | 'in' | null) => {
		const p = s ? pics[s] : null;
		return p ? { source: p.c, width: p.c.width, height: p.c.height, version: `${s}${p.c.width}` } : null;
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
	return out;
}

const spec = (id: string) => TRANSITION_SPECS.find((s) => s.id === id)!;

const api = {
	info() {
		return { webgl2: !!fxHost() };
	},

	library() {
		const lib = defineShaderTransition({
			id: 'test.tr-library',
			label: 'Library',
			bin: TRANSITION_BINS.dissolve,
			description: 'Compiles every chunk.',
			options: { border: true, antiAliasing: true, center: true },
			gpu: {
				passes: [
					{
						include: [...GLSL_LIBRARY, ...GLSL_TR_LIBRARY],
						frag: /* glsl */ `
void main() {
  float p = tr_easeInOut(tr_phase(tr_progress(), 0.1, 0.9)) + tr_easeInOutSine(0.3) * 0.0 + tr_easeInOutExpo(0.2) * 0.0 + tr_smoother(0.5) * 0.0;
  vec2 c = u_center * u_compSize;
  float d = tr_linearWipe(tr_px(), vec2(1.0, 0.0), p, 2.0) + tr_circle(tr_px(), c, 3.0) * 0.0
    + tr_clockWipe(tr_px(), c, p, 0.0) * 0.0 + tr_boxDist(tr_px(), c, vec2(4.0)) * 0.0 + tr_irisRadius(c, p, 1.0) * 0.0;
  vec3 card = tr_card(v_uv, 0.3, 0, 2.0, 1.0) + tr_card(v_uv, 0.3, 1, 2.0, 1.0) * 0.0;
  ivec2 cell = tr_cell(v_uv, tr_squareGrid(8.0));
  float r = tr_cellRandom(cell, u_seed) * 0.0 + tr_stagger(p, 0.5, 0.2) * 0.0 + tr_cellUv(v_uv, vec2(4.0)).x * 0.0;
  vec4 a = tr_from(card.xy) * 0.0 + tr_from(v_uv);
  fragColor = tr_over(tr_premul(vec4(0.0)), tr_wipeMix(a, tr_to(v_uv), d + r, 0.0, tr_aaWidth(u_antiAliasing), u_borderWidth, u_borderColor)) + fx_luma(a.rgb) * 0.0;
}`,
					},
				],
			},
		});
		try {
			run(lib, defaults(lib), { frame: 5, duration: 10, out: full(solid('red')), in: full(solid('blue')) });
			return { ok: true };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	},

	catalogue() {
		const specs = TRANSITION_SPECS.filter((s) => s.gpu);
		const errors: string[] = [];
		const a = () => full(solid('#c84'));
		const b = () => full(solid('#48c'));
		for (const s of specs) {
			const cases: [string, Parameters<typeof run>[2], Record<string, unknown>][] = [
				['both', { frame: 0, duration: 10, out: a(), in: b() }, {}],
				['mid', { frame: 5, duration: 10, out: a(), in: b() }, {}],
				['in', { frame: 3, duration: 10, sides: 'in', in: b() }, {}],
				['out', { frame: 9, duration: 10, sides: 'out', out: a() }, {}],
				['reverse', { frame: 5, duration: 10, out: a(), in: b() }, { reverse: true }],
			];
			for (const [name, o, over] of cases) {
				try {
					const out = run(s, defaults(s, over), o);
					// Fully progressed two-sided frames are not required to match exactly, but nothing may be NaN-black
					// over an opaque frame in the middle of the transition.
					if (name === 'mid' && px(out, W / 2, H / 2)[3] === 0) errors.push(`${s.id} ${name}: transparent centre`);
				} catch (e) {
					errors.push(`${s.id} ${name}: ${(e as Error).message}`);
				}
			}
		}
		return { count: specs.length, errors };
	},

	/** Ends of a two-sided transition: start ≈ A, end ≈ B (Start 0 % / End 100 % around the linear ramp). */
	ends() {
		const out: Record<string, { first: Px; last: Px }> = {};
		for (const s of TRANSITION_SPECS.filter((x) => x.gpu)) {
			const p = defaults(s, { startPercent: 0, endPercent: 0 });
			const q = defaults(s, { startPercent: 100, endPercent: 100 });
			const first = run(s, p, { frame: 0, duration: 10, out: full(solid('red')), in: full(solid('blue')) });
			const last = run(s, q, { frame: 0, duration: 10, out: full(solid('red')), in: full(solid('blue')) });
			out[s.id] = { first: px(first, W / 2, H / 2), last: px(last, W / 2, H / 2) };
		}
		return out;
	},

	/** Placement: a 32×18 picture scaled ×2 (layer map) fills the frame; half opacity; a translated one. */
	placement() {
		const pic = canvas(32, 18, (ctx) => {
			ctx.fillStyle = 'rgb(255, 0, 0)';
			ctx.fillRect(0, 0, 16, 18);
			ctx.fillStyle = 'rgb(0, 0, 255)';
			ctx.fillRect(16, 0, 16, 18);
		});
		// comp → canvas = scale 0.5 (layer map ×2).
		const scaled = full(pic, [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1], 0.5);
		const iris = spec('jasper.iris-round');
		// Start = End = 0: the stage shows A only.
		const a = run(iris, defaults(iris, { endPercent: 0 }), { frame: 0, duration: 10, out: scaled, in: null });
		// Translated by (+40, 0) comp px: comp → canvas = x − 40 (the picture covers x 40…72).
		const moved = full(pic, [1, 0, -40, 0, 1, 0, 0, 0, 1]);
		const m = run(iris, defaults(iris, { endPercent: 0 }), { frame: 0, duration: 10, out: moved, in: null });
		return { left: px(a, 10, 18), right: px(a, 54, 18), outside: px(m, 20, 9), inside: px(m, 44, 9) };
	},

	/** S_DissolveLuma at mid: the white half of A shows B, the black half still A (both sides in one shader). */
	luma() {
		const a = canvas(W, H, (ctx) => {
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, W / 2, H);
			ctx.fillStyle = '#000';
			ctx.fillRect(W / 2, 0, W / 2, H);
		});
		const s = spec('jasper.s.dissolve-luma');
		const out = run(s, defaults(s, { blurLuma: 0 }), { frame: 4, duration: 9, out: full(a), in: full(solid('#0f0')) });
		return { white: px(out, 8, 18), black: px(out, 56, 18) };
	},
};

(window as unknown as { __tr: typeof api }).__tr = api;
