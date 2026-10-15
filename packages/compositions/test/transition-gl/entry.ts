import {
	planGpuTransition,
	TRANSITION_FAMILIES,
	TRANSITION_SPECS,
	type TransitionSides,
	type TransitionSpec,
	type TrSide,
} from '@jasper/project';
import { meanGrid } from '@jasper/testkit/image';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { TEST_TRANSITIONS } from '../transition-examples.ts';

type Px = [number, number, number, number];
type CatalogueCase = { family?: string; id: string };
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
const full = (
	c: HTMLCanvasElement,
	compToCanvas = IDENTITY,
	opacity = 1,
): { c: HTMLCanvasElement; side: TrSide } => ({
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
		/** Pictures of image params by media id (as TransitionStage binds them). */
		media?: Record<string, HTMLCanvasElement>;
		tracks?: Parameters<typeof planGpuTransition>[1]['tracks'];
	},
) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const pics = { out: opts.out ?? null, in: opts.in ?? null };
	const staged = planGpuTransition(
		spec,
		{
			id: 'trn_test',
			params: params as never,
			frame: opts.frame,
			duration: opts.duration,
			sides: opts.sides ?? 'both',
			tracks: opts.tracks,
		},
		{ width: W, height: H, fps: 30 },
		{ out: pics.out?.side ?? null, in: pics.in?.side ?? null },
	);
	const tex = (s: 'out' | 'in' | null) => {
		const p = s ? pics[s] : null;
		return p ? { source: p.c, width: p.c.width, height: p.c.height, version: `${s}${p.c.width}` } : null;
	};
	const out = canvas(W, H);
	const textures: Record<
		string,
		{ source: HTMLCanvasElement; width: number; height: number; version: string } | null
	> = { u_trFrom: tex(staged.fromSide), u_trTo: tex(staged.toSide) };
	for (const m of staged.plan.textures) {
		if (m.uniform === 'u_trFrom' || m.uniform === 'u_trTo') continue;
		const c = m.mediaId ? opts.media?.[m.mediaId] : undefined;
		textures[m.uniform] = c ? { source: c, width: c.width, height: c.height, version: m.mediaId } : null;
	}
	runShaderPlan(
		h,
		staged.plan,
		canvas(1, 1),
		{
			builtins: staged.builtins,
			textures,
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	return out;
}

const cardA = () =>
	canvas(W, H, (ctx) => {
		const g = ctx.createLinearGradient(0, 0, W, 0);
		g.addColorStop(0, '#b21f1f');
		g.addColorStop(1, '#fdbb2d');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);
		ctx.fillStyle = '#fff';
		ctx.beginPath();
		ctx.arc(W * 0.3, H * 0.5, H * 0.3, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = '#111';
		ctx.fillRect(W * 0.7, 0, W * 0.08, H);
	});
const cardB = () =>
	canvas(W, H, (ctx) => {
		const g = ctx.createLinearGradient(0, 0, 0, H);
		g.addColorStop(0, '#1a2a6c');
		g.addColorStop(1, '#22c1c3');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);
		ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
		for (let y = 0; y < H; y += 6) for (let x = (y / 6) % 2 ? 6 : 0; x < W; x += 12) ctx.fillRect(x, y, 6, 6);
	});
const fingerprintOf = (c: HTMLCanvasElement) =>
	meanGrid(
		{
			width: c.width,
			height: c.height,
			data: new Uint8Array(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.buffer),
		},
		4,
	);

const spec = (id: string) => TRANSITION_SPECS.find((s) => s.id === id)!;

/** Select one transition from the same family/test catalogue used by the original render sequence. */
function specOf({ family, id }: CatalogueCase): TransitionSpec {
	const fam = TRANSITION_FAMILIES.find((f) => f.file === family);
	if (family && !fam) throw new Error(`unknown transition family ${family}`);
	const inFamily = new Set(TRANSITION_FAMILIES.flatMap((f) => f.transitions.map((s) => s.id)));
	const specs = fam
		? fam.transitions.filter((s) => s.gpu)
		: [...TRANSITION_SPECS.filter((s) => s.gpu && !inFamily.has(s.id)), ...TEST_TRANSITIONS];
	const selected = specs.find((s) => s.id === id);
	if (!selected) throw new Error(`unknown GPU transition ${id}`);
	return selected;
}

const api = {
	catalogue(selection: CatalogueCase) {
		const s = specOf(selection);
		const errors: string[] = [];
		const a = () => full(solid('#c84'));
		const b = () => full(solid('#48c'));
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
				if (name === 'mid' && px(out, W / 2, H / 2)[3] === 0)
					errors.push(`${s.id} ${name}: transparent centre`);
			} catch (e) {
				errors.push(`${s.id} ${name}: ${(e as Error).message}`);
			}
		}
		return { errors };
	},

	/**
	 * Golden fingerprints (FilmCraft's transition fingerprints): one GPU transition at its defaults,
	 * two-sided over the golden cards, at p = 0.25 / 0.5 / 0.75 (frames 5 / 10 / 15 of 20) → 4×4 mean RGB, compared
	 * with goldens/transition-fingerprints.json (±4 levels) by transition-gl.test.ts.
	 */
	fingerprints(selection: CatalogueCase) {
		const s = specOf(selection);
		const out: Record<string, number[]> = {};
		for (const [p, frame] of [
			['0.25', 5],
			['0.5', 10],
			['0.75', 15],
		] as const) {
			out[`${s.id}@${p}`] = fingerprintOf(
				run(s, defaults(s), { frame, duration: 20, out: full(cardA()), in: full(cardB()) }),
			);
		}
		return out;
	},

	/** Ends of a two-sided transition: start ≈ A, end ≈ B (Start 0 % / End 100 % around the linear ramp). */
	ends(selection: CatalogueCase) {
		const s = specOf(selection);
		const p = defaults(s, { startPercent: 0, endPercent: 0 });
		const q = defaults(s, { startPercent: 100, endPercent: 100 });
		const first = run(s, p, { frame: 0, duration: 10, out: full(solid('red')), in: full(solid('blue')) });
		const last = run(s, q, { frame: 0, duration: 10, out: full(solid('red')), in: full(solid('blue')) });
		return { [s.id]: { first: px(first, W / 2, H / 2), last: px(last, W / 2, H / 2) } };
	},

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
		const out = run(s, defaults(s, { blurLuma: 0 }), {
			frame: 4,
			duration: 9,
			out: full(a),
			in: full(solid('#0f0')),
		});
		return { white: px(out, 8, 18), black: px(out, 56, 18) };
	},
};

const polish = {
	/** Gradient Wipe at p ≈ 0.5: built-in Left to Right vs a Custom Gradient (white left half, black right half). */
	gradientImage() {
		const s = spec('jasper.gradient-wipe');
		const halves = canvas(W, H, (ctx) => {
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, W / 2, H);
			ctx.fillStyle = '#000';
			ctx.fillRect(W / 2, 0, W / 2, H);
		});
		const o = {
			frame: 4,
			duration: 9,
			out: full(solid('red')),
			in: full(solid('blue')),
			media: { med_g: halves },
		};
		const plain = run(s, defaults(s), o);
		const custom = run(s, defaults(s, { gradientImage: { mediaId: 'med_g' } }), o);
		// Bound to a media id that has no picture (missing / loading): the built-in gradient.
		const missing = run(s, defaults(s, { gradientImage: { mediaId: 'med_missing' } }), o);
		const vr = spec('jasper.vr-gradient-wipe');
		const vrCustom = run(vr, defaults(vr, { gradientImage: { mediaId: 'med_g' } }), o);
		return {
			plain: [px(plain, 8, 18), px(plain, 56, 18)],
			custom: [px(custom, 8, 18), px(custom, 56, 18)],
			missing: [px(missing, 8, 18), px(missing, 56, 18)],
			vrCustom: [px(vrCustom, 8, 18), px(vrCustom, 56, 18)],
		};
	},

	/** Push North to South with a 4 px white border at progress 0 / 1: only A / only B, no band at either edge. */
	pushBorder() {
		const s = spec('jasper.push');
		const p = { direction: 'northToSouth', borderWidth: 4, borderColor: [1, 1, 1, 1] };
		const o = { frame: 0, duration: 10, out: full(solid('red')), in: full(solid('blue')) };
		const first = run(s, defaults(s, { ...p, startPercent: 0, endPercent: 0 }), o);
		const last = run(s, defaults(s, { ...p, startPercent: 100, endPercent: 100 }), o);
		const mid = run(s, defaults(s, { ...p, startPercent: 50, endPercent: 50 }), o);
		const col = (c: HTMLCanvasElement) => Array.from({ length: H }, (_, y) => px(c, W / 2, y));
		return { first: col(first), last: col(last), mid: col(mid) };
	},

	/** S_MochaWhip at p = 0.9 with a planar track of B (a quad around the centre) vs no track / Track Mode Off. */
	mochaTrack() {
		const s = spec('jasper.s.mocha-whip');
		const quad: [number, number][] = [
			[24, 12],
			[40, 12],
			[40, 24],
			[24, 24],
		];
		const frame = {
			kind: 'planar' as const,
			corners: quad,
			point: [32, 18] as [number, number],
			confidence: 1,
			tracked: true,
		};
		const tracks = { in: { trackerId: 'tkr_1', name: 'T', kind: 'planar' as const, frames: [frame, frame] } };
		const green = canvas(W, H, (ctx) => {
			ctx.fillStyle = '#00f';
			ctx.fillRect(0, 0, W, H);
			ctx.fillStyle = '#0f0';
			ctx.fillRect(24, 12, 16, 12);
		});
		const o = { frame: 0, duration: 2, out: full(solid('red')), in: full(green) };
		const at = { startPercent: 70, endPercent: 70 };
		const none = run(s, defaults(s, at), o);
		const tracked = run(s, defaults(s, at), { ...o, tracks });
		const off = run(s, defaults(s, { ...at, trackMode: 'off' }), { ...o, tracks });
		const all = (c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(0, 0, W, H).data);
		const a = all(none);
		const diff = all(tracked).reduce((n, v, i) => n + (Math.abs(v - a[i]!) > 8 ? 1 : 0), 0);
		const diffOff = all(off).reduce((n, v, i) => n + (Math.abs(v - a[i]!) > 8 ? 1 : 0), 0);
		const end = run(s, defaults(s, { startPercent: 100, endPercent: 100 }), { ...o, tracks });
		return { diff, diffOff, endCentre: px(end, 32, 18), endCorner: px(end, 2, 2) };
	},

	/** Push with Custom Completion at the middle frame: 0 % = A, 100 % = B; off = the linear ramp. */
	completion() {
		const s = spec('jasper.push');
		const o = { frame: 4, duration: 9, out: full(solid('red')), in: full(solid('blue')) };
		const at = (c: Record<string, unknown>) => px(run(s, defaults(s, c), o), W / 2, H / 2);
		return {
			zero: at({ useCompletion: true, completion: 0 }),
			full: at({ useCompletion: true, completion: 100 }),
			offLeft: px(run(s, defaults(s, { completion: 0 }), o), 8, 18),
			offRight: px(run(s, defaults(s, { completion: 0 }), o), 56, 18),
		};
	},
};

(window as unknown as { __tr: typeof api & typeof polish }).__tr = { ...api, ...polish };
