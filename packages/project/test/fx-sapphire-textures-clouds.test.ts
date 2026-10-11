// Family "sapphire-textures-clouds" (Sapphire Render ▸ procedural textures + fractal clouds): the 21 entries, their
// Sapphire parameter vocabulary and defaults, the shared tail (Bg Brightness, Combine, Output Opacity, Show, Mix with
// Orig), seeds, time dependence and the TS-side pass maths (sharpen sigma, glow pyramid, planned passes). Pixels are
// checked in WebGL by packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts.
import { describe, expect, it } from 'vitest';
import {
	type EffectParams,
	type EffectSpec,
	FX_FAMILIES,
	type FxFrameContext,
	fxSeed,
	gpuIsTimeDependent,
	paramUniforms,
	planGpuEffect,
	SAPPHIRE_BINS,
} from '../src/index.ts';
import {
	glowPasses,
	STC_GLOW_LEVELS,
	sharpenSigma,
} from '../src/registry/fx/sapphire-textures-clouds/passes.ts';
import { SAPPHIRE_TEXTURES_CLOUDS_EFFECTS as FX } from '../src/registry/fx/sapphire-textures-clouds.ts';

const byLabel = (label: string): EffectSpec => {
	const s = FX.find((e) => e.label === label);
	if (!s) throw new Error(`no ${label}`);
	return s;
};
const defaults = (s: EffectSpec, over: EffectParams = {}): EffectParams => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});
const param = (s: EffectSpec, name: string) => s.params.find((p) => p.name === name);
const ctx: FxFrameContext = {
	width: 1920,
	height: 1080,
	pxScale: 1,
	fps: 30,
	frame: 0,
	duration: 150,
	seed: 0.5,
	progress: 0,
};

const LABELS = [
	'S_Clouds',
	'S_CloudsColorSmooth',
	'S_CloudsMultColor',
	'S_CloudsPerspective',
	'S_CloudsPsyko',
	'S_CloudsVortex',
	'S_TextureCells',
	'S_TextureChromaSpiral',
	'S_TextureFlux',
	'S_TextureFolded',
	'S_TextureLoops',
	'S_TextureMicro',
	'S_TextureMoire',
	'S_TextureNeurons',
	'S_TextureNoiseEmboss',
	'S_TextureNoisePaint',
	'S_TexturePlasma',
	'S_TextureRidges',
	'S_TextureSpots',
	'S_TextureTiles',
	'S_TextureWeave',
];

describe('sapphire-textures-clouds family', () => {
	it('registers the 21 Sapphire textures and clouds right after sapphire-render-textures', () => {
		expect(FX.map((s) => s.label)).toEqual(LABELS);
		const files = FX_FAMILIES.map((f) => f.file);
		expect(files.indexOf('sapphire-textures-clouds')).toBe(files.indexOf('sapphire-render-textures') + 1);
		expect(FX_FAMILIES.find((f) => f.file === 'sapphire-textures-clouds')!.effects).toBe(FX);
	});

	it('ids are jasper.s.<kebab of the Sapphire name>; generators in Sapphire Render', () => {
		for (const s of FX) {
			const kebab = s.label
				.slice(2)
				.replace(/([a-z])([A-Z])/g, '$1-$2')
				.toLowerCase();
			expect(s.id).toBe(`jasper.s.${kebab}`);
			expect(s.bin).toBe(SAPPHIRE_BINS.render);
			expect(s.category).toBe('Generate');
			expect(s.gpu?.kind).toBe('generator');
			expect(s.description).toBeTruthy();
		}
	});

	it('every entry ends with Bg Brightness, Combine, Output Opacity, Show, Mix with Orig', () => {
		for (const s of FX) {
			const tail = s.params.slice(-5).map((p) => p.label);
			expect(tail).toEqual(['Bg Brightness', 'Combine', 'Output Opacity', 'Show', 'Mix with Orig']);
			expect(param(s, 'outputOpacity')!.default).toBe('copyFromInput');
			const combine = param(s, 'combine')!;
			const first = combine.optionLabels![0];
			if (s.label.startsWith('S_Clouds')) expect(first).toBe('Clouds Only');
			else if (s.label === 'S_TextureRidges')
				expect(combine.optionLabels).toEqual(['Noise Only', 'Mult', 'Add', 'Screen']);
			else
				expect(combine.optionLabels).toEqual([
					'Texture Only',
					'Mult',
					'Add',
					'Screen',
					'Difference',
					'Overlay',
				]);
			expect(combine.default).toBe(combine.options![0]);
		}
	});

	it('uses Sapphire names, defaults and ranges', () => {
		const clouds = defaults(byLabel('S_Clouds'));
		expect(clouds).toMatchObject({
			frequency: 2,
			frequencyRelX: 0.4,
			octaves: 8,
			seed: 0.234,
			boilingMode: false,
			boilDetails: 0.55,
			boilSpeed: 1,
			shiftStart: [0, 0],
			shiftSpeed: [0.5, 0],
			brightness1: 1,
			color1: [1, 1, 1, 1],
			color0: [0, 0, 0, 1],
			offset0: 0,
			bgBrightness: 1,
			combine: 'cloudsOnly',
		});
		expect(param(byLabel('S_Clouds'), 'octaves')!.range).toMatchObject({ min: 1, max: 10, step: 1 });
		expect(defaults(byLabel('S_CloudsPerspective'))).toMatchObject({
			latitude: -35,
			teleLensWidth: 1,
			octaves: 6,
		});
		expect(defaults(byLabel('S_CloudsVortex'))).toMatchObject({
			center: [0.5, 0.5],
			latitude: 30,
			vortexStart: 72,
			vortexSpeed: 30,
			innerRadius: 0.04,
		});
		expect(defaults(byLabel('S_TexturePlasma'))).toMatchObject({
			noiseFrequency: 1.2,
			addGrad: [0.1, 0],
			layers: 4.5,
			threshold: 0.5,
			glowBrightness: 3,
			glowColor: [0.6, 0.8, 1, 1],
			glowWidthRed: 0.6,
			glowWidthGrn: 1.2,
			glowWidthBlue: 1.8,
		});
		expect(param(byLabel('S_TexturePlasma'), 'seed')!.label).toBe('Noise Seed');
		expect(defaults(byLabel('S_TextureMoire'))).toMatchObject({
			frequency: 20,
			phaseRed: 0.2,
			phaseGreen: 0.1,
			aColor: [0.5, 0.5, 0.5, 1],
		});
		expect(defaults(byLabel('S_TextureTiles'))).toMatchObject({
			size: 0.5,
			frequency: 5,
			edgeSoftness: 0.17,
		});
		expect(defaults(byLabel('S_TextureLoops')).combineLoops).toBe('diff');
		expect(defaults(byLabel('S_TextureFlux')).color0).toEqual([0, 0.12, 0.15, 1]);
		expect(defaults(byLabel('S_TextureNoisePaint'))).toMatchObject({
			strokeFrequency: 30,
			strokeLength: -5,
			sharpen: 2,
		});
		expect(param(byLabel('S_TextureMicro'), 'octaves')!.range!.max).toBe(12);
	});

	it('numeric params stay keyframable (seeds, popups and checkboxes are hold-only)', () => {
		for (const s of FX)
			for (const p of s.params) {
				if (p.type === 'number' && !p.label.endsWith('Seed')) expect(p.animatable).toBe(true);
				if (p.type === 'enum' || p.type === 'boolean') expect(p.animatable).toBe(false);
			}
	});

	it('Seed feeds u_seed (no own uniform) and changes it; Color Seed is its own uniform', () => {
		const s = byLabel('S_CloudsMultColor');
		const names = paramUniforms(s, defaults(s)).map((u) => u.name);
		expect(names).not.toContain('u_seed');
		expect(names).toContain('u_colorSeed');
		expect(fxSeed('c1', 'fx1', { seed: 0.234 })).not.toBe(fxSeed('c1', 'fx1', { seed: 1.234 }));
	});

	it('only the textures without any automatic animation are time-invariant', () => {
		const still = FX.filter((s) => s.gpu?.timeInvariant).map((s) => s.label);
		expect(still).toEqual(['S_TextureChromaSpiral', 'S_TextureNoiseEmboss']);
		for (const s of FX) expect(gpuIsTimeDependent(s)).toBe(!s.gpu?.timeInvariant);
	});

	it('marks the heavy multi-octave / multi-pass textures expensive', () => {
		expect(FX.filter((s) => s.expensive).map((s) => s.label)).toEqual([
			'S_TextureChromaSpiral',
			'S_TextureMicro',
			'S_TextureNeurons',
			'S_TextureNoisePaint',
			'S_TextureRidges',
		]);
	});

	it('generators draw inside the layer box: no padding', () => {
		for (const s of FX) expect(s.gpu?.padding).toBeUndefined();
	});

	it('sharpen sigma: Sharpen Width relative to a feature (1/frequency of the height), clamped', () => {
		expect(sharpenSigma(0.1, 20, ctx)).toBeCloseTo(5.4);
		expect(sharpenSigma(0.1, 20, { ...ctx, pxScale: 0.5 })).toBeCloseTo(2.7);
		expect(sharpenSigma(0, 20, ctx)).toBe(0.5);
		expect(sharpenSigma(100, 0.01, ctx)).toBe(256);
		expect(sharpenSigma(Number.NaN, Number.NaN, ctx)).toBe(0.5);
	});

	it('glow pyramid: six half-float levels glow0…glow5 from the line pass', () => {
		const passes = glowPasses('lines');
		expect(passes.map((p) => [p.output, p.scale, p.format])).toEqual(
			Array.from({ length: STC_GLOW_LEVELS }, (_, k) => [`glow${k}`, 1 / 2 ** (k + 1), 'rgba16f']),
		);
		expect(passes[0]!.frag).toContain('u_lines');
	});

	it('plans: passes, sizes and intermediates per texture', () => {
		const plan = (label: string, over: EffectParams = {}) => {
			const s = byLabel(label);
			return planGpuEffect(s, { id: 'fx1', params: defaults(s, over) }, ctx, { width: 1920, height: 1080 });
		};
		expect(plan('S_Clouds').passes).toHaveLength(1);
		expect(plan('S_TexturePlasma').passes.map((p) => p.output)).toEqual([
			'lines',
			'glow0',
			'glow1',
			'glow2',
			'glow3',
			'glow4',
			'glow5',
			null,
		]);
		const weave = plan('S_TextureWeave');
		expect(weave.passes.map((p) => p.output)).toEqual(['tex', 'softH', 'soft', null]);
		// The sharpen blur follows Sharpen Width and Frequency.
		const sigma = (pl: ReturnType<typeof plan>) =>
			pl.passes[1]!.uniforms.find((u) => u.name === 'u_blurSigma')!.value[0];
		expect(sigma(weave)).toBeCloseTo(5.4);
		expect(sigma(plan('S_TextureWeave', { sharpenWidth: 0.2 }))).toBeCloseTo(10.8);
		const paint = plan('S_TextureNoisePaint');
		expect(paint.passes.map((p) => [p.output, p.width])).toEqual([
			['noise', 1920],
			['orient', 960],
			['paint', 1920],
			['softH', 1920],
			['soft', 1920],
			[null, 1920],
		]);
		expect(plan('S_TextureChromaSpiral').passes.map((p) => p.output)).toEqual(['noise', null]);
		expect(plan('S_TextureFlux').passes.map((p) => p.output)).toEqual(['tex', null]);
	});
});
