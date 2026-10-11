// Sapphire wipes (family sapphire-wipes-other): the catalogue entries (Sapphire names, ids, bin / sub-bin, Sapphire's
// controls and defaults) and the pure TS maths (`wipeMargin` → `u_swMargin`). Pixels are checked in
// packages/compositions/test/transition-sapphire-wipes-gl.test.ts.
import { describe, expect, it } from 'vitest';
import {
	planGpuTransition,
	SAPPHIRE_TRANSITION_SUBBINS,
	TRANSITION_BINS,
	TRANSITION_FAMILIES,
	type TransitionSpec,
} from '../src/index.ts';
import { wipeMargin } from '../src/registry/transitions/sapphire-wipes/common.ts';

const WIPES = TRANSITION_FAMILIES.find((f) => f.file === 'sapphire-wipes-other')!.transitions;
const byLabel = (label: string) => WIPES.find((s) => s.label === label)!;
const names = (s: TransitionSpec) => s.params.map((p) => p.name);
const def = (s: TransitionSpec, name: string) => s.params.find((p) => p.name === name)?.default;

const SAPPHIRE_WIPES = [
	'S_WipeBlobs',
	'S_WipeBubble',
	'S_WipeCells',
	'S_WipeChecker',
	'S_WipeCircle',
	'S_WipeClock',
	'S_WipeClouds',
	'S_WipeDiffuse',
	'S_WipeDots',
	'S_WipeDoubleWedge',
	'S_WipeFlux',
	'S_WipeFourWedges',
	'S_WipeLine',
	'S_WipeMoire',
	'S_WipePixelate',
	'S_WipePlasma',
	'S_WipePointalize',
	'S_WipeRectangle',
	'S_WipeRings',
	'S_WipeStar',
	'S_WipeStripes',
	'S_WipeTiles',
	'S_WipeWeave',
	'S_WipeWedge',
];
const BORDERLESS = new Set([
	'S_WipeBubble',
	'S_WipeClouds',
	'S_WipeDiffuse',
	'S_WipePixelate',
	'S_WipePointalize',
]);
const BORDER_BLOCK = [
	'borderWidth',
	'borderColor',
	'borderOpacity',
	'borderSoftness',
	'borderShift',
	'borderGlow',
	'glowWidth',
	'widthRed',
	'widthGreen',
	'widthBlue',
	'glowColor',
	'noiseAmp',
	'noiseFreq',
	'noiseSpeed',
];

describe('Sapphire wipes catalogue', () => {
	it('has every Sapphire wipe once, alphabetically, as jasper.s.wipe-* in Sapphire Transitions ▸ Wipes', () => {
		expect(WIPES.map((s) => s.label)).toEqual(SAPPHIRE_WIPES);
		for (const s of WIPES) {
			const kebab = s.label
				.slice(2)
				.replace(/([a-z])([A-Z])/g, '$1-$2')
				.toLowerCase();
			expect(s.id).toBe(`jasper.s.${kebab}`);
			expect(s.bin).toBe(TRANSITION_BINS.sapphire);
			expect(s.subBin).toBe(SAPPHIRE_TRANSITION_SUBBINS.wipes);
			expect(s.description.length).toBeGreaterThan(20);
			expect(s.keywords).toContain('wipe');
		}
	});

	it("carries Sapphire's border + glow block (in Sapphire's order and defaults) on the bordered wipes", () => {
		for (const s of WIPES) {
			const n = names(s);
			if (BORDERLESS.has(s.label)) {
				expect(n).not.toContain('borderWidth');
				continue;
			}
			const at = n.indexOf('borderWidth');
			expect(n.slice(at, at + BORDER_BLOCK.length)).toEqual(BORDER_BLOCK);
			expect(def(s, 'borderColor')).toEqual([0.75, 0, 0, 1]);
			expect([def(s, 'widthRed'), def(s, 'widthGreen'), def(s, 'widthBlue')]).toEqual([1, 1.2, 1.4]);
			expect([def(s, 'noiseAmp'), def(s, 'noiseFreq'), def(s, 'noiseSpeed')]).toEqual([1, 16, 2]);
			expect(def(s, 'borderGlow')).toBe(0);
			// Start / End first, Reverse (= Sapphire's Transition Dir) after the own params.
			expect(n.slice(0, 2)).toEqual(['startPercent', 'endPercent']);
			expect(n).toContain('reverse');
		}
	});

	it("exposes each wipe's shape controls with Sapphire's defaults", () => {
		expect(def(byLabel('S_WipeLine'), 'angle')).toBe(45);
		expect(def(byLabel('S_WipeCircle'), 'wipeDirection')).toBe('circleIn');
		expect(names(byLabel('S_WipeCircle'))).toEqual(expect.arrayContaining(['relWidth', 'rotate', 'center']));
		expect(def(byLabel('S_WipeRectangle'), 'relWidth')).toBe(1.25);
		expect(def(byLabel('S_WipeStar'), 'points')).toBe(5);
		expect(def(byLabel('S_WipeStar'), 'pointiness')).toBe(1.1);
		expect(def(byLabel('S_WipeWedge'), 'pointiness')).toBe(2);
		expect(def(byLabel('S_WipeDoubleWedge'), 'wipeDirection')).toBe('wedgeIn');
		expect(def(byLabel('S_WipeFourWedges'), 'aspectScale')).toBe(1);
		expect(def(byLabel('S_WipeClock'), 'direction')).toBe('clockwise');
		expect(names(byLabel('S_WipeClock'))).toEqual(
			expect.arrayContaining(['angleOpen', 'angleClose', 'center']),
		);
		expect(def(byLabel('S_WipeChecker'), 'angle')).toBe(45);
		expect(def(byLabel('S_WipeDots'), 'frequency')).toBe(6);
		expect(byLabel('S_WipeTiles').params.find((p) => p.name === 'tileShapes')?.options).toEqual([
			'hexagons',
			'triangles',
			'diamonds',
			'stars',
		]);
		expect(def(byLabel('S_WipeRings'), 'frequency')).toBe(4);
		expect(def(byLabel('S_WipePlasma'), 'gradAdd')).toBe(0.5);
		expect(def(byLabel('S_WipePlasma'), 'layers')).toBe(8);
		expect(def(byLabel('S_WipeClouds'), 'octaves')).toBe(8);
		expect(def(byLabel('S_WipeWeave'), 'relLength')).toBe(10);
		expect(def(byLabel('S_WipeMoire'), 'edgeSoftness')).toBeGreaterThan(0);
		expect(def(byLabel('S_WipePixelate'), 'pixelFrequency')).toBe(20);
		expect(def(byLabel('S_WipePointalize'), 'edgeWidth')).toBe(2);
		expect(def(byLabel('S_WipeBubble'), 'wrap')).toBe('reflect');
		expect(def(byLabel('S_WipeDiffuse'), 'diffuseAmount')).toBe(0.4);
		// Grad Add / Grad Angle on the pattern wipes; Seed on the random ones.
		for (const l of [
			'S_WipeBlobs',
			'S_WipeCells',
			'S_WipeChecker',
			'S_WipeDots',
			'S_WipeFlux',
			'S_WipeMoire',
		]) {
			expect(names(byLabel(l))).toEqual(expect.arrayContaining(['gradAdd', 'gradAngle']));
		}
		for (const l of [
			'S_WipeBlobs',
			'S_WipeCells',
			'S_WipeClouds',
			'S_WipeFlux',
			'S_WipePixelate',
			'S_WipeWeave',
		])
			expect(names(byLabel(l))).toContain('seed');
	});

	it('keeps the numeric controls keyframable and the popups hold-only', () => {
		const star = byLabel('S_WipeStar');
		for (const n of [
			'edgeSoftness',
			'pointiness',
			'angle',
			'relWidth',
			'borderWidth',
			'borderGlow',
			'center',
		])
			expect(star.params.find((p) => p.name === n)?.animatable, n).toBe(true);
		expect(star.params.find((p) => p.name === 'wipeDirection')?.animatable).toBe(false);
		expect(star.params.find((p) => p.name === 'points')?.animatable).toBe(false);
	});
});

describe('wipeMargin (u_swMargin)', () => {
	it('covers the soft edge, the border band and the glow reach', () => {
		expect(wipeMargin({})).toBeCloseTo(1.5);
		expect(wipeMargin({ edgeSoftness: 20 })).toBeCloseTo(11);
		// Soft edge 0.5 + (shift 4 + half border 5 + half softness 0.5) + 1.
		expect(wipeMargin({ borderWidth: 10, borderShift: -4 })).toBeCloseTo(11);
		// Glow: 3 × glow width × widest channel (1.4) beyond the band.
		expect(wipeMargin({ borderGlow: 1, glowWidth: 10 })).toBeCloseTo(0.5 + 42 + 1);
		expect(wipeMargin({ borderGlow: 0, glowWidth: 10 })).toBeCloseTo(1.5);
	});

	it('is passed to the shader per frame (keyframed params evaluated by the stage)', () => {
		const line = byLabel('S_WipeLine');
		const staged = planGpuTransition(
			line,
			{ id: 't', params: { borderWidth: 8 }, frame: 3, duration: 10, sides: 'both' },
			{ width: 1920, height: 1080, fps: 30 },
			{ out: null, in: null },
		);
		const u = staged.plan.uniforms.find((x) => x.name === 'u_swMargin');
		expect(u?.value[0]).toBeCloseTo(wipeMargin({ borderWidth: 8 }));
	});
});
