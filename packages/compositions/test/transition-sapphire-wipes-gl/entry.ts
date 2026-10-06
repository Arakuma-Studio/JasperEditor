// Browser entry of the Sapphire wipes GL test (bundled with esbuild, run in headless Chrome by
// ../transition-sapphire-wipes-gl.test.ts): runs S_Wipe* stages on the real fx GPU host (planGpuTransition +
// runShaderPlan, as transition-gl/entry.ts) with A = solid red and B = solid blue, at an exact progress (Start = End),
// and reports pixels / the share of the frame showing B.
import {
	planGpuTransition,
	TRANSITION_FAMILIES,
	type TransitionSides,
	type TransitionSpec,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';

type Px = [number, number, number, number];
const W = 128;
const H = 72;
const WIPES = TRANSITION_FAMILIES.find((f) => f.file === 'sapphire-wipes-other')!.transitions;

function canvas(w: number, h: number, color?: string): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	if (color) {
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, w, h);
	}
	return c;
}
const side = (c: HTMLCanvasElement) => ({
	c,
	side: { width: c.width, height: c.height, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 },
});
const spec = (label: string): TransitionSpec => {
	const s = WIPES.find((x) => x.label === label);
	if (!s) throw new Error(`no ${label}`);
	return s;
};

/** The stage at exact progress p (Start = End = p) with params over the defaults. */
function render(
	label: string,
	p: number,
	over: Record<string, unknown> = {},
	opts: { frame?: number; sides?: TransitionSides } = {},
): HTMLCanvasElement {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = spec(label);
	const params = {
		...Object.fromEntries(s.params.map((q) => [q.name, q.default])),
		startPercent: p * 100,
		endPercent: p * 100,
		...over,
	};
	const sides = opts.sides ?? 'both';
	const pics = {
		out: sides === 'in' ? null : side(canvas(W, H, 'rgb(255, 0, 0)')),
		in: sides === 'out' ? null : side(canvas(W, H, 'rgb(0, 0, 255)')),
	};
	const staged = planGpuTransition(
		s,
		{ id: 'trn_wipe', params: params as never, frame: opts.frame ?? 4, duration: 10, sides },
		{ width: W, height: H, fps: 30 },
		{ out: pics.out?.side ?? null, in: pics.in?.side ?? null },
	);
	const tex = (k: 'out' | 'in' | null) => {
		const q = k ? pics[k] : null;
		return q ? { source: q.c, width: W, height: H, version: k! } : null;
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

const data = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, W, H).data;
const pxOf = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;
/** Share of the frame that is (mostly) B. */
const shareB = (c: HTMLCanvasElement) => {
	const d = data(c);
	let n = 0;
	for (let i = 0; i < d.length; i += 4) if (d[i + 2]! > d[i]!) n++;
	return n / (W * H);
};
const hash = (c: HTMLCanvasElement) => {
	const d = data(c);
	let h = 2166136261;
	for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i]!, 16777619);
	return h >>> 0;
};

const api = {
	info: () => ({ webgl2: !!fxHost(), labels: WIPES.map((s) => s.label) }),
	/** B share of every wipe at progress 0.2 / 0.5 / 0.8 (defaults). */
	shares() {
		const r: Record<string, number[]> = {};
		for (const s of WIPES) r[s.label] = [0.2, 0.5, 0.8].map((p) => shareB(render(s.label, p)));
		return r;
	},
	/** One pixel of a wipe at progress p. */
	pixel(label: string, p: number, x: number, y: number, over: Record<string, unknown> = {}) {
		return pxOf(render(label, p, over), x * W, y * H);
	},
	share(label: string, p: number, over: Record<string, unknown> = {}) {
		return shareB(render(label, p, over));
	},
	/** Pixel hash (determinism / seed checks). */
	hash(label: string, p: number, over: Record<string, unknown> = {}, frame = 4) {
		return hash(render(label, p, over, { frame }));
	},
	/** One-sided (fade at the head of B): the A side is transparent. */
	oneSided(label: string, p: number, x: number, y: number) {
		return pxOf(render(label, p, {}, { sides: 'in' }), x * W, y * H);
	},
};

(window as unknown as { __sw: typeof api }).__sw = api;
