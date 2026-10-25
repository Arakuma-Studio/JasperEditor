import { describe, expect, it } from 'vitest';
import { type FxFrameContext, gpuPasses, planGpuEffect } from '../src/index.ts';
import type { EffectParams, EffectSpec } from '../src/registry/effects.ts';
import { ocioMatrix, ocioSpace } from '../src/registry/fx/sapphire-adjust-composite/ocio.ts';
import { SAPPHIRE_ADJUST_COMPOSITE_EFFECTS } from '../src/registry/fx/sapphire-adjust-composite.ts';

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
describe('S_OCIOTransform maths', () => {
	it('Rec.709 conversion matrices match published Bradford-adapted and BT.2087 values', () => {
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
	});
});

describe('pass plans', () => {
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
			const named = new Set(passes.slice(0, -1).map((pass, index) => pass.output ?? `pass${index}`)).size;
			const textures = s.params.filter((x) => x.type === 'media').length;
			expect(named + textures, s.id).toBeLessThanOrEqual(12);
			expect(() =>
				planGpuEffect(s, { id: 'fx', params: p }, ctx, { width: 1920, height: 1080 }),
			).not.toThrow();
		}
	});
});
