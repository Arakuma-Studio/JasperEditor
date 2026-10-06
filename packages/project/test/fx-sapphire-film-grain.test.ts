// The Sapphire film / grain / damage family (registry/fx/sapphire-film-grain.ts): catalogue entries (Sapphire names,
// ids, bins, Sapphire defaults), and the TypeScript maths of the family — grain-hold cadence, S_Grain presets, the
// film-stock balance, JPEG quantiser steps, per-frame signals (flicker, shake, defocus, flash motion, blinks, roll),
// grunge stamp occupancy and the time-sample hooks. Pixels are checked in packages/compositions (GL test).
import { describe, expect, it } from 'vitest';
import {
	defaultEffectRegistry,
	type EffectParams,
	type EffectSpec,
	FX_FAMILIES,
	fxSeed,
	paramUniforms,
	SAPPHIRE_BINS,
	validateGpuEffect,
} from '../src/index.ts';
import { grainFrame, sapphirePoint } from '../src/registry/fx/sapphire-film-grain/common.ts';
import {
	digitalDamageGates,
	freezeOffset,
	jpegQualityScale,
	jpegSteps,
} from '../src/registry/fx/sapphire-film-grain/digital.ts';
import { filmDamageSignals, flashMotion } from '../src/registry/fx/sapphire-film-grain/film.ts';
import { grungeLayerUniforms, grungeStyle } from '../src/registry/fx/sapphire-film-grain/grunge.ts';
import { GRAIN_PRESETS, grainSettings } from '../src/registry/fx/sapphire-film-grain/looks.ts';
import { E_GREY, filmStockUniforms, NEG_RANGE } from '../src/registry/fx/sapphire-film-grain/stocks.ts';
import { tvRoll } from '../src/registry/fx/sapphire-film-grain/video.ts';
import { SAPPHIRE_FILM_GRAIN_EFFECTS } from '../src/registry/fx/sapphire-film-grain.ts';

const EXPECTED: [string, string, string][] = [
	['S_FilmEffect', 'jasper.s.film-effect', SAPPHIRE_BINS.stylize],
	['S_FilmDamage', 'jasper.s.film-damage', SAPPHIRE_BINS.stylize],
	['S_FilmBurn', 'jasper.s.film-burn', SAPPHIRE_BINS.stylize],
	['S_Vignette', 'jasper.s.vignette', SAPPHIRE_BINS.stylize],
	['S_BleachBypass', 'jasper.s.bleach-bypass', SAPPHIRE_BINS.stylize],
	['S_Grain', 'jasper.s.grain', SAPPHIRE_BINS.stylize],
	['S_GrainStatic', 'jasper.s.grain-static', SAPPHIRE_BINS.stylize],
	['S_UltraGrain', 'jasper.s.ultra-grain', SAPPHIRE_BINS.stylize],
	['S_Diffuse', 'jasper.s.diffuse', SAPPHIRE_BINS.stylize],
	['S_VintageColor2Strip', 'jasper.s.vintage-color-2strip', SAPPHIRE_BINS.stylize],
	['S_VintageColor3Strip', 'jasper.s.vintage-color-3strip', SAPPHIRE_BINS.stylize],
	['S_ScanLines', 'jasper.s.scan-lines', SAPPHIRE_BINS.stylize],
	['S_ScanLinesMono', 'jasper.s.scan-lines-mono', SAPPHIRE_BINS.stylize],
	['S_VHSDamage', 'jasper.s.vhs-damage', SAPPHIRE_BINS.stylize],
	['S_TVDamage', 'jasper.s.tv-damage', SAPPHIRE_BINS.stylize],
	['S_JpegDamage', 'jasper.s.jpeg-damage', SAPPHIRE_BINS.stylize],
	['S_DigitalDamage', 'jasper.s.digital-damage', SAPPHIRE_BINS.stylize],
	['S_Grunge', 'jasper.s.grunge', SAPPHIRE_BINS.render],
];

const spec = (id: string) => SAPPHIRE_FILM_GRAIN_EFFECTS.find((s) => s.id === id)!;
const defaults = (s: EffectSpec, over: EffectParams = {}): EffectParams => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});
const param = (id: string, name: string) => spec(id).params.find((p) => p.name === name);
const ctx = {
	width: 1920,
	height: 1080,
	pxScale: 1,
	fps: 30,
	frame: 0,
	duration: 300,
	seed: 0.37,
	progress: 0,
};

describe('sapphire-film-grain catalogue', () => {
	it('has every effect of the family with its Sapphire label, id and bin, registered by default', () => {
		expect(SAPPHIRE_FILM_GRAIN_EFFECTS.map((s) => [s.label, s.id, s.bin]).sort()).toEqual(
			[...EXPECTED].sort(),
		);
		expect(FX_FAMILIES.find((f) => f.file === 'sapphire-film-grain')!.effects).toBe(
			SAPPHIRE_FILM_GRAIN_EFFECTS,
		);
		for (const s of SAPPHIRE_FILM_GRAIN_EFFECTS) {
			expect(defaultEffectRegistry.get(s.id)).toBe(s);
			expect(validateGpuEffect(s)).toEqual([]);
			expect(s.description!.length).toBeGreaterThan(40);
		}
	});

	it('numeric, colour and point params are keyframable; enums and checkboxes hold', () => {
		for (const s of SAPPHIRE_FILM_GRAIN_EFFECTS)
			for (const p of s.params) {
				if (p.name === 'seed') continue;
				const kf = p.type === 'number' || p.type === 'color' || p.type === 'vec2';
				expect(p.animatable, `${s.id}.${p.name}`).toBe(kf);
			}
	});

	it('uses Sapphire parameter names and defaults', () => {
		expect(param('jasper.s.film-damage', 'scratches')).toMatchObject({ label: 'Scratches', default: 5 });
		expect(param('jasper.s.film-damage', 'dustDensity')).toMatchObject({
			label: 'Dust Density',
			default: 30,
		});
		expect(param('jasper.s.film-damage', 'hairPersistence')).toMatchObject({
			label: 'Hair Persistence',
			default: 3,
		});
		expect(param('jasper.s.film-effect', 'negFilm')).toMatchObject({ label: 'Neg Film', default: 'k5245' });
		expect(param('jasper.s.film-effect', 'printFilm')).toMatchObject({
			label: 'Print Film',
			default: 'k2383',
		});
		expect(param('jasper.s.film-effect', 'printLightsRed')).toMatchObject({
			default: 25,
			range: { min: 0, max: 50 },
		});
		expect(param('jasper.s.vignette', 'radius')).toMatchObject({ label: 'Radius', default: 0.9 });
		expect(param('jasper.s.vignette', 'relHeight')).toMatchObject({ label: 'Rel Height', default: 0.75 });
		expect(param('jasper.s.grain', 'colorFrequency')).toMatchObject({
			label: 'Color Frequency',
			default: 100,
		});
		expect(param('jasper.s.ultra-grain', 'grainAmpRed')).toMatchObject({ default: 3.29 });
		expect(param('jasper.s.jpeg-damage', 'quality')).toMatchObject({ label: 'Quality', default: 0.1 });
		expect(param('jasper.s.jpeg-damage', 'seed')).toMatchObject({ label: 'Rand Seed' });
		expect(param('jasper.s.tv-damage', 'receptionMaster')).toMatchObject({
			label: 'Reception Master',
			default: 0.4,
		});
		expect(param('jasper.s.vhs-damage', 'mixWithOriginal')).toMatchObject({
			label: 'Mix With Source',
			default: 0,
		});
		expect(param('jasper.s.vhs-damage', 'seed')).toMatchObject({ label: 'Random Seed' });
		expect(param('jasper.s.grunge', 'stamp1')).toMatchObject({ label: 'Stamp1', default: 'garageFloor' });
		expect(param('jasper.s.scan-lines', 'linesFrequency')).toMatchObject({
			label: 'Lines Frequency',
			default: 50,
		});
		expect(param('jasper.s.vintage-color-2strip', 'cyanDye')).toMatchObject({ default: [0.02, 1, 0.91, 1] });
	});

	it('a Seed param feeds u_seed (no own uniform) and changes it', () => {
		const s = spec('jasper.s.film-damage');
		expect(paramUniforms(s, defaults(s)).some((u) => u.name === 'u_seed')).toBe(false);
		expect(fxSeed('c1', 'fx1', { seed: 1 })).not.toBe(fxSeed('c1', 'fx1', { seed: 2 }));
	});

	it('marks the multi-pass / heavy effects expensive', () => {
		for (const id of [
			'jasper.s.film-damage',
			'jasper.s.vhs-damage',
			'jasper.s.jpeg-damage',
			'jasper.s.grunge',
		])
			expect(spec(id).expensive).toBe(true);
		expect(spec('jasper.s.vignette').expensive).toBeUndefined();
	});

	it('only the static looks are time-invariant', () => {
		const inv = SAPPHIRE_FILM_GRAIN_EFFECTS.filter((s) => s.gpu!.timeInvariant).map((s) => s.id);
		expect(inv).toEqual(['jasper.s.vignette']);
	});
});

describe('sapphire-film-grain maths', () => {
	it('Grain Hold: Frame = new pattern each frame; 3:2 = 4 patterns per 5 frames', () => {
		expect([0, 1, 2, 3].map((f) => grainFrame('frame', f))).toEqual([0, 1, 2, 3]);
		const pd = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((f) => grainFrame('pulldown0', f));
		expect(new Set(pd.slice(0, 5)).size).toBe(4);
		expect(pd).toEqual([...pd].sort((a, b) => a - b));
		expect(grainFrame('pulldown2', 0)).not.toBe(grainFrame('pulldown0', 0) + 5);
	});

	it('Sapphire centred points map onto the layer box', () => {
		expect(sapphirePoint(0, 0)).toEqual([0.5, 0.5]);
		expect(sapphirePoint(-1, 0)).toEqual([0, 0.5]);
		expect(sapphirePoint(1, 0.5625)).toEqual([1, 0]);
	});

	it('S_Grain: Custom uses the sliders, a film stock scales its own grain by them', () => {
		const p = defaults(spec('jasper.s.grain'));
		expect(grainSettings(p)).toMatchObject({ amp: 0.1, freq: 100, oct: 1, bw: 0 });
		const k = grainSettings({ ...p, filmStock: 'k5279' });
		expect(k.amp).toBeCloseTo(GRAIN_PRESETS.k5279!.amp);
		expect(k.freq).toBeCloseTo(GRAIN_PRESETS.k5279!.freq);
		const twice = grainSettings({ ...p, filmStock: 'k5279', colorAmplitude: 0.2 });
		expect(twice.amp).toBeCloseTo(2 * GRAIN_PRESETS.k5279!.amp);
		expect(grainSettings({ ...p, filmStock: 'triX' }).amp).toBe(0);
	});

	it('film stocks keep an 18 % grey neutral at the default printer lights; lights tint it', () => {
		const sig = (x: number) => 1 / (1 + Math.exp(-x));
		const grey = (p: EffectParams) => {
			const u = filmStockUniforms(p) as Record<string, number[] | number>;
			const g = u.u_negGamma as number[];
			const gp = u.u_printGamma as number[];
			const off = u.u_printOffset as number[];
			return [0, 1, 2].map((c) => {
				const dn = NEG_RANGE * sig((4 * g[c]! * (Math.log10(0.18) - E_GREY)) / NEG_RANGE);
				const ep = -dn + off[c]!;
				const R = u.u_printRange as number;
				return 10 ** -(R * sig((4 * gp[c]! * ep) / R));
			});
		};
		const s = spec('jasper.s.film-effect');
		for (const neg of ['k5245', 'k5279', 'k5284']) {
			const [r, g, b] = grey(defaults(s, { negFilm: neg }));
			expect(r).toBeCloseTo(0.18, 3);
			expect(g).toBeCloseTo(0.18, 3);
			expect(b).toBeCloseTo(0.18, 3);
		}
		const [r] = grey(defaults(s, { printLightsRed: 37 }));
		expect(r).toBeLessThan(0.15); // more red printer light → more cyan → less red
	});

	it('JPEG quantiser follows libjpeg quality scaling', () => {
		expect(jpegQualityScale(0.5)).toBe(100);
		expect(jpegQualityScale(0.1)).toBe(500);
		expect(jpegQualityScale(1)).toBe(0);
		const s = jpegSteps(0.5);
		expect(s.luma[0]).toBeCloseTo(16 / 255);
		expect(s.chroma[63]).toBeCloseTo(99 / 255);
		expect(jpegSteps(1).luma.every((v) => v === 1 / 255)).toBe(true);
		expect(jpegSteps(0.1).luma[0]).toBeCloseTo(80 / 255);
	});

	it('S_FilmDamage signals are deterministic, vary per frame and follow their masters', () => {
		const p = defaults(spec('jasper.s.film-damage'), { shakeAmplitude: 1, shakeAlways: 1, defocus: 1 });
		const a = filmDamageSignals(p, { ...ctx, frame: 12 });
		expect(filmDamageSignals(p, { ...ctx, frame: 12 })).toEqual(a);
		const frames = Array.from({ length: 30 }, (_, f) => filmDamageSignals(p, { ...ctx, frame: f }));
		expect(new Set(frames.map((s) => s.flicker.toFixed(5))).size).toBeGreaterThan(10);
		expect(new Set(frames.map((s) => s.shake.toFixed(5))).size).toBeGreaterThan(10);
		expect(frames.every((s) => s.defocus >= 0)).toBe(true);
		const still = filmDamageSignals(
			{ ...p, flicker: 0, shakeAmplitude: 0, defocus: 0 },
			{ ...ctx, frame: 5 },
		);
		expect(still).toMatchObject({ flicker: 1, shake: 0, defocus: 0 });
	});

	it('S_FilmBurn flashes move (Linear: triangle, Wave: sine) within Motion Amount', () => {
		const p = defaults(spec('jasper.s.film-burn'));
		const xs = Array.from(
			{ length: 60 },
			(_, f) => flashMotion(p, 1, { frame: f, fps: 30, seed: 0.3 }).move[0],
		);
		expect(Math.max(...xs.map(Math.abs))).toBeLessThanOrEqual(0.5 + 1e-9);
		expect(new Set(xs.map((x) => x.toFixed(4))).size).toBeGreaterThan(20);
		const still = flashMotion({ ...p, motionAmount1: 0 }, 1, { frame: 10, fps: 30, seed: 0.3 });
		expect(still.move.map((v) => Math.abs(v))).toEqual([0, 0]);
	});

	it('S_DigitalDamage blinks: Always 0 = never, 1 = always; Freeze Frames holds every Nth frame', () => {
		const p = defaults(spec('jasper.s.digital-damage'));
		const never = digitalDamageGates({ ...p, shiftAlways: 0 }, { frame: 7, fps: 30, seed: 0.4 });
		expect(never.u_on_shift).toBe(0);
		const always = digitalDamageGates({ ...p, shiftAlways: 1 }, { frame: 7, fps: 30, seed: 0.4 });
		expect(always.u_on_shift).toBe(1);
		expect(
			digitalDamageGates({ ...p, shift: false, shiftAlways: 1 }, { frame: 7, fps: 30, seed: 0.4 }).u_on_shift,
		).toBe(0);
		expect([10, 11, 19, 20].map((f) => freezeOffset(p, f))).toEqual([-0, -1, -9, -0]);
		expect(freezeOffset({ ...p, freezeFrames: 1 }, 13)).toBe(0);
		const samples = spec('jasper.s.digital-damage').gpu!.time!.samples!;
		const tctx = { frame: 13, fps: 30, duration: 300, headHandle: 0, tailHandle: 0, seed: 0.4 };
		expect(samples(p, tctx)).toEqual([-3]);
		expect(samples({ ...p, freeze: false, flow: false }, tctx)).toEqual([]);
	});

	it('S_VHSDamage samples the next frame only for Interlaced Combing', () => {
		const s = spec('jasper.s.vhs-damage');
		const tctx = { frame: 3, fps: 30, duration: 300, headHandle: 0, tailHandle: 0, seed: 0.4 };
		expect(s.gpu!.time!.samples!(defaults(s), tctx)).toEqual([]);
		expect(s.gpu!.time!.samples!(defaults(s, { interlacedCombing: true }), tctx)).toEqual([1]);
	});

	it('S_TVDamage rolls only with vertical hold trouble', () => {
		const p = defaults(spec('jasper.s.tv-damage'));
		expect(tvRoll({ ...p, verticalHold: 0 }, { frame: 40, fps: 30, seed: 0.2 })).toEqual({
			rolling: false,
			roll: 0,
		});
		const rolls = Array.from({ length: 120 }, (_, f) =>
			tvRoll({ ...p, verticalHold: 1, receptionMaster: 1 }, { frame: f, fps: 30, seed: 0.2 }),
		);
		expect(rolls.every((r) => r.rolling)).toBe(true);
		expect(new Set(rolls.map((r) => r.roll.toFixed(4))).size).toBeGreaterThan(60);
	});

	it('S_Grunge: stamp cells cover the stamp radius, occupancy ≤ 1, one pass per active collection', () => {
		const s = spec('jasper.s.grunge');
		const p = defaults(s);
		expect([1, 2, 3].map((i) => grungeStyle(p, i) > 0)).toEqual([true, true, false]);
		const u = grungeLayerUniforms(p, 1, ctx) as Record<string, number>;
		expect(u.u_lCell).toBeGreaterThanOrEqual(u.u_lSize!);
		expect(u.u_lDens).toBeGreaterThan(0);
		expect(u.u_lDens).toBeLessThanOrEqual(1);
		const passes = (q: EffectParams) =>
			(s.gpu!.passes as (p: EffectParams, c: typeof ctx) => readonly unknown[])(q, ctx).length;
		expect(passes(p)).toBe(3); // two collections + composite
		expect(passes({ ...p, stamp2: 'none' })).toBe(2);
		expect(passes({ ...p, blurGrunge: 0.5 })).toBe(5);
	});

	it('pass counts follow the options (blur / glow / defocus passes only when used)', () => {
		const n = (id: string, over: EffectParams = {}) => {
			const s = spec(id);
			const ps = s.gpu!.passes;
			return (typeof ps === 'function' ? ps(defaults(s, over), ctx) : ps).length;
		};
		expect(n('jasper.s.vignette')).toBe(1);
		expect(n('jasper.s.vignette', { blurAmount: 0.5 })).toBe(3);
		expect(n('jasper.s.film-effect')).toBe(1);
		expect(n('jasper.s.film-effect', { glowBrightness: 0.5 })).toBe(7);
		expect(n('jasper.s.film-damage')).toBe(3);
		expect(n('jasper.s.film-damage', { defocus: 1 })).toBe(5);
		expect(n('jasper.s.jpeg-damage')).toBe(4);
		expect(n('jasper.s.tv-damage')).toBe(1);
		expect(n('jasper.s.tv-damage', { orthicon: 1 })).toBe(4);
	});
});
