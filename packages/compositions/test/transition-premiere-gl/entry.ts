// Browser entry of the Premiere transition family GL test (bundled with esbuild, run in headless Chrome by
// ../transition-premiere-gl.test.ts): drives the real fx GPU host with planned transition stages (planGpuTransition
// + runShaderPlan, as test/transition-gl/entry.ts does) and reports characteristic pixels of each Premiere transition
// at a fixed progress (Start = End = the progress), Reverse, borders, one-sided use and determinism.
import {
	planGpuTransition,
	TRANSITION_SPECS,
	type TransitionSides,
	type TransitionSpec,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';

type Px = [number, number, number, number];
let W = 64;
let H = 36;

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	paint?.(c.getContext('2d')!);
	return c;
}
const px = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;
const solid = (color: string) =>
	canvas(W, H, (ctx) => {
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, W, H);
	});
/** Left half `left`, right half `right`. */
const halves = (left: string, right: string) =>
	canvas(W, H, (ctx) => {
		ctx.fillStyle = left;
		ctx.fillRect(0, 0, W / 2, H);
		ctx.fillStyle = right;
		ctx.fillRect(W / 2, 0, W / 2, H);
	});
const spec = (id: string) => {
	const s = TRANSITION_SPECS.find((x) => x.id === id);
	if (!s) throw new Error(`no transition ${id}`);
	return s;
};
const defaults = (s: TransitionSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});

type RunOpts = {
	/** Progress in % (Start = End). */
	at: number;
	params?: Record<string, unknown>;
	a?: HTMLCanvasElement | null;
	b?: HTMLCanvasElement | null;
	sides?: TransitionSides;
	id?: string;
};

/** One stage frame of transition `id` at a fixed progress. */
function run(id: string, o: RunOpts): HTMLCanvasElement {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = spec(id);
	const params = defaults(s, { ...o.params, startPercent: o.at, endPercent: o.at });
	const sides = o.sides ?? 'both';
	const a = sides === 'in' ? null : o.a === undefined ? solid('#f00') : o.a;
	const b = sides === 'out' ? null : o.b === undefined ? solid('#00f') : o.b;
	const side = (c: HTMLCanvasElement | null) =>
		c ? { width: c.width, height: c.height, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 } : null;
	const staged = planGpuTransition(
		s,
		{ id: o.id ?? 'trn_premiere', params: params as never, frame: 0, duration: 10, sides },
		{ width: W, height: H, fps: 30 },
		{ out: side(a), in: side(b) },
	);
	const pics = { out: a, in: b };
	const tex = (k: 'out' | 'in' | null) => {
		const c = k ? pics[k] : null;
		return c ? { source: c, width: c.width, height: c.height, version: `${k}-${Math.random()}` } : null;
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
const at = (id: string, o: RunOpts, x: number, y: number) => px(run(id, o), x, y);

/** Fraction of the pixels closer to B's blue than to A's red, and a digest of the picture. */
function stats(c: HTMLCanvasElement) {
	const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
	let blue = 0;
	let hash = 0;
	for (let i = 0; i < d.length; i += 4) {
		if (d[i + 2]! > d[i]!) blue++;
		hash = (Math.imul(hash, 31) + d[i]! * 3 + d[i + 2]!) | 0;
	}
	return { blue: blue / (d.length / 4), hash };
}

const api = {
	seq(ids: string) {
		const r: unknown[] = [];
		for (const spec of ids.split(',')) {
			const [id, inst] = spec.split('@');
			const t0 = performance.now();
			run(id!, { at: 50, ...(inst ? { id: inst } : {}) });
			r.push(id, Math.round(performance.now() - t0));
		}
		return r;
	},
	dbg3(mode: string) {
		const r: unknown[] = [];
		for (const id of ['jasper.wipe', 'jasper.inset', 'jasper.barn-doors']) {
			const c = run(id, { at: 50 });
			if (mode === 'full') r.push(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.length);
			if (mode === 'one') r.push(px(c, 3, 3));
			if (mode === 'stats') r.push(stats(c));
		}
		return r;
	},
	async dbg2() {
		const r: unknown[] = [];
		for (const id of [
			'jasper.random-blocks',
			'jasper.paint-splatter',
			'jasper.random-wipe',
			'jasper.burn-alpha',
			'jasper.burn-chroma',
			'jasper.grunge-transition',
			'jasper.chaos',
			'jasper.block-motion',
			'jasper.vr-random-blocks',
		]) {
			for (const inst of ['trn_premiere', 'trn_premiere', 'trn_other']) {
				console.log('run', id, inst);
				await new Promise((res) => setTimeout(res, 0));
				const t0 = performance.now();
				const c = run(id, { at: 50, id: inst });
				console.log('ran', id, inst, performance.now() - t0);
				await new Promise((res) => setTimeout(res, 0));
				r.push(id, performance.now() - t0, stats(c));
				console.log('stats', id, inst);
			}
		}
		return r;
	},
	dbg1() {
		const t0 = performance.now();
		const c = run('jasper.random-blocks', { at: 50 });
		const t1 = performance.now();
		const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.length;
		const t2 = performance.now();
		const s = stats(c);
		return [t1 - t0, t2 - t1, performance.now() - t2, d, s];
	},
	/** ASCII map (B = incoming, A = outgoing, x = other) of a frame (probe scripts): "id|progress|{params}". */
	map(arg: string) {
		const [id, pc, json] = arg.split('|');
		const c = run(id!, { at: Number(pc), params: json ? JSON.parse(json) : {} });
		const rows: string[] = [];
		for (let y = 1; y < H; y += 3) {
			let r = '';
			for (let x = 1; x < W; x += 2) {
				const v = px(c, x, y);
				r += v[2] > 200 && v[0] < 60 ? 'B' : v[0] > 200 && v[2] < 60 ? 'A' : v[3] < 20 ? '.' : 'x';
			}
			rows.push(r);
		}
		return rows.join('\n');
	},
	/** Ids of the family (probe scripts). */
	ids() {
		return TRANSITION_SPECS.filter((x) => x.gpu && !x.id.startsWith('jasper.s.')).map((x) => x.id);
	},
	/** One transition at a progress (probe scripts). */
	one(id: string, p = 50, inst?: string) {
		const t0 = performance.now();
		run(id, { at: p, ...(inst ? { id: inst } : {}) });
		return Math.round(performance.now() - t0);
	},
	/** Run time (ms) of each Premiere-family transition for a few frames (compile included on the first). */
	timings() {
		const out: Record<string, number> = {};
		for (const s of TRANSITION_SPECS.filter((x) => x.gpu && !x.id.startsWith('jasper.s.'))) {
			const t0 = performance.now();
			for (const p of [0, 50, 100]) run(s.id, { at: p });
			out[s.id] = Math.round(performance.now() - t0);
			console.log(`timing ${s.id} ${out[s.id]}`);
		}
		return out;
	},

	/** Characteristic pixels: [observed, …] per check name. */
	pixels() {
		const r: Record<string, Px> = {};
		const greenBlue = () => halves('#0f0', '#00f');
		// Wipe
		r.wipeLeft = at('jasper.wipe', { at: 50 }, 8, 18);
		r.wipeRight = at('jasper.wipe', { at: 50 }, 56, 18);
		r.wipeDiagNW = at('jasper.wipe', { at: 50, params: { direction: 'northWestToSouthEast' } }, 4, 4);
		r.wipeDiagSE = at('jasper.wipe', { at: 50, params: { direction: 'northWestToSouthEast' } }, 60, 32);
		r.wipeBorder = at(
			'jasper.wipe',
			{ at: 50, params: { borderWidth: 6, borderColor: [1, 1, 1, 1] } },
			29,
			18,
		);
		r.wipeReverseRight = at('jasper.wipe', { at: 25, params: { reverse: true } }, 60, 18);
		r.wipeReverseLeft = at('jasper.wipe', { at: 25, params: { reverse: true } }, 8, 18);
		r.wipeInLeft = at('jasper.wipe', { at: 50, sides: 'in' }, 8, 18);
		r.wipeInRight = at('jasper.wipe', { at: 50, sides: 'in' }, 56, 18);
		// Band Wipe (2 bands: the top one from the west, the bottom one from the east)
		const band = { at: 30, params: { bands: 2 } };
		r.bandTopW = at('jasper.band-wipe', band, 4, 9);
		r.bandTopE = at('jasper.band-wipe', band, 60, 9);
		r.bandBottomE = at('jasper.band-wipe', band, 60, 27);
		r.bandBottomW = at('jasper.band-wipe', band, 4, 27);
		// Barn Doors
		r.barnCenter = at('jasper.barn-doors', { at: 50 }, 32, 18);
		r.barnEdge = at('jasper.barn-doors', { at: 50 }, 2, 18);
		r.barnVertCenter = at('jasper.barn-doors', { at: 50, params: { direction: 'vertical' } }, 2, 18);
		r.barnVertEdge = at('jasper.barn-doors', { at: 50, params: { direction: 'vertical' } }, 32, 1);
		// Venetian Blinds (2 bands, north to south)
		const vb = { at: 50, params: { bands: 2 } };
		r.blindsTop1 = at('jasper.venetian-blinds', vb, 32, 2);
		r.blindsBottom1 = at('jasper.venetian-blinds', vb, 32, 15);
		r.blindsTop2 = at('jasper.venetian-blinds', vb, 32, 20);
		// CheckerBoard at 50 %: exactly a checkerboard (8 × 8 cells of 8 × 4.5 px)
		r.boardEven = at('jasper.checkerboard', { at: 50 }, 4, 2);
		r.boardOdd = at('jasper.checkerboard', { at: 50 }, 12, 2);
		r.boardOdd2 = at('jasper.checkerboard', { at: 50 }, 4, 6.5);
		// Checker Wipe: the first column of even squares is done before the odd ones start
		r.checkerEven = at('jasper.checker-wipe', { at: 12 }, 7, 2);
		r.checkerOdd = at('jasper.checker-wipe', { at: 12 }, 7, 6.5);
		r.checkerFar = at('jasper.checker-wipe', { at: 12 }, 60, 2);
		// Clock Wipe at 25 %: the top right quadrant
		r.clockTR = at('jasper.clock-wipe', { at: 25 }, 48, 9);
		r.clockTL = at('jasper.clock-wipe', { at: 25 }, 16, 9);
		r.clockReverseTL = at('jasper.clock-wipe', { at: 25, params: { reverse: true } }, 16, 9);
		r.clockReverseTR = at('jasper.clock-wipe', { at: 25, params: { reverse: true } }, 48, 9);
		// Wedge Wipe at 50 %: the top half
		r.wedgeTop = at('jasper.wedge-wipe', { at: 50 }, 32, 6);
		r.wedgeBottom = at('jasper.wedge-wipe', { at: 50 }, 32, 30);
		// Pinwheel (4 wedges) at 50 %: half of each quadrant from 12 o'clock clockwise
		r.pinIn = at('jasper.pinwheel', { at: 50, params: { wedges: 4 } }, 36.1, 6.7);
		r.pinOut = at('jasper.pinwheel', { at: 50, params: { wedges: 4 } }, 43.3, 13.9);
		// Radial Wipe from the north west corner at 50 %
		r.radialTop = at('jasper.radial-wipe', { at: 50 }, 60, 4);
		r.radialLeft = at('jasper.radial-wipe', { at: 50 }, 4, 32);
		// Inset from the north west corner at 50 %
		r.insetIn = at('jasper.inset', { at: 50 }, 8, 5);
		r.insetOut = at('jasper.inset', { at: 50 }, 56, 30);
		r.insetSE = at('jasper.inset', { at: 50, params: { direction: 'southEast' } }, 56, 30);
		// Spiral Boxes / Zig-Zag Blocks at 10 %: the first cells (top left) only
		r.spiralFirst = at('jasper.spiral-boxes', { at: 10 }, 4, 3);
		r.spiralCenter = at('jasper.spiral-boxes', { at: 10 }, 32, 18);
		r.spiralSecondRing = at('jasper.spiral-boxes', { at: 90 }, 12, 9);
		r.spiralInnerLate = at('jasper.spiral-boxes', { at: 90 }, 32, 18);
		r.zigFirst = at('jasper.zig-zag-blocks', { at: 10 }, 4, 3);
		r.zigLast = at('jasper.zig-zag-blocks', { at: 10 }, 60, 33);
		r.zigRow2End = at('jasper.zig-zag-blocks', { at: 22 }, 60, 9);
		r.zigRow2Start = at('jasper.zig-zag-blocks', { at: 22 }, 4, 9);
		// Random Wipe (north to south) at 40 %: the top is B, the bottom A
		r.randomWipeTop = at('jasper.random-wipe', { at: 40 }, 32, 1);
		r.randomWipeBottom = at('jasper.random-wipe', { at: 40 }, 32, 35);
		// Gradient Wipe
		r.gradLeft = at('jasper.gradient-wipe', { at: 50, params: { softness: 0 } }, 8, 18);
		r.gradRight = at('jasper.gradient-wipe', { at: 50, params: { softness: 0 } }, 56, 18);
		r.gradInvert = at('jasper.gradient-wipe', { at: 50, params: { softness: 0, invert: true } }, 8, 18);
		const bw = halves('#fff', '#000');
		r.gradLumaDark = at(
			'jasper.gradient-wipe',
			{ at: 50, a: bw, params: { gradient: 'outgoingLuma' } },
			56,
			18,
		);
		r.gradLumaBright = at(
			'jasper.gradient-wipe',
			{ at: 50, a: bw, params: { gradient: 'outgoingLuma' } },
			8,
			18,
		);
		// Irises at 40 %
		r.boxIn = at('jasper.iris-box', { at: 40 }, 42, 23);
		r.boxOut = at('jasper.iris-box', { at: 40 }, 32, 27);
		r.diamondIn = at('jasper.iris-diamond', { at: 40 }, 52, 18);
		r.diamondOut = at('jasper.iris-diamond', { at: 40 }, 44, 26);
		r.crossArmH = at('jasper.iris-cross', { at: 40 }, 52, 18);
		r.crossArmV = at('jasper.iris-cross', { at: 40 }, 32, 30);
		r.crossBetween = at('jasper.iris-cross', { at: 40 }, 44, 28);
		r.boxCenterOff = at('jasper.iris-box', { at: 30, params: { center: [0.2, 0.3] } }, 13, 11);
		r.boxCenterOffFar = at('jasper.iris-box', { at: 30, params: { center: [0.2, 0.3] } }, 50, 30);
		// 3D Motion
		r.cubeLeft = at('jasper.cube-spin', { at: 50 }, 8, 18);
		r.cubeRight = at('jasper.cube-spin', { at: 50 }, 56, 18);
		r.cubeNSTop = at('jasper.cube-spin', { at: 50, params: { direction: 'northToSouth' } }, 32, 4);
		r.cubeNSBottom = at('jasper.cube-spin', { at: 50, params: { direction: 'northToSouth' } }, 32, 32);
		r.flipEarly = at('jasper.flip-over', { at: 25 }, 32, 18);
		r.flipLate = at('jasper.flip-over', { at: 75 }, 32, 18);
		r.flipMid = at('jasper.flip-over', { at: 50 }, 32, 18);
		r.flipBandsLate = at('jasper.flip-over', { at: 75, params: { bands: 4 } }, 8, 18);
		// Page Peel / Page Turn from the north west corner at 30 %
		r.peelCorner = at('jasper.page-peel', { at: 30 }, 2, 2);
		r.peelFar = at('jasper.page-peel', { at: 30 }, 62, 34);
		r.turnCorner = at('jasper.page-turn', { at: 30 }, 2, 2);
		r.turnFar = at('jasper.page-turn', { at: 30 }, 62, 34);
		r.turnFlap = at('jasper.page-turn', { at: 30 }, 20, 12);
		r.turnFlapColor = at(
			'jasper.page-turn',
			{ at: 30, params: { back: 'color', backColor: [0, 1, 0, 1] } },
			20,
			12,
		);
		// Slide family at 50 % (B = green | blue halves: a sliding B shows its right half first)
		r.slideB = at('jasper.slide', { at: 50, b: greenBlue() }, 8, 18);
		r.slideA = at('jasper.slide', { at: 50, b: greenBlue() }, 56, 18);
		r.slideBorder = at(
			'jasper.slide',
			{ at: 50, params: { borderWidth: 4, borderColor: [1, 1, 1, 1] } },
			31,
			18,
		);
		const bs = { at: 50, params: { bands: 2 } };
		r.bandSlideTopW = at('jasper.band-slide', bs, 8, 9);
		r.bandSlideTopE = at('jasper.band-slide', bs, 56, 9);
		r.bandSlideBottomE = at('jasper.band-slide', bs, 56, 27);
		r.bandSlideBottomW = at('jasper.band-slide', bs, 8, 27);
		r.centerSplitCenter = at('jasper.center-split', { at: 50 }, 32, 18);
		r.centerSplitCorner = at('jasper.center-split', { at: 50 }, 2, 2);
		r.splitCenter = at('jasper.split', { at: 50 }, 32, 18);
		r.splitEdge = at('jasper.split', { at: 50 }, 2, 18);
		// Split moves A: its left half (green) ends up at the left edge
		r.splitMovesA = at('jasper.split', { at: 50, a: greenBlue() }, 2, 18);
		r.whipEarly = at('jasper.whip', { at: 3 }, 32, 18);
		r.whipLate = at('jasper.whip', { at: 97 }, 32, 18);
		// Dissolves at 50 % / 25 %
		r.additive = at('jasper.additive-dissolve', { at: 50 }, 32, 18);
		r.dipWhite = at('jasper.dip-to-white', { at: 50 }, 32, 18);
		r.dipWhiteQuarter = at('jasper.dip-to-white', { at: 25 }, 32, 18);
		r.film = at('jasper.film-dissolve', { at: 50 }, 32, 18);
		r.nonAdditive = at('jasper.non-additive-dissolve', { at: 25, b: solid('#0f0') }, 32, 18);
		r.nonAdditiveDark = at(
			'jasper.non-additive-dissolve',
			{ at: 75, a: solid('#0f0'), b: solid('#00f') },
			32,
			18,
		);
		return r;
	},

	/** Characteristic pixels of Premiere 26's modern transitions. */
	modernPixels() {
		const r: Record<string, Px> = {};
		r.blurDissolve = at('jasper.blur-dissolve', { at: 50 }, 32, 18);
		r.blurToColor = at('jasper.blur-to-color', { at: 50 }, 32, 18);
		r.spinbackEarly = at('jasper.3d-spinback', { at: 20, params: { blur: 0 } }, 32, 18);
		r.spinbackLate = at('jasper.3d-spinback', { at: 85, params: { blur: 0 } }, 32, 18);
		r.dipToColor = at('jasper.dip-to-color', { at: 50, params: { color: [0, 1, 0, 1] } }, 32, 18);
		r.dipToColorHold = at(
			'jasper.dip-to-color',
			{ at: 35, params: { color: [0, 1, 0, 1], hold: 40 } },
			32,
			18,
		);
		const wb = halves('#fff', '#000');
		r.lumaBright = at('jasper.luma-fade', { at: 50, a: wb, params: { softness: 0 } }, 8, 18);
		r.lumaDark = at('jasper.luma-fade', { at: 50, a: wb, params: { softness: 0 } }, 56, 18);
		const mosaic = run('jasper.mosaic-transition', { at: 30, a: halves('#0f0', '#f00') });
		r.mosaicL = px(mosaic, 8, 18);
		r.mosaicR = px(mosaic, 56, 18);
		r.roll3dLeft = at('jasper.3d-roll', { at: 50, params: { blur: 0 } }, 8, 18);
		r.roll3dRight = at('jasper.3d-roll', { at: 50, params: { blur: 0 } }, 56, 18);
		r.filmRollLine = at('jasper.film-roll', { at: 50, params: { blur: 0 } }, 32, 18);
		r.filmRollTop = at('jasper.film-roll', { at: 50, params: { blur: 0 } }, 32, 6);
		r.rollLeft = at('jasper.roll', { at: 50, params: { blur: 0 } }, 8, 18);
		r.rollRight = at('jasper.roll', { at: 50, params: { blur: 0 } }, 56, 18);
		r.stretchLeft = at('jasper.stretch-transition', { at: 50, params: { blur: 0 } }, 8, 18);
		r.stretchRight = at('jasper.stretch-transition', { at: 50, params: { blur: 0 } }, 56, 18);
		r.linearLeft = at('jasper.linear-wipe-transition', { at: 50, params: { feather: 2 } }, 8, 18);
		r.linearRight = at('jasper.linear-wipe-transition', { at: 50, params: { feather: 2 } }, 56, 18);
		r.neonLine = at('jasper.neon-wipe', { at: 50 }, 32, 18);
		r.panelTop = at('jasper.panel-wipe', { at: 50 }, 32, 2);
		r.panelBottom = at('jasper.panel-wipe', { at: 50 }, 32, 34);
		r.plateauMid = at('jasper.plateau-wipe', { at: 50 }, 32, 18);
		r.softMid = at('jasper.soft-wipe', { at: 50 }, 32, 18);
		r.starCenter = at('jasper.star-wipe', { at: 50 }, 32, 18);
		r.starCorner = at('jasper.star-wipe', { at: 30 }, 1, 1);
		r.stretchWipeLeft = at('jasper.stretch-wipe', { at: 50 }, 8, 18);
		r.stretchWipeRight = at('jasper.stretch-wipe', { at: 50 }, 56, 18);
		r.flipMotionEarly = at('jasper.flip-motion', { at: 25 }, 32, 18);
		r.flipMotionLate = at('jasper.flip-motion', { at: 75 }, 32, 18);
		r.foldLeft = at('jasper.fold-motion', { at: 50 }, 8, 18);
		r.foldRight = at('jasper.fold-motion', { at: 50 }, 56, 18);
		r.popEarlyCenter = at('jasper.pop-motion', { at: 40 }, 32, 18);
		r.popEarlyCorner = at('jasper.pop-motion', { at: 40 }, 1, 1);
		r.popLateCenter = at('jasper.pop-motion', { at: 60 }, 32, 18);
		r.popLateCorner = at('jasper.pop-motion', { at: 60 }, 1, 1);
		r.pullLeft = at('jasper.pull-motion', { at: 50, params: { blur: 0 } }, 8, 18);
		r.pullRight = at('jasper.pull-motion', { at: 50, params: { blur: 0 } }, 56, 18);
		r.spinEarly = at('jasper.spin-motion', { at: 25 }, 32, 18);
		r.spinLate = at('jasper.spin-motion', { at: 75 }, 32, 18);
		r.spinCorner = at('jasper.spin-motion', { at: 50 }, 1, 1);
		r.springOvershoot = at('jasper.spring-motion', { at: 30 }, 4, 18);
		r.springB = at('jasper.spring-motion', { at: 30 }, 32, 18);
		r.travelLeft = at('jasper.travel-motion', { at: 50, params: { blur: 0 } }, 8, 18);
		r.travelRight = at('jasper.travel-motion', { at: 50, params: { blur: 0 } }, 56, 18);
		r.tvOff = at('jasper.tv-power', { at: 50 }, 32, 9);
		r.flash = at('jasper.flash-transition', { at: 50 }, 32, 18);
		r.sweep = at('jasper.light-sweep', { at: 50 }, 32, 18);
		r.stripeMid = at('jasper.stripe', { at: 50 }, 32, 18);
		r.spin3dEarly = at('jasper.3d-spin', { at: 15, params: { blur: 0 } }, 32, 18);
		r.spin3dLate = at('jasper.3d-spin', { at: 85, params: { blur: 0 } }, 32, 18);
		r.frameB = at('jasper.frame-transition', { at: 50 }, 60, 18);
		r.frameA = at('jasper.frame-transition', { at: 50 }, 4, 18);
		r.louverTop = at('jasper.louver', { at: 50 }, 32, 1);
		r.louverBottom = at('jasper.louver', { at: 50 }, 32, 34);
		r.mirrorFlip = at('jasper.mirror-transition', { at: 30, a: halves('#0f0', '#f00') }, 8, 18);
		r.waveBehind = at('jasper.wave-transition', { at: 50 }, 8, 18);
		r.waveAhead = at('jasper.wave-transition', { at: 50 }, 56, 18);
		// VR: shapes on the sphere, per eye in stereo layouts.
		r.vrIrisCenter = at('jasper.vr-iris-wipe', { at: 50 }, 32, 18);
		r.vrIrisBehind = at('jasper.vr-iris-wipe', { at: 50 }, 1, 18);
		r.vrIrisMonoUpper = at('jasper.vr-iris-wipe', { at: 20 }, 32, 9);
		r.vrIrisStereoUpper = at('jasper.vr-iris-wipe', { at: 20, params: { layout: 'overUnder' } }, 32, 9);
		r.vrGradTop = at('jasper.vr-gradient-wipe', { at: 50, params: { softness: 0 } }, 32, 4);
		r.vrGradBottom = at('jasper.vr-gradient-wipe', { at: 50, params: { softness: 0 } }, 32, 32);
		return r;
	},

	/** Mean |difference| (0..255) of each transition at 50 % from a linear-light cross-fade, over patterned clips. */
	differs(ids: string) {
		const a = () => halves('#0f0', '#f00');
		const b = () =>
			canvas(W, H, (ctx) => {
				ctx.fillStyle = '#00f';
				ctx.fillRect(0, 0, W, H);
				ctx.fillStyle = '#ff0';
				ctx.fillRect(0, 0, W, H / 2);
			});
		const data = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, W, H).data;
		const fade = data(run('jasper.film-dissolve', { at: 50, a: a(), b: b() }));
		const out: Record<string, number> = {};
		for (const id of ids.split(',')) {
			const d = data(run(id, { at: 50, a: a(), b: b() }));
			let sum = 0;
			for (let i = 0; i < d.length; i += 4)
				sum +=
					Math.abs(d[i]! - fade[i]!) +
					Math.abs(d[i + 1]! - fade[i + 1]!) +
					Math.abs(d[i + 2]! - fade[i + 2]!);
			out[id] = sum / (d.length / 4) / 3;
		}
		return out;
	},

	/** Random transitions: same seed → same picture, other instance → other picture; coverage near the progress. */
	random() {
		const out: Record<string, { blue: number; same: boolean; differs: boolean }> = {};
		for (const id of [
			'jasper.random-blocks',
			'jasper.paint-splatter',
			'jasper.random-wipe',
			'jasper.burn-alpha',
			'jasper.burn-chroma',
			'jasper.grunge-transition',
			'jasper.chaos',
			'jasper.block-motion',
			'jasper.vr-random-blocks',
		]) {
			console.log('a', id);
			const a = stats(run(id, { at: 50 }));
			console.log('b', id);
			const b = stats(run(id, { at: 50 }));
			console.log('c', id);
			const c = stats(run(id, { at: 50, id: 'trn_other' }));
			out[id] = { blue: a.blue, same: a.hash === b.hash, differs: a.hash !== c.hash };
		}
		return out;
	},

	/** Morph Cut over a moving square: the mid frame shows one square half-way, not two half-faded ones. */
	morph() {
		const [w0, h0] = [W, H];
		W = 256;
		H = 144;
		const sq = (x: number) =>
			canvas(W, H, (ctx) => {
				ctx.fillStyle = '#000';
				ctx.fillRect(0, 0, W, H);
				ctx.fillStyle = '#fff';
				ctx.fillRect(x, 48, 48, 48);
			});
		try {
			const o = { at: 50, a: sq(96), b: sq(112) };
			const m = run('jasper.morph-cut', o);
			return {
				// A's square only (dissolve: 50 % grey; morph: dark — the square moved on)
				aOnly: px(m, 99, 72),
				// B's square only, inside the half-way square (dissolve: 50 % grey; morph: bright)
				bOnly: px(m, 148, 72),
				both: px(m, 128, 72),
			};
		} finally {
			W = w0;
			H = h0;
		}
	},
};

(window as unknown as { __pr: typeof api }).__pr = api;
