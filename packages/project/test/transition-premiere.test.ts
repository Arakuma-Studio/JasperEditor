import { describe, expect, it } from 'vitest';
import {
	planGpuTransition,
	TRANSITION_BINS,
	TRANSITION_SPECS,
	type TransitionSpec,
	type TrFrameContext,
	transitionPasses,
} from '../src/index.ts';
import { MODERN_BINS } from '../src/registry/transitions/premiere/modern-common.ts';
import { PREMIERE_TRANSITIONS } from '../src/registry/transitions/premiere-transitions.ts';

const byLabel = (label: string) => {
	const s = PREMIERE_TRANSITIONS.find((t) => t.label === label);
	if (!s) throw new Error(`no ${label}`);
	return s;
};
const defaults = (s: TransitionSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});
const param = (s: TransitionSpec, name: string) => s.params.find((p) => p.name === name);
const CTX: TrFrameContext = {
	width: 1920,
	height: 1080,
	fps: 30,
	duration: 30,
	frame: 10,
	linear: 0.35,
	progress: 0.35,
	seed: 0.5,
	reversed: false,
	hasFrom: true,
	hasTo: true,
};
const uniforms = (label: string, over: Record<string, unknown> = {}) => {
	const s = byLabel(label);
	return s.gpu!.uniforms!(defaults(s, over) as never, CTX);
};

/** Premiere's standard video transitions (classic), by bin. */
const CLASSIC: Record<string, string[]> = {
	[TRANSITION_BINS.motion3d]: ['Cube Spin', 'Flip Over'],
	[TRANSITION_BINS.dissolve]: [
		'Additive Dissolve',
		'Dip to White',
		'Film Dissolve',
		'Morph Cut',
		'Non-Additive Dissolve',
	],
	[TRANSITION_BINS.iris]: ['Iris Box', 'Iris Cross', 'Iris Diamond', 'Iris Round'],
	[TRANSITION_BINS.pagePeel]: ['Page Peel', 'Page Turn'],
	[TRANSITION_BINS.slide]: ['Band Slide', 'Center Split', 'Push', 'Slide', 'Split', 'Whip'],
	[TRANSITION_BINS.wipe]: [
		'Band Wipe',
		'Barn Doors',
		'Checker Wipe',
		'CheckerBoard',
		'Clock Wipe',
		'Gradient Wipe',
		'Inset',
		'Paint Splatter',
		'Pinwheel',
		'Radial Wipe',
		'Random Blocks',
		'Random Wipe',
		'Spiral Boxes',
		'Venetian Blinds',
		'Wedge Wipe',
		'Wipe',
		'Zig-Zag Blocks',
	],
	[TRANSITION_BINS.zoom]: ['Cross Zoom'],
};

/** Premiere 25.5 / 26 transitions from Film Impact (Premiere folder → labels). */
const MODERN: Record<string, string[]> = {
	Dissolve: [
		'Blur Dissolve',
		'Blur to Color',
		'Burn Alpha',
		'Dip to Color',
		'Luma Fade',
		'Mosaic',
		'Shape Dissolve',
	],
	Slide: ['3D Roll', 'Film Roll', 'Roll', 'Stretch'],
	Wipe: ['Linear Wipe', 'Neon Wipe', 'Panel Wipe', 'Plateau Wipe', 'Soft Wipe', 'Star Wipe', 'Stretch Wipe'],
	Animation: [
		'Block Motion',
		'Flip Motion',
		'Fold Motion',
		'Pop Motion',
		'Pull Motion',
		'Spin Motion',
		'Spring Motion',
		'Travel Motion',
	],
	'Grunge & Distort': [
		'Chaos',
		'Earthquake',
		'Flicker',
		'Glass',
		'Glitch',
		'Grunge',
		'Kaleidoscope',
		'Liquid Distortion',
		'TV Power',
		'VHS Damage',
	],
	'Lights & Blurs': [
		'Burn Chroma',
		'Chroma Leak',
		'Directional Blur',
		'Flare',
		'Flash',
		'Glow',
		'Lens Blur',
		'Light Leak',
		'Light Sweep',
		'Phosphor',
		'Radial Blur',
		'Ray',
		'Solarize',
		'Stripe',
		'Zoom Blur',
	],
	Transformers: ['3D Spin', '3D Spinback', 'Frame', 'Louver', 'Mirror', 'Slice', 'Wave'],
	'Immersive Video': [
		'VR Chroma Leaks',
		'VR Gradient Wipe',
		'VR Iris Wipe',
		'VR Light Leaks',
		'VR Light Rays',
		'VR Mobius Zoom',
		'VR Random Blocks',
		'VR Spherical Blur',
	],
};
const MODERN_BIN: Record<string, string> = {
	Dissolve: TRANSITION_BINS.dissolve,
	Slide: TRANSITION_BINS.slide,
	Wipe: TRANSITION_BINS.wipe,
	Animation: MODERN_BINS.animation,
	'Grunge & Distort': MODERN_BINS.grungeDistort,
	'Lights & Blurs': MODERN_BINS.lightsBlurs,
	Transformers: MODERN_BINS.transformers,
	'Immersive Video': MODERN_BINS.immersive,
};

describe('Premiere transition catalogue', () => {
	it('has every classic Premiere video transition in its Premiere bin', () => {
		for (const [bin, labels] of Object.entries(CLASSIC))
			for (const l of labels) expect(byLabel(l).bin, l).toBe(bin);
		expect(PREMIERE_TRANSITIONS.some((t) => t.label === 'Cross Dissolve' || t.label === 'Dip to Black')).toBe(
			false,
		);
	});

	it("has Premiere 26's modern transitions, their folders mapped onto the existing bins", () => {
		for (const [folder, labels] of Object.entries(MODERN))
			for (const l of labels) {
				expect(byLabel(l).bin, l).toBe(MODERN_BIN[folder]);
				if (!['Dissolve', 'Slide', 'Wipe'].includes(folder))
					expect(byLabel(l).keywords ?? [], l).toContain(folder.toLowerCase());
			}
		const premiereBins = new Set<string>(Object.values(TRANSITION_BINS));
		for (const b of Object.values(MODERN_BINS)) expect(premiereBins.has(b)).toBe(true);
		const count = Object.values(CLASSIC).flat().length + Object.values(MODERN).flat().length;
		expect(PREMIERE_TRANSITIONS).toHaveLength(count);
	});

	it('keeps labels unique across the whole registry (MCP resolves types by label) and ids unique', () => {
		const labels = TRANSITION_SPECS.map((s) => s.label.toLowerCase());
		expect(new Set(labels).size).toBe(labels.length);
		const ids = PREMIERE_TRANSITIONS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^jasper\.[a-z0-9-]+$/);
	});

	it('lists the family bin by bin, alphabetically inside a bin', () => {
		const order = Object.values(TRANSITION_BINS) as string[];
		for (let i = 1; i < PREMIERE_TRANSITIONS.length; i++) {
			const a = PREMIERE_TRANSITIONS[i - 1]!;
			const b = PREMIERE_TRANSITIONS[i]!;
			const d = order.indexOf(a.bin) - order.indexOf(b.bin);
			expect(
				d < 0 || (d === 0 && a.label.localeCompare(b.label, 'en') <= 0),
				`${a.label} before ${b.label}`,
			).toBe(true);
		}
	});
});

describe("Premiere's options and defaults", () => {
	it('gives wipes, irises and slides Border, Anti-aliasing and Reverse; centred ones a Center', () => {
		for (const l of [
			'Wipe',
			'Band Wipe',
			'Barn Doors',
			'Clock Wipe',
			'Iris Box',
			'Iris Cross',
			'Slide',
			'Band Slide',
			'Cube Spin',
		]) {
			const s = byLabel(l);
			for (const n of ['borderWidth', 'borderColor', 'reverse', 'antiAliasing'])
				expect(param(s, n), `${l} ${n}`).toBeTruthy();
		}
		for (const l of [
			'Clock Wipe',
			'Wedge Wipe',
			'Pinwheel',
			'Iris Box',
			'Iris Cross',
			'Iris Diamond',
			'Iris Round',
			'Star Wipe',
		])
			expect(param(byLabel(l), 'center'), l).toBeTruthy();
		// Morph Cut has only duration / alignment in Premiere: no Reverse.
		expect(param(byLabel('Morph Cut'), 'reverse')).toBeUndefined();
	});

	it("uses Premiere's defaults and custom settings", () => {
		const def = (l: string, n: string) => param(byLabel(l), n)?.default;
		expect(def('Wipe', 'direction')).toBe('westToEast');
		expect(param(byLabel('Wipe'), 'direction')?.options).toHaveLength(8);
		expect(param(byLabel('Slide'), 'direction')?.options).toHaveLength(8);
		expect(def('Barn Doors', 'direction')).toBe('horizontal');
		expect(def('Inset', 'direction')).toBe('northWest');
		expect(def('Page Peel', 'direction')).toBe('northWest');
		expect(def('Page Turn', 'direction')).toBe('northWest');
		expect(def('Band Wipe', 'bands')).toBe(7);
		expect(def('Band Slide', 'bands')).toBe(7);
		expect(def('Zig-Zag Blocks', 'horizontal')).toBe(8);
		expect(def('Zig-Zag Blocks', 'vertical')).toBe(6);
		expect(def('Checker Wipe', 'horizontal')).toBe(8);
		expect(def('Checker Wipe', 'vertical')).toBe(8);
		expect(def('CheckerBoard', 'horizontal')).toBe(8);
		expect(def('Flip Over', 'bands')).toBe(1);
		expect(def('Flip Over', 'fillColor')).toEqual([0.5, 0.5, 0.5, 1]);
		expect(def('Gradient Wipe', 'softness')).toBe(10);
		expect(def('Wedge Wipe', 'direction')).toBe('north');
		expect(def('Clock Wipe', 'startAngle')).toBe(-90);
		expect(param(byLabel('Clock Wipe'), 'borderWidth')?.default).toBe(0);
	});
});

describe('Premiere transition uniforms (pure TS maths)', () => {
	it('maps the edge selectors to vectors', () => {
		expect(uniforms('Wipe').u_dir).toEqual([1, 0]);
		const diag = uniforms('Wipe', { direction: 'southEastToNorthWest' }).u_dir as readonly number[];
		expect(diag[0]).toBeCloseTo(-Math.SQRT1_2);
		expect(diag[1]).toBeCloseTo(-Math.SQRT1_2);
		// Slide's diagonals come from the corner: both axes travel a full frame.
		expect(uniforms('Slide', { direction: 'northEastToSouthWest' }).u_dir).toEqual([-1, 1]);
		expect(uniforms('Barn Doors', { direction: 'vertical' }).u_dir).toEqual([0, 1]);
		expect(uniforms('Split', { direction: 'vertical' }).u_axes).toEqual([0, 1]);
		expect(uniforms('Wipe', { direction: 'nonsense' }).u_dir).toEqual([1, 0]);
	});

	it('places the corners and start angles', () => {
		expect(uniforms('Radial Wipe', { direction: 'southEast' })).toEqual({
			u_corner: [1, 1],
			u_startAngle: 180,
		});
		expect(uniforms('Inset', { direction: 'northEast' }).u_corner).toEqual([1, 0]);
		expect(uniforms('Page Peel', { direction: 'southWest' }).u_corner).toEqual([0, 1]);
		expect(uniforms('Spiral Boxes', { direction: 'southWest' }).u_corner).toEqual({ int: 3 });
		expect(uniforms('Wedge Wipe', { direction: 'west' }).u_startAngle).toBe(180);
		expect(uniforms('Wedge Wipe').u_startAngle).toBe(-90);
	});

	it('lays the 3D scenes out per direction', () => {
		expect(uniforms('Cube Spin')).toEqual({ u_swap: false, u_flip: false });
		expect(uniforms('Cube Spin', { direction: 'southToNorth' })).toEqual({ u_swap: true, u_flip: true });
		expect(uniforms('Flip Over', { direction: 'vertical' })).toEqual({ u_swap: true, u_flip: false });
		expect(uniforms('Louver')).toEqual({ u_swap: true });
		expect(uniforms('Louver', { slatAxis: 'vertical' })).toEqual({ u_swap: false });
	});

	it('turns angle params into unit directions', () => {
		const d = uniforms('Linear Wipe', { angle: 90 }).u_dir as readonly number[];
		expect(d[0]).toBeCloseTo(0);
		expect(d[1]).toBeCloseTo(1);
	});
});

describe('Premiere transition planning', () => {
	it('builds the multi-pass ones from their params (pure)', () => {
		const plan = { width: 1920, height: 1080, fps: 30, duration: 30 };
		const blur = byLabel('Blur Dissolve');
		const passes = transitionPasses(blur.gpu!, defaults(blur, { blur: 160 }) as never, plan);
		// mix, 3 blur levels × (H + V), final
		expect(passes).toHaveLength(8);
		expect(passes[1]!.uniforms?.u_blurSigma).toBeCloseTo((160 / 4) * 0.5);
		expect(transitionPasses(blur.gpu!, defaults(blur, { blur: 160 }) as never, plan)).toEqual(passes);
		const morph = byLabel('Morph Cut');
		const mp = transitionPasses(morph.gpu!, defaults(morph) as never, plan);
		const outs = mp.map((p) => p.output);
		expect(outs.slice(0, 4)).toEqual(['mcL0', 'mcL1', 'mcL2', 'mcL3']);
		expect(outs.slice(-2)).toEqual(['mcFlow', undefined]);
		const vec = mp.filter((p) => p.output === 'mcVec');
		expect(vec.length).toBeGreaterThanOrEqual(2);
		expect(vec[0]!.update).toBeFalsy();
		for (const v of vec.slice(1)) expect(v.update).toBe(true);
		expect(mp[outs.indexOf('mcFlow')]!.format).toBe('rgba32f');
	});

	it('plans a stage with the family chunks and derived uniforms', () => {
		const s = byLabel('Spiral Boxes');
		const staged = planGpuTransition(
			s,
			{
				id: 'trn_1',
				params: defaults(s, { direction: 'northEast' }) as never,
				frame: 4,
				duration: 10,
				sides: 'both',
			},
			{ width: 640, height: 360, fps: 30 },
			{
				out: { width: 640, height: 360, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 },
				in: { width: 640, height: 360, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 },
			},
		);
		const last = staged.plan.passes.at(-1)!;
		expect(last.source).toContain('pr_spiral');
		expect(last.source).toContain('float pr_grow');
		expect(staged.plan.uniforms.find((u) => u.name === 'u_corner')).toMatchObject({
			type: 'int',
			value: [1],
		});
	});
});
