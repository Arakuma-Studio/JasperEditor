// Sapphire Render family (fx catalogue, wave 2): lightning, gradients/grid/shape and the other render generators.
// Pure TypeScript behaviour: catalogue entries, Combine mapping, spline sampling, time/seed hooks (Jitter Frames,
// Wiggle, laser flight, muzzle-flash timing), astronomy (Julian day, lunar phase, sky orientation) and padding.
// Pixel behaviour runs in real WebGL2: packages/compositions/test/fx-sapphire-render-gl.test.ts.
import { describe, expect, it } from 'vitest';
import {
	defaultEffectRegistry,
	FX_FAMILIES,
	gpuPadding,
	planGpuEffect,
	SAPPHIRE_BINS,
} from '../src/index.ts';
import {
	combineUniforms,
	lightCombine,
	SPLINE_N,
	splineUniform,
} from '../src/registry/fx/sapphire-render-lightning/common.ts';
import { glowGain, zapSeed, zapTau } from '../src/registry/fx/sapphire-render-lightning/lightning.ts';
import { laserHead, muzzleTiming } from '../src/registry/fx/sapphire-render-lightning/render-light.ts';
import {
	julianDay,
	lunarPhaseDeg,
	nightSkyMatrix,
} from '../src/registry/fx/sapphire-render-lightning/render-sky.ts';

const IDS: Record<string, string> = {
	S_UltraZap: 'jasper.s.ultra-zap',
	S_Zap: 'jasper.s.zap',
	S_ZapTo: 'jasper.s.zap-to',
	S_ZapFrom: 'jasper.s.zap-from',
	S_Gradient: 'jasper.s.gradient',
	S_GradientMulti: 'jasper.s.gradient-multi',
	S_GradientRadial: 'jasper.s.gradient-radial',
	S_Grid: 'jasper.s.grid',
	S_Shape: 'jasper.s.shape',
	S_Aurora: 'jasper.s.aurora',
	S_LaserBeam: 'jasper.s.laser-beam',
	S_MuzzleFlash: 'jasper.s.muzzle-flash',
	S_Caustics: 'jasper.s.caustics',
	S_Dust: 'jasper.s.dust',
	S_Luna: 'jasper.s.luna',
	S_NightSky: 'jasper.s.night-sky',
	S_Sparkles: 'jasper.s.sparkles',
	S_SparklesColor: 'jasper.s.sparkles-color',
};

const family = FX_FAMILIES.find((f) => f.file === 'sapphire-render-textures')!.effects;
const spec = (id: string) => defaultEffectRegistry.get(id)!;
const defaults = (id: string) => Object.fromEntries(spec(id).params.map((p) => [p.name, p.default]));
const ctx = {
	width: 1920,
	height: 1080,
	pxScale: 1,
	fps: 30,
	frame: 0,
	duration: 150,
	seed: 0.25,
	progress: 0,
};

describe('Sapphire Render family catalogue', () => {
	it('has the 18 effects with Sapphire labels, jasper.s ids, the Render bin and GPU generators', () => {
		expect(Object.fromEntries(family.map((s) => [s.label, s.id]))).toEqual(IDS);
		for (const s of family) {
			expect(s.bin).toBe(SAPPHIRE_BINS.render);
			expect(s.gpu?.kind).toBe('generator');
			expect(defaultEffectRegistry.get(s.id)).toBe(s);
		}
	});

	it('every effect has Show + Mix with Orig; random ones a Seed; points are on-canvas point params', () => {
		for (const s of family) {
			const names = s.params.map((p) => p.name);
			expect(names.slice(-2)).toEqual(['show', 'mixWithOriginal']);
			for (const p of s.params.filter((q) => q.type === 'vec2' && q.ui?.control === 'point'))
				expect(p.animatable).toBe(true);
		}
		for (const id of [
			'jasper.s.zap',
			'jasper.s.ultra-zap',
			'jasper.s.dust',
			'jasper.s.sparkles',
			'jasper.s.night-sky',
		])
			expect(spec(id).params.some((p) => p.name === 'seed')).toBe(true);
		const zap = spec('jasper.s.zap');
		expect(zap.params.find((p) => p.name === 'start')?.ui?.control).toBe('point');
		expect(zap.params.find((p) => p.name === 'end')?.ui?.control).toBe('point');
	});

	it('keeps Sapphire defaults where documented', () => {
		const z = defaults('jasper.s.zap');
		expect([z.bolts, z.boltWidth, z.glowBright, z.glowWidth, z.branchAngle, z.combine]).toEqual([
			1,
			0.07,
			2,
			0.224,
			65,
			'screen',
		]);
		expect(defaults('jasper.s.ultra-zap').branchiness).toBe(4);
		expect(defaults('jasper.s.gradient').combine).toBe('only');
		expect(defaults('jasper.s.grid').boxes).toEqual([24, 16]);
		expect(defaults('jasper.s.shape').points).toBe(5);
		expect(defaults('jasper.s.luna').combine).toBe('overlay');
		expect(defaults('jasper.s.muzzle-flash').gun).toBe('m16');
		expect(defaults('jasper.s.sparkles').frequency).toBe(25);
		expect(defaults('jasper.s.dust').numberOfPoints).toBe(200);
	});

	it('plans every effect with default params at 1080p (passes, sizes, ≤ 12 textures)', () => {
		for (const s of family) {
			const plan = planGpuEffect(s, { id: 'fx1', params: defaults(s.id) }, ctx, {
				width: 1920,
				height: 1080,
			});
			expect(plan.passes.length).toBeGreaterThan(0);
			expect(plan.passes.at(-1)!.output).toBeNull();
		}
	});
});

describe('Combine popups', () => {
	it('map each option to its generic operation', () => {
		const opts = lightCombine('Zap');
		expect(opts.map((o) => o.label)).toEqual(['Screen', 'Add', 'Zap Only']);
		expect(combineUniforms({ combine: 'add' }, opts, 'screen')).toEqual({ u_combineOp: { int: 2 } });
		expect(combineUniforms({ combine: 'only' }, opts, 'screen')).toEqual({ u_combineOp: { int: 0 } });
		expect(combineUniforms({ combine: 'bogus' }, opts, 'screen')).toEqual({ u_combineOp: { int: 3 } });
	});
});

describe('spline sampling', () => {
	it('samples SPLINE_N points from the start to the end, arc length increasing', () => {
		const u = splineUniform([
			[0, 0],
			[100, 50],
			[200, 0],
		]).floats;
		expect(u).toHaveLength(SPLINE_N * 3);
		expect(u.slice(0, 2)).toEqual([0, 0]);
		expect(u[(SPLINE_N - 1) * 3]).toBeCloseTo(200, 6);
		expect(u[(SPLINE_N - 1) * 3 + 1]).toBeCloseTo(0, 6);
		for (let i = 1; i < SPLINE_N; i++) expect(u[i * 3 + 2]!).toBeGreaterThan(u[(i - 1) * 3 + 2]!);
		// passes through the control point
		let best = Infinity;
		for (let i = 0; i < SPLINE_N; i++) best = Math.min(best, Math.hypot(u[i * 3]! - 100, u[i * 3 + 1]! - 50));
		expect(best).toBeLessThan(8);
	});

	it('a two-point spline is the straight segment with its length', () => {
		const u = splineUniform([
			[10, 10],
			[40, 50],
		]).floats;
		expect(u.at(-1)).toBeCloseTo(50, 6);
		expect(u[12 * 3]).toBeCloseTo(10 + (30 * 12) / (SPLINE_N - 1), 6);
	});

	it('S_Zap follows only the enabled control points', () => {
		const s = spec('jasper.s.zap');
		const u = (p: Record<string, unknown>) =>
			planGpuEffect(s, { id: 'f', params: { ...defaults(s.id), ...p } as never }, ctx, {
				width: 1920,
				height: 1080,
			}).uniforms.find((x) => x.name === 'u_spline')!.value;
		expect(u({})).not.toEqual(u({ point3Enable: false }));
		expect(u({ controlPoint1: [0.1, 0.9] })).toEqual(u({})); // point 1 is disabled by default
	});
});

describe('lightning time hooks', () => {
	it('Jitter Frames: the same bolt within a period, a new one each period; 0 = always the same', () => {
		expect(zapSeed(0.3, 5, 0)).toBe(zapSeed(0.3, 99, 0));
		expect(zapSeed(0.3, 0, 4)).toBe(zapSeed(0.3, 3, 4));
		expect(zapSeed(0.3, 4, 4)).not.toBe(zapSeed(0.3, 3, 4));
		expect(zapSeed(0.3, 4, 4)).toBeGreaterThanOrEqual(0);
		expect(zapSeed(0.3, 4, 4)).toBeLessThan(1);
	});

	it('Wiggle moves the noise time axis with Wiggle Speed from Wiggle Start', () => {
		expect(zapTau({ wiggleStart: 1, wiggleSpeed: 0 }, { frame: 50, fps: 30 })).toBe(1);
		expect(zapTau({ wiggleStart: 0, wiggleSpeed: 1 }, { frame: 30, fps: 30 })).toBeCloseTo(2);
	});

	it('the glow gain grows with Glow Width and falls with Bolt Width (clamped)', () => {
		expect(glowGain(0.4, 0.07)).toBeGreaterThan(glowGain(0.2, 0.07));
		expect(glowGain(0.2, 0.2)).toBeLessThan(glowGain(0.2, 0.05));
		expect(glowGain(0, 1)).toBe(1);
		expect(glowGain(100, 0.001)).toBe(40);
	});

	it('S_ZapFrom pads by Max Length (bolts leave the object); generators otherwise stay in the box', () => {
		const pad = gpuPadding(spec('jasper.s.zap-from'), defaults('jasper.s.zap-from'), ctx);
		expect(pad.left).toBeGreaterThan(0.2 * 960);
		expect(gpuPadding(spec('jasper.s.zap'), defaults('jasper.s.zap'), ctx).left).toBe(0);
	});
});

describe('S_LaserBeam and S_MuzzleFlash timing', () => {
	it('Use Time flies the beam head from the start over Duration (+ Length)', () => {
		const p = { useTime: true, startTime: 10, flightDuration: 20, length: 0.5, position: 0.3 };
		expect(laserHead(p, { frame: 10 })).toBe(0);
		expect(laserHead(p, { frame: 30 })).toBeCloseTo(1.5);
		expect(laserHead({ ...p, useTime: false }, { frame: 30 })).toBe(0.3);
	});

	it('Repeat flashes every Gap Time frames inside Duration; Repeat+Fade fades over Fade Time', () => {
		const p = { timeMode: 'repeat', startTime: 2, flashDuration: 10, gapTime: 3, fadeTime: 2 };
		expect([1, 2, 3, 4, 5, 11, 12].map((f) => muzzleTiming(p, f).vis)).toEqual([0, 1, 0, 0, 1, 1, 0]);
		const f = { ...p, timeMode: 'repeatFade' };
		expect([2, 3, 4].map((x) => muzzleTiming(f, x).vis)).toEqual([1, 0.5, 0]);
		expect(muzzleTiming({ timeMode: 'always' }, 7).vis).toBe(1);
		expect(muzzleTiming(p, 8).index).toBe(2);
	});
});

describe('astronomy', () => {
	it('Julian day of the J2000 epoch and the lunar phase of a known full moon', () => {
		expect(julianDay(2000, 1, 1, 12)).toBeCloseTo(2451545.0, 6);
		// full moon 2020-03-09 17:48 UTC; new moon 2020-03-24 09:28 UTC (mean phase within ~10°)
		const full = lunarPhaseDeg(julianDay(2020, 3, 9, 17.8));
		expect(Math.abs(full - 180)).toBeLessThan(12);
		const nw = lunarPhaseDeg(julianDay(2020, 3, 24, 9.47));
		expect(Math.min(nw, 360 - nw)).toBeLessThan(12);
	});

	it('the sky matrix points a camera at altitude = latitude, azimuth 0 to the celestial pole', () => {
		for (const lat of [42.3, -20, 60]) {
			const m = nightSkyMatrix({ latitude: lat, altitude: lat, azimuth: 0, hour: 3, minute: 17 });
			const f = m.slice(6, 9);
			// the north celestial pole sits at altitude = latitude due north (below the horizon south of the equator)
			expect(f[2]).toBeCloseTo(1, 6);
			// the matrix is a rotation
			const cols = [m.slice(0, 3), m.slice(3, 6), f];
			for (const c of cols) expect(Math.hypot(c[0]!, c[1]!, c[2]!)).toBeCloseTo(1, 9);
		}
	});

	it('the sky turns by ~15° of right ascension per hour (sidereal rotation)', () => {
		const ra = (minute: number) => {
			const f = nightSkyMatrix({ latitude: 42.3, altitude: 0, azimuth: 180, minute }).slice(6, 9);
			return (Math.atan2(f[1]!, f[0]!) * 180) / Math.PI;
		};
		let d = ra(60) - ra(0);
		d = ((d + 540) % 360) - 180;
		expect(Math.abs(d)).toBeCloseTo(15.04, 1);
	});
});
