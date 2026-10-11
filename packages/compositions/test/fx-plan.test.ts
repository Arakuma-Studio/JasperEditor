import {
	type EffectInstance,
	type EffectParams,
	type ResolvedEffect,
	validateGpuEffect,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { fxCanvasLayout, planLayerFx } from '../src/fx/plan.ts';
import { fxRemapFrame, hasTimeDependentFx } from '../src/fx/time.ts';
import { TEST_FX, testFxRegistry } from './fx-examples.ts';

let n = 0;
const fx = (effectId: string, params: EffectParams = {}, enabled = true): ResolvedEffect => ({
	id: `fx${++n}`,
	effectId,
	effectVersion: 1,
	enabled,
	params,
});
const opts = {
	registry: testFxRegistry,
	gpu: 'ok' as const,
	ctx: { width: 100, height: 50, pxScale: 1, fps: 30 },
};
const kinds = (p: ReturnType<typeof planLayerFx>) => p!.steps.map((s) => s.kind);

describe('planLayerFx', () => {
	it('is null without an enabled shader effect (the M1/M2 paths stay untouched)', () => {
		expect(planLayerFx([fx('jasper.gaussian-blur', { radius: 3 })], opts)).toBeNull();
		expect(planLayerFx([fx('test.s.glow', {}, false)], opts)).toBeNull();
		expect(planLayerFx([fx('unknown.effect')], opts)).toBeNull();
	});

	it('puts crop first, keeps stack order, fuses colour runs and leaves trailing effects to CSS', () => {
		const crop = fx('jasper.crop', { left: 10, top: 0, right: 20, bottom: 0 });
		const blur = fx('jasper.gaussian-blur', { radius: 2 });
		const bc = fx('jasper.brightness-contrast', { brightness: 10 });
		const hs = fx('jasper.hue-saturation', { hue: 30 });
		const glow = fx('test.s.glow', { radius: 5 });
		const flip = fx('jasper.flip-horizontal');
		const shadow = fx('test.drop-shadow', { distance: 4, softness: 2 });
		const after = fx('jasper.gaussian-blur', { radius: 2, dimensions: 'horizontal' });
		const p = planLayerFx([blur, bc, hs, glow, crop, flip, shadow, after], opts)!;
		expect(p.active).toBe(true);
		expect(kinds(p)).toEqual(['crop', 'css', 'lut', 'gpu', 'flip', 'gpu']);
		const lut = p.steps[2]!;
		expect(lut.kind === 'lut' && lut.effects.map((e) => e.id)).toEqual([bc.id, hs.id]);
		const c = p.steps[0]!;
		expect(c.kind === 'crop' && c.insets).toEqual([0.1, 0, 0.2, 0]);
		expect(p.cssEffects.map((e) => e.id)).toEqual([after.id]);
		expect(p.reordered).toEqual([]);
		expect(p.padding).toEqual({ left: 25, top: 25, right: 25, bottom: 25 }); // 3×5 + (4 + 3×2)
	});

	it('runs SVG-filter built-ins before a shader effect as GPU stand-ins, in stack order', () => {
		const svgBlur = fx('jasper.gaussian-blur', { radius: 2, dimensions: 'vertical' });
		const glow = fx('test.s.glow');
		const p = planLayerFx([svgBlur, glow], opts)!;
		expect(kinds(p)).toEqual(['gpu', 'gpu']);
		const first = p.steps[0]!;
		expect(first.kind === 'gpu' && first.fx.id === svgBlur.id && first.spec.id).toBe('jasper.gaussian-blur');
		expect(p.reordered).toEqual([]);
		expect(p.cssEffects).toEqual([]);
		// Repeat Edge Pixels keeps the picture in the box (no padding); without it the blur pads by 3σ.
		expect(first.kind === 'gpu' && first.padding.top).toBe(6);
		const edge = planLayerFx([fx('jasper.gaussian-blur', { radius: 2, repeatEdge: true }), glow], opts)!;
		expect(edge.steps[0]!.kind === 'gpu' && edge.steps[0]!.padding.top).toBe(0);
		// Equal sigmas stay the exact 2D canvas blur().
		const plain = planLayerFx([fx('jasper.gaussian-blur', { radius: 2 }), glow], opts)!;
		expect(kinds(plain)).toEqual(['css', 'gpu']);
	});

	it('keeps colour after the last shader effect in the chain (exact grade), CSS after the last colour run', () => {
		const glow = fx('test.s.glow');
		const css = fx('jasper.black-white', { amount: 0 });
		const blur = fx('jasper.gaussian-blur', { radius: 1 });
		const p = planLayerFx([glow, css, blur], opts)!;
		expect(kinds(p)).toEqual(['gpu', 'lut']);
		expect(p.cssEffects.map((e) => e.id)).toEqual([blur.id]);
	});

	it('skips the corner pin (the layer matrix applies it after every effect)', () => {
		const pin = fx('jasper.corner-pin');
		const p = planLayerFx([pin, fx('test.s.gradient')], opts)!;
		expect(kinds(p)).toEqual(['gpu']);
		expect(p.cssEffects).toEqual([]);
	});

	it('bypasses shader effects without a GPU (inactive plan) and failed shaders alone', () => {
		const glow = fx('test.s.glow');
		const grad = fx('test.s.gradient');
		const off = planLayerFx([glow], { ...opts, gpu: 'unavailable' })!;
		expect(off.active).toBe(false);
		expect(off.bypassed).toEqual([{ fxId: glow.id, effectId: 'test.s.glow', reason: 'gpu-unavailable' }]);
		const failed = planLayerFx([glow, grad], { ...opts, failed: (id) => id === 'test.s.glow' })!;
		expect(failed.active).toBe(true);
		expect(kinds(failed)).toEqual(['gpu']);
		expect(failed.bypassed.map((b) => b.reason)).toEqual(['shader-failed']);
		const allFailed = planLayerFx([glow], { ...opts, failed: () => true })!;
		expect(allFailed.active).toBe(false);
	});

	it('drops colour effects in the before/after bypass (S06:CGU-005)', () => {
		const p = planLayerFx([fx('jasper.brightness-contrast', { brightness: 5 }), fx('test.s.glow')], {
			...opts,
			colorBypass: true,
		})!;
		expect(kinds(p)).toEqual(['gpu']);
	});

	it('flags time-dependent stacks', () => {
		expect(planLayerFx([fx('test.s.gradient')], opts)!.timeDependent).toBe(false);
		expect(planLayerFx([fx('test.s.glow')], opts)!.timeDependent).toBe(true);
	});
});

describe('fxCanvasLayout', () => {
	it('grows the box by the padding in integer CSS pixels and scales down only huge canvases', () => {
		const l = fxCanvasLayout({ width: 100.5, height: 50 }, { left: 10, top: 5, right: 0, bottom: 5 }, 8192);
		expect([l.width, l.height, l.cssWidth, l.cssHeight, l.pxScale]).toEqual([111, 60, 111, 60, 1]);
		expect(l.box).toEqual({ x: 10, y: 5, w: 100.5, h: 50 });
		const big = fxCanvasLayout(
			{ width: 16000, height: 1000 },
			{ left: 0, top: 0, right: 0, bottom: 0 },
			8000,
		);
		expect(big.pxScale).toBe(0.5);
		expect([big.width, big.height, big.cssWidth]).toEqual([8000, 500, 16000]);
	});
});

describe('time hooks in the composition', () => {
	const clip = { clipId: 'c1', duration: 60, headHandle: 0, tailHandle: 0 };

	it('remaps the source frame with the enabled time effects only', () => {
		expect(fxRemapFrame(clip, [fx('test.s.glow')], 10, 30, testFxRegistry)).toBeNull();
		expect(fxRemapFrame(clip, [fx('test.s.freeze-frame', { at: 7 })], 30, 30, testFxRegistry)).toBe(7);
		expect(
			fxRemapFrame(clip, [fx('test.s.freeze-frame', { at: 7 }, false)], 30, 30, testFxRegistry),
		).toBeNull();
	});

	it('jitter is deterministic per frame (random seek, parallel renders)', () => {
		const j = fx('test.s.jitter-frames', { amount: 5 });
		const run = () =>
			Array.from({ length: 40 }, (_, f) => fxRemapFrame(clip, [j], f + 10, 30, testFxRegistry));
		const a = run();
		expect(run()).toEqual(a);
		expect(new Set(a.map((x, i) => x! - (i + 10))).size).toBeGreaterThan(3);
		for (const [i, x] of a.entries()) expect(Math.abs(x! - (i + 10))).toBeLessThanOrEqual(5);
	});

	it('makes layers with time-dependent shader effects frame dependent', () => {
		const e = (effectId: string): EffectInstance => ({
			id: 'x',
			effectId,
			effectVersion: 1,
			enabled: true,
			params: {},
		});
		expect(hasTimeDependentFx({ effects: [e('test.s.glow')] }, testFxRegistry)).toBe(true);
		expect(hasTimeDependentFx({ effects: [e('test.s.gradient')] }, testFxRegistry)).toBe(false);
		expect(hasTimeDependentFx({ effects: [e('jasper.crop')] }, testFxRegistry)).toBe(false);
	});
});

describe('example effects', () => {
	it('are valid GPU effects', () => {
		expect(TEST_FX.flatMap((s) => validateGpuEffect(s))).toEqual([]);
	});
});
