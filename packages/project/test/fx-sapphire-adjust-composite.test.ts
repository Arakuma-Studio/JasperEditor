// The sapphire-adjust-composite family (fx catalogue, wave 2): Sapphire names/bins, the TS maths behind the shaders
// (OCIO curves and matrices against published values, tone stops, matte distance inversion, Sapphire width units)
// and the pass plans (mask / blur / shaping passes appear only when needed, texture budget with everything on).
import { describe, expect, it } from 'vitest';
import {
	FX_MAX_TEXTURES,
	type FxFrameContext,
	gpuPasses,
	planGpuEffect,
	SAPPHIRE_BINS,
} from '../src/index.ts';
import type { EffectParams, EffectSpec } from '../src/registry/effects.ts';
import { relSigma } from '../src/registry/fx/sapphire-adjust-composite/common.ts';
import {
	erfinv,
	MATTE_FILTERS,
	matteDistance,
	matteReachPx,
} from '../src/registry/fx/sapphire-adjust-composite/matte.ts';
import {
	invertMat3,
	mulMat3,
	OCIO_GAMUTS,
	OCIO_SPACES,
	ocioConvert,
	ocioDecode,
	ocioEncode,
	ocioMatrix,
	ocioSpace,
} from '../src/registry/fx/sapphire-adjust-composite/ocio.ts';
import {
	ocioTransformOf,
	S_EDGE_FLASH,
	S_HOTSPOTS,
	S_INVERT,
	S_LAYER,
	S_MATTE_OPS,
	S_QUAD_TONE,
	SAPPHIRE_ADJUST_COMPOSITE_EFFECTS,
} from '../src/registry/fx/sapphire-adjust-composite.ts';

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
const defaults = (s: EffectSpec, over: EffectParams = {}): EffectParams => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});
const outputs = (s: EffectSpec, p: EffectParams) =>
	planGpuEffect(s, { id: 'fx', params: p }, ctx, { width: 1920, height: 1080 }).passes.map((x) => x.output);

describe('sapphire-adjust-composite catalogue', () => {
	it('has every Sapphire effect of the family with S_ labels, jasper.s ids and the right bin', () => {
		const adjust = [
			'S_ChannelSwitcher',
			'S_ClampChroma',
			'S_DuoTone',
			'S_Gamma',
			'S_Hotspots',
			'S_HueSatBright',
			'S_Invert',
			'S_Monochrome',
			'S_OCIOTransform',
			'S_QuadTone',
			'S_Threshold',
			'S_Tint',
			'S_TriTone',
			'S_ShowBadColors',
		];
		const composite = ['S_EdgeFlash', 'S_Layer', 'S_MathOps', 'S_MatteOps', 'S_MatteOpsComp', 'S_ZComp'];
		const byLabel = new Map(SAPPHIRE_ADJUST_COMPOSITE_EFFECTS.map((s) => [s.label, s]));
		expect([...byLabel.keys()].sort()).toEqual([...adjust, ...composite].sort());
		for (const l of adjust) expect(byLabel.get(l)!.bin).toBe(SAPPHIRE_BINS.adjust);
		for (const l of composite) expect(byLabel.get(l)!.bin).toBe(SAPPHIRE_BINS.composite);
		for (const s of SAPPHIRE_ADJUST_COMPOSITE_EFFECTS) expect(s.id).toMatch(/^jasper\.s\.[a-z]+(-[a-z]+)*$/);
	});

	it('keeps Sapphire’s parameter names, order and defaults', () => {
		const labels = (s: EffectSpec) => s.params.map((p) => p.label);
		expect(labels(S_INVERT)).toEqual([
			'Invert Luma',
			'Invert Chroma',
			'Invert Red',
			'Invert Green',
			'Invert Blue',
			'Invert Alpha',
			'Remult By Alpha',
			'Scale Lights',
			'Tint Lights',
			'Tint Darks',
			'Offset Darks',
			'Saturation',
			'Mask',
			'Mask Use',
			'Blur Mask',
			'Invert Mask',
		]);
		expect(labels(S_QUAD_TONE).slice(-5)).toEqual([
			'Mix With Source',
			'Mask',
			'Mask Use',
			'Blur Mask',
			'Invert Mask',
		]);
		const d = defaults(S_EDGE_FLASH);
		expect([
			d.fgFlashAmp,
			d.bgFlashAmp,
			d.flashWidth,
			d.edgeSoftness,
			d.noiseWidth,
			d.frequency,
			d.seed,
		]).toEqual([0.8, 0.8, 0.088, 1, 0.0224, 100, 0.23]);
		expect(S_LAYER.params.find((p) => p.name === 'effect')!.options).toHaveLength(24);
		// Numbers and colours are keyframable, popups/checkboxes/media hold-only.
		for (const s of SAPPHIRE_ADJUST_COMPOSITE_EFFECTS)
			for (const p of s.params) {
				if (
					p.type === 'color' ||
					(p.type === 'number' && !['octaves', 'seed', 'jitterFrames'].includes(p.name))
				)
					expect(p.animatable, `${s.id}.${p.name}`).toBe(true);
				if (p.type === 'enum' || p.type === 'boolean' || p.type === 'media') expect(p.animatable).toBe(false);
			}
	});
});

describe('S_OCIOTransform maths', () => {
	it('matches published curve values', () => {
		expect(ocioEncode('logc3', 0.18)).toBeCloseTo(0.391007, 5); // ARRI: 18 % grey at EI800
		expect(ocioEncode('slog3', 0.18)).toBeCloseTo(420 / 1023, 6); // Sony: 18 % grey = 420 (10 bit)
		expect(ocioEncode('vlog', 0.18)).toBeCloseTo(0.423311, 5); // Panasonic: 18 % grey = 433 (10 bit)
		expect(ocioEncode('acescct', 0.18)).toBeCloseTo(0.4135884, 6);
		expect(ocioEncode('srgb', 0.18)).toBeCloseTo(0.461356, 5);
		expect(ocioEncode('rec709', 0.18)).toBeCloseTo(0.409008, 5);
		expect(ocioEncode('rec2020', 1)).toBeCloseTo(1, 9);
	});

	it('every curve round-trips', () => {
		for (const s of OCIO_SPACES)
			for (const x of [0, 0.001, 0.01, 0.05, 0.18, 0.5, 0.9, 1])
				expect(ocioDecode(s.curve, ocioEncode(s.curve, x)), `${s.curve}(${x})`).toBeCloseTo(x, 6); // V-Log: published constants differ ~5e-8 at the cut
	});

	it('matrices: Rec.709 → ACEScg equals the published Bradford-adapted matrix; inverses compose to identity', () => {
		const m = ocioMatrix(ocioSpace('linRec709'), ocioSpace('acescg'));
		const published = [
			0.613097402401, 0.339523146184, 0.047379451415, 0.07019372247, 0.916353879057, 0.013452398473,
			0.020615592882, 0.109569772938, 0.86981463418,
		];
		m.forEach((v, i) => {
			expect(v).toBeCloseTo(published[i]!, 7);
		});
		const r2020 = ocioMatrix(ocioSpace('linRec709'), ocioSpace('linRec2020'));
		[0.6274039, 0.329283, 0.0433131].forEach((v, i) => {
			expect(r2020[i]).toBeCloseTo(v, 6); // BT.2087
		});
		for (const g of Object.values(OCIO_GAMUTS)) {
			const id = mulMat3(invertMat3(g), g);
			id.forEach((v, i) => {
				expect(v).toBeCloseTo(i % 4 === 0 ? 1 : 0, 9);
			});
		}
		// White stays white between every pair of spaces (all matrices preserve the adapted white).
		for (const a of OCIO_SPACES)
			for (const b of OCIO_SPACES) {
				const w = ocioConvert(a, b, [1, 1, 1]);
				const e = ocioEncode(b.curve, ocioDecode(a.curve, 1));
				for (const v of w) expect(v, `${a.value} → ${b.value}`).toBeCloseTo(e, 4);
			}
	});

	it('Switch To And From swaps the direction', () => {
		const t = ocioTransformOf({ from: 'srgb', to: 'acescg', switchToAndFrom: true });
		expect([t.from.value, t.to.value]).toEqual(['acescg', 'srgb']);
		const x = ocioConvert(ocioSpace('acescct'), ocioSpace('srgb'), [0.4, 0.5, 0.6]);
		const back = ocioConvert(ocioSpace('srgb'), ocioSpace('acescct'), x);
		back.forEach((v, i) => {
			expect(v).toBeCloseTo([0.4, 0.5, 0.6][i]!, 6);
		});
	});
});

describe('family maths', () => {
	it('relative widths are fractions of the layer height (reach ≈ 3σ)', () => {
		expect(relSigma(0.3, { height: 1080, pxScale: 1 })).toBeCloseTo(108);
		expect(relSigma(0.3, { height: 1080, pxScale: 0.5 })).toBeCloseTo(54);
	});

	it('matte distance inverts each filter’s edge profile', () => {
		const R = 10;
		const profile = {
			box: (d: number) => Math.min(1, Math.max(0, 0.5 - d / (2 * R))),
			triangle: (d: number) =>
				d >= R ? 0 : d <= -R ? 1 : d >= 0 ? (R - d) ** 2 / (2 * R * R) : 1 - (R + d) ** 2 / (2 * R * R),
			gauss: (d: number) => 0.5 * (1 - erf(d / ((R / 2.5) * Math.SQRT2))),
		};
		for (const f of MATTE_FILTERS)
			for (const d of [-6, -2.5, 0, 1, 4, 7])
				expect(matteDistance(f, profile[f](d), R), `${f} ${d}`).toBeCloseTo(d, 2);
		expect(erfinv(erf(0.3))).toBeCloseTo(0.3, 5);
	});

	it('the shaping reach covers grow, softness and edge noise', () => {
		expect(matteReachPx({ shrinkGrow: -5, edgeSoftness: 2 }, { height: 1000, pxScale: 1 })).toBe(9);
		expect(
			matteReachPx(
				{ shrinkGrow: 0, edgeSoftness: 1, noiseAmplitude: 1, noiseWidth: 0.01 },
				{ height: 1000, pxScale: 1 },
			),
		).toBe(13);
	});

	it('Tri/QuadTone stops are sorted by brightness with their segment softness', async () => {
		const { toneStops } = await import('../src/registry/fx/sapphire-adjust-composite.ts');
		const s = toneStops(defaults(S_QUAD_TONE, { color3AtBright: 0.1, softness: 0.5, softness01: 0.2 }), 4);
		expect(s.map((x) => x.pos)).toEqual([0, 0.1, 0.33, 0.66]);
		expect(s[0]!.soft).toBeCloseTo(0.1);
	});
});

describe('pass plans', () => {
	it('mask passes only with a mask, blur passes only with Blur Mask > 0', () => {
		expect(outputs(S_INVERT, defaults(S_INVERT))).toEqual([null]);
		const m = { mask: { mediaId: 'm1' } };
		expect(outputs(S_INVERT, defaults(S_INVERT, m))).toEqual(['maskRaw', 'maskSoftH', 'maskSoft', null]);
		expect(outputs(S_INVERT, defaults(S_INVERT, { ...m, blurMask: 0 }))).toEqual(['maskRaw', null]);
		expect(outputs(S_HOTSPOTS, defaults(S_HOTSPOTS, { blurInput: 0.1 }))).toEqual([
			'hotBlurH',
			'hotBlur',
			null,
		]);
	});

	it('S_MatteOps passes the matte through at defaults and shapes it per filter', () => {
		expect(outputs(S_MATTE_OPS, defaults(S_MATTE_OPS))).toEqual([null]);
		const grow = (filter: string) => outputs(S_MATTE_OPS, defaults(S_MATTE_OPS, { shrinkGrow: 3, filter }));
		expect(grow('box')).toEqual(['matteSrc', 'matteLevelH', 'matteLevel', 'matteShaped', null]);
		expect(grow('triangle')).toEqual([
			'matteSrc',
			'matteLevelAH',
			'matteLevelA',
			'matteLevelH',
			'matteLevel',
			'matteShaped',
			null,
		]);
		expect(outputs(S_MATTE_OPS, defaults(S_MATTE_OPS, { postBlur: 2 }))).toEqual([
			'matteSrc',
			'mattePostH',
			'mattePost',
			null,
		]);
	});

	it('every effect stays within the texture budget with all options on', () => {
		const media = { mediaId: 'm' };
		const everything: EffectParams = {
			mask: media,
			background: media,
			matte: media,
			sourceB: media,
			depthA: media,
			depthB: media,
			blurMask: 0.1,
			blurInput: 0.1,
			fgBlur: 0.1,
			bgBlur: 0.1,
			shrinkGrow: 3,
			noiseAmplitude: 1,
			postBlur: 2,
			filter: 'triangle',
		};
		for (const s of SAPPHIRE_ADJUST_COMPOSITE_EFFECTS) {
			const p = defaults(
				s,
				Object.fromEntries(Object.entries(everything).filter(([k]) => s.params.some((x) => x.name === k))),
			);
			const passes = gpuPasses(s.gpu!, p, ctx);
			const named = passes.length - 1;
			const textures = s.params.filter((x) => x.type === 'media').length;
			expect(named + textures, s.id).toBeLessThanOrEqual(FX_MAX_TEXTURES);
			expect(() =>
				planGpuEffect(s, { id: 'fx', params: p }, ctx, { width: 1920, height: 1080 }),
			).not.toThrow();
		}
	});

	it('no effect pads the layer (all draw inside the layer box)', () => {
		for (const s of SAPPHIRE_ADJUST_COMPOSITE_EFFECTS) expect(s.gpu!.padding).toBeUndefined();
	});
});

/** erf (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7) for the test's reference profile. */
function erf(x: number): number {
	const t = 1 / (1 + 0.3275911 * Math.abs(x));
	const y =
		1 -
		((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
			t *
			Math.exp(-x * x);
	return Math.sign(x) * y;
}
