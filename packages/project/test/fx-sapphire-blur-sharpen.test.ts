import { describe, expect, it } from 'vitest';
import type { EffectParams, EffectSpec, FxFrameContext } from '../src/index.ts';
import { FX_FAMILIES, planGpuEffect } from '../src/index.ts';

const FAMILY = FX_FAMILIES.find((f) => f.file === 'sapphire-blur-sharpen')!.effects;
const defaults = (s: EffectSpec, over: EffectParams = {}): EffectParams => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});
const ctx: FxFrameContext = {
	width: 1920,
	height: 1080,
	pxScale: 1,
	fps: 30,
	frame: 12,
	duration: 120,
	seed: 0.3,
	progress: 0,
};
const plan = (s: EffectSpec, over: EffectParams = {}, c: FxFrameContext = ctx) =>
	planGpuEffect(s, { id: 'fx', params: defaults(s, over) }, c, { width: c.width, height: c.height });

describe('pass planning', () => {
	it('never exceeds the texture budget, even with stress params', () => {
		const stress: Record<string, EffectParams> = {
			'jasper.s.beauty': { postBlur: 0.2, softFocus: 0.5, glowWidth: 1 },
			'jasper.s.blur': { blurAmount: 40, blurRel: [8, 0.1] },
			'jasper.s.z-defocus': { layers: 50, layerMode: 'comp', focalDepth: 0.5 },
			'jasper.s.z-convolve': { layers: 50, size: 4 },
			'jasper.s.z-blur': { layers: 50, layerMode: 'interp', blurWidth: 2 },
			'jasper.s.convolve-comp': { sizeFront: 4, sizeBack: 4 },
			'jasper.s.free-lens': { tiltX: 45, tiltY: 45, glowWidth: 2, defocusWidth: 1 },
			'jasper.s.rack-df-comp': {
				background: { mediaId: 'b' },
				middle: { mediaId: 'm' },
				defocusBackground: 1,
			},
			'jasper.s.deband': { preBlur: 4, growEdges: 10, postBlur: 4 },
			'jasper.s.edge-aware-blur': { edgeSmooth: 1, blurType: 'sharpEdges', filter: 'smooth' },
			'jasper.s.sharpen': { smallDetailSize: 0.1 },
		};
		for (const s of FAMILY) {
			const p = plan(s, stress[s.id] ?? {});
			const outputs = p.passes.filter((x) => x.output).length;
			expect(outputs + p.textures.length, s.id).toBeLessThanOrEqual(12);
			expect(new Set(p.passes.map((x) => x.output).filter(Boolean)).size, s.id).toBe(outputs);
		}
	});
});
