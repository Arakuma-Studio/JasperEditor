// Colour stage of the compositions (S06 §4.1): chain planning (colour runs as canvas passes, stack order), LUT
// asset loading/caching, the per-layer bake LRU, and the before/after bypass. The WebGL shader itself is
// verified against the TS reference in real Chrome (engine Remotion test, e2e/color.spec.ts).
import {
	bakeLut,
	defaultEffectRegistry,
	LUMETRI_EFFECT_ID,
	type Lut,
	type ResolvedEffect,
	serializeCube,
} from '@jasper/project';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BAKES_PER_LAYER,
	bakedRunLut,
	clearLutAssets,
	colorStageStatus,
	dropLayerBakes,
	FRAGMENT_SHADER,
	loadedLutAsset,
	loadLutAsset,
	lutUrlKey,
	planColorStage,
	referencedMedia,
} from '../src/index.ts';

const fx = (
	id: string,
	effectId: string,
	params: Record<string, unknown> = {},
	enabled = true,
): ResolvedEffect => ({
	id,
	effectId,
	effectVersion: 1,
	enabled,
	params: params as ResolvedEffect['params'],
});

afterEach(() => {
	clearLutAssets();
	dropLayerBakes();
	colorStageStatus.reset();
});

describe('planColorStage (S06:CG-040)', () => {
	it('ungraded layers keep every effect as a CSS stage', () => {
		const effects = [fx('a', 'jasper.crop', { left: 10 }), fx('b', 'jasper.gaussian-blur', { radius: 3 })];
		const p = planColorStage(effects, { webgl: true, bypass: false });
		expect(p.graded).toBe(false);
		expect(p.steps).toEqual([]);
		expect(p.cssEffects.map((e) => e.id)).toEqual(['a', 'b']);
	});

	it('consecutive colour effects fuse into one LUT pass like the engine (effectRuns)', () => {
		const effects = [
			fx('a', 'jasper.brightness-contrast', { brightness: 10 }),
			fx('b', LUMETRI_EFFECT_ID, { exposure: 1 }),
			fx('c', 'jasper.flip-horizontal'),
			fx('d', 'jasper.black-white', { amount: 50 }),
			fx('e', 'jasper.gaussian-blur', { radius: 4 }),
		];
		const p = planColorStage(effects, { webgl: true, bypass: false });
		expect(
			p.steps.map((s) => (s.kind === 'lut' ? s.effects.map((e) => e.id).join('+') : s.effect.id)),
		).toEqual(['a+b', 'd']);
		// The flip commutes with pointwise colour; the blur is after the last run: both stay CSS stages.
		expect(p.cssEffects.map((e) => e.id)).toEqual(['c', 'e']);
		expect(p.reordered).toEqual([]);
	});

	it('a CSS-filter effect before a grade becomes a canvas pass in stack order', () => {
		const effects = [
			fx('blur', 'jasper.gaussian-blur', { radius: 5 }),
			fx('g', LUMETRI_EFFECT_ID, { contrast: 20 }),
			fx('crop', 'jasper.crop', { top: 10 }),
		];
		const p = planColorStage(effects, { webgl: true, bypass: false });
		expect(p.steps.map((s) => s.kind)).toEqual(['css', 'lut']);
		expect(p.steps[0]).toMatchObject({ kind: 'css', filter: 'blur(5px)' });
		expect(p.cssEffects.map((e) => e.id)).toEqual(['crop']);
	});

	it('an effect without a canvas realization before a grade is reported as reordered', () => {
		const effects = [
			fx('blur', 'jasper.gaussian-blur', { radius: 5, dimensions: 'horizontal' }), // SVG filter only
			fx('g', LUMETRI_EFFECT_ID, { contrast: 20 }),
		];
		const p = planColorStage(effects, { webgl: true, bypass: false });
		expect(p.reordered).toEqual(['blur']);
		expect(p.cssEffects.map((e) => e.id)).toEqual(['blur']);
	});

	it('without WebGL2 the M1 colour effects fall back to CSS and Lumetri is dropped (chip)', () => {
		const effects = [
			fx('g', LUMETRI_EFFECT_ID, { contrast: 20 }),
			fx('bw', 'jasper.black-white', { amount: 100 }),
		];
		const p = planColorStage(effects, { webgl: false, bypass: false });
		expect(p.unavailable).toBe(true);
		expect(p.steps).toEqual([]);
		expect(p.cssEffects.map((e) => e.id)).toEqual(['bw']);
	});

	it('before/after bypass drops every colour effect (CGU-005)', () => {
		const effects = [
			fx('g', LUMETRI_EFFECT_ID, { contrast: 20 }),
			fx('bw', 'jasper.black-white', { amount: 100 }),
			fx('c', 'jasper.crop', { left: 5 }),
		];
		const p = planColorStage(effects, { webgl: true, bypass: true });
		expect(p.steps).toEqual([]);
		expect(p.unavailable).toBe(false);
		expect(p.cssEffects.map((e) => e.id)).toEqual(['c']);
	});

	it('disabled colour effects are ignored', () => {
		const p = planColorStage([fx('g', LUMETRI_EFFECT_ID, { contrast: 20 }, false)], {
			webgl: true,
			bypass: false,
		});
		expect(p.graded).toBe(false);
	});

	it('lists referenced LUT media', () => {
		expect(
			referencedMedia([
				fx('g', LUMETRI_EFFECT_ID, { look: { mediaId: 'med_A' }, inputLut: { mediaId: '' }, exposure: 1 }),
			]),
		).toEqual(['med_A']);
	});
});

describe('LUT assets and bakes (S06:LUT-003, CG-013)', () => {
	const cube = serializeCube(
		bakeLut(3, (c) => {
			c[0] = 1 - c[0];
		}),
	);

	it('fetches and parses a LUT once per URL (signature ignored)', async () => {
		const fetchImpl = vi.fn(async () => new Response(cube)) as unknown as typeof fetch;
		const a = await loadLutAsset('http://e/media/mk_1?sig=a', fetchImpl);
		const b = await loadLutAsset('http://e/media/mk_1?sig=b', fetchImpl);
		expect(a).toBe(b);
		expect(a?.size).toBe(3);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(loadedLutAsset('http://e/media/mk_1')).toBe(a);
		expect(lutUrlKey('/media/mk_1?x#y')).toBe('/media/mk_1');
	});

	it('a failing LUT resolves null (the grade skips it)', async () => {
		const fetchImpl = vi.fn(async () => new Response('LUT_3D_SIZE 2\n0 0 0\n', { status: 200 })) as never;
		expect(await loadLutAsset('/media/bad', fetchImpl)).toBeNull();
		expect(loadedLutAsset('/media/bad')).toBeNull();
		expect(loadedLutAsset('/media/unknown')).toBeUndefined();
	});

	it('bakes once per run key and keeps an LRU of 64 per layer', () => {
		const effects = [fx('g', LUMETRI_EFFECT_ID, { exposure: 0.5 })];
		const lut = () => null;
		const a = bakedRunLut('clp_1', 'k1', effects, defaultEffectRegistry, lut, 17) as Lut;
		expect(a.size).toBe(17);
		expect(bakedRunLut('clp_1', 'k1', effects, defaultEffectRegistry, lut, 17)).toBe(a);
		for (let i = 0; i < BAKES_PER_LAYER; i++)
			bakedRunLut('clp_1', `x${i}`, effects, defaultEffectRegistry, lut, 5);
		expect(bakedRunLut('clp_1', 'k1', effects, defaultEffectRegistry, lut, 17)).not.toBe(a);
		// Identity runs bake to null.
		expect(
			bakedRunLut('clp_2', 'id', [fx('g', LUMETRI_EFFECT_ID, {})], defaultEffectRegistry, lut, 17),
		).toBeNull();
	});
});

describe('shader (S06:CG-040)', () => {
	it('samples the LUT with texelFetch (no hardware filtering) and keeps straight alpha', () => {
		expect(FRAGMENT_SHADER).toContain('texelFetch(u_lut');
		expect(FRAGMENT_SHADER).not.toMatch(/texture\(u_lut/);
		expect(FRAGMENT_SHADER).toContain('o_color = vec4(rgb * s.a, s.a)');
	});

	it('context loss flips the stage status and restores it (CG-045)', () => {
		expect(['ok', 'unavailable']).toContain(colorStageStatus.get());
		colorStageStatus.contextLost();
		if (colorStageStatus.get() !== 'unavailable') expect(colorStageStatus.get()).toBe('lost');
		colorStageStatus.contextRestored();
		expect(colorStageStatus.get()).not.toBe('lost');
	});
});
