import { describe, expect, it } from 'vitest';
import {
	SAPPHIRE_TRANSITION_SUBBINS,
	TRANSITION_BINS,
	transitionPasses,
} from '../src/registry/transitions/index.ts';
import {
	cardHalfTurns,
	cardSpin,
	parallaxGrowth,
	stripProgress,
} from '../src/registry/transitions/sapphire-swish-other/cards.ts';
import {
	frameStep,
	sapphirePoint,
	sapphireSlow,
	shakeOffset,
	smoothNoise,
	whipCurve,
} from '../src/registry/transitions/sapphire-swish-other/common.ts';
import {
	deadWindow,
	flutterAt,
	flutterPattern,
} from '../src/registry/transitions/sapphire-swish-other/cuts.ts';
import {
	dustCells,
	filmRollSignals,
	flashState,
	rollFrames,
} from '../src/registry/transitions/sapphire-swish-other/film.ts';
import { hyperShake } from '../src/registry/transitions/sapphire-swish-other/hyper.ts';
import { SAPPHIRE_SWISH_OTHER_TRANSITIONS } from '../src/registry/transitions/sapphire-swish-other.ts';
import { transitionSpec } from '../src/transitions.ts';

const LABELS: Record<string, string> = {
	'jasper.s.swish-pan': 'S_SwishPan',
	'jasper.s.swish-3d': 'S_Swish3D',
	'jasper.s.card-flip': 'S_CardFlip',
	'jasper.s.film-burn-transition': 'S_FilmBurnTransition',
	'jasper.s.film-roll': 'S_FilmRoll',
	'jasper.s.flutter-cut': 'S_FlutterCut',
	'jasper.s.hyper-pull': 'S_HyperPull',
	'jasper.s.hyper-push': 'S_HyperPush',
	'jasper.s.mocha-whip': 'S_MochaWhip',
	'jasper.s.parallax-strips-transition': 'S_ParallaxStripsTransition',
	'jasper.s.strip-slide-transition': 'S_StripSlideTransition',
	'jasper.s.tv-channel-change': 'S_TVChannelChange',
	'jasper.s.whip-lash': 'S_WhipLash',
};
const defaults = (id: string) =>
	Object.fromEntries(transitionSpec(id)!.params.map((p) => [p.name, p.default]));
const ctx = { width: 1920, height: 1080, fps: 30, duration: 19 };

describe('sapphire-swish-other catalogue', () => {
	it('has the 13 Sapphire transitions with their names, in Sapphire Transitions ▸ Wipes / Other', () => {
		expect(Object.fromEntries(SAPPHIRE_SWISH_OTHER_TRANSITIONS.map((s) => [s.id, s.label]))).toEqual(LABELS);
		for (const s of SAPPHIRE_SWISH_OTHER_TRANSITIONS) {
			expect(transitionSpec(s.id)).toBe(s);
			expect(s.bin).toBe(TRANSITION_BINS.sapphire);
			const wipe = s.id === 'jasper.s.swish-pan' || s.id === 'jasper.s.swish-3d';
			expect(s.subBin, s.id).toBe(
				wipe ? SAPPHIRE_TRANSITION_SUBBINS.wipes : SAPPHIRE_TRANSITION_SUBBINS.other,
			);
		}
	});

	it('uses Sapphire parameter names and defaults', () => {
		expect(defaults('jasper.s.swish-pan')).toMatchObject({
			direction: 'left',
			blurAmount: 2,
			overlap: 0,
			slowIn: 0.5,
			slowOut: 0.5,
		});
		expect(defaults('jasper.s.swish-3d')).toMatchObject({
			effect: 'blurWarp',
			zDist: 0.5,
			relAmpFrom: 1,
			relAmpTo: -1,
			fadeMidTime: 0.5,
			steps: 8,
			wrapFrom: 'reflect',
		});
		expect(defaults('jasper.s.card-flip')).toMatchObject({
			revolutions: 1,
			spinDirection: 'left',
			shift: 0,
			perspective: 1,
			shadowOpacity: 2,
			shadowBlur: 0.088,
		});
		expect(defaults('jasper.s.hyper-pull')).toMatchObject({
			zDistFrom: 5,
			zDistTo: 0.001,
			dissolveSpeed: 5,
			slowIn: 1,
			warpAmount: 0.6,
			steps: 10,
			distortionAmount: -1,
		});
		expect(defaults('jasper.s.hyper-push')).toMatchObject({ zDistFrom: 0.001, zDistTo: 5 });
		expect(defaults('jasper.s.whip-lash')).toMatchObject({
			shift: [-4, 0],
			whipOut: 'smooth',
			blurAmount: 1.25,
			shiftRgb: 2,
			edgeMode: 'reflect',
		});
		expect(defaults('jasper.s.mocha-whip')).toMatchObject({
			cutoutMask: 'none',
			cutoutShift: [2, 0],
			cutoutScale: 1.2,
			bgShift: [-2, 0],
		});
		expect(defaults('jasper.s.film-burn-transition')).toMatchObject({
			dissolveSpeed: 50,
			flash1: true,
			edges: false,
			size1: 1.4,
			stretch1: 2.23,
			dustDensity: 140,
		});
		expect(defaults('jasper.s.film-roll')).toMatchObject({
			rollSpeed: 1,
			borderHeight: 0.1,
			glowWidth: 0.224,
			damageAmount: 2,
			dustDensity: 60,
		});
		expect(defaults('jasper.s.tv-channel-change')).toMatchObject({
			reception: 1.6,
			deadTimeStyle: 'staticOverBlack',
			deadTimeDuration: 0.2,
			tvPixels: 720,
			seed: 0.123,
		});
		expect(defaults('jasper.s.parallax-strips-transition')).toMatchObject({
			nStrips: 50,
			size: 0.35,
			relHeight: 0.3,
			dissolveSpeed: 3,
			wrap: 'reflect',
		});
		expect(defaults('jasper.s.strip-slide-transition')).toMatchObject({
			style: 'slideOff',
			stripSize: 0.1,
			speed: 10,
			slowStart: 1,
			order: 'topDown',
		});
		expect(defaults('jasper.s.flutter-cut')).toMatchObject({
			fromStartFrames: 2,
			toEndFrames: 2,
			color1Frames: 0,
			invert: 'none',
		});
	});

	it('keeps motion params keyframable and choices hold-only', () => {
		const sp = transitionSpec('jasper.s.swish-pan')!;
		expect(sp.params.find((p) => p.name === 'blurAmount')!.animatable).toBe(true);
		expect(sp.params.find((p) => p.name === 'direction')!.animatable).toBe(false);
		const wl = transitionSpec('jasper.s.whip-lash')!;
		expect(wl.params.find((p) => p.name === 'shift')!.animatable).toBe(true);
	});

	it('plans HyperPull with the glow passes only when Glow Brights is on', () => {
		const spec = transitionSpec('jasper.s.hyper-pull')!;
		const on = transitionPasses(spec.gpu!, defaults(spec.id), ctx);
		const off = transitionPasses(spec.gpu!, { ...defaults(spec.id), glowBrights: false }, ctx);
		expect(on.length).toBe(5);
		expect(off.length).toBe(1);
	});
});

describe('sapphire-swish-other maths', () => {
	it('Slow In / Slow Out: exact ends, linear at 0/0, smoothstep at 1/1, monotonic', () => {
		for (const [a, b] of [
			[0, 0],
			[0.5, 0.5],
			[1, 1],
			[0, 1],
			[1, 0.2],
		] as const) {
			expect(sapphireSlow(0, a, b)).toBe(0);
			expect(sapphireSlow(1, a, b)).toBeCloseTo(1, 12);
			let prev = 0;
			for (let t = 0; t <= 1; t += 0.01) {
				const v = sapphireSlow(t, a, b);
				expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
				prev = v;
			}
		}
		expect(sapphireSlow(0.3, 0, 0)).toBeCloseTo(0.3, 12);
		expect(sapphireSlow(0.3, 1, 1)).toBeCloseTo(0.3 * 0.3 * (3 - 2 * 0.3), 12);
	});

	it('whip curves: 0.5 at the cut with continuous speed, land exactly; Bounce overshoots, Snap stops dead', () => {
		for (const s of ['smooth', 'bounce', 'snap']) {
			expect(whipCurve(0, s)).toBe(0);
			expect(whipCurve(0.5, s)).toBeCloseTo(0.5, 12);
			expect(whipCurve(1, s)).toBeCloseTo(1, 12);
			const h = 1e-5;
			const left = (whipCurve(0.5, s) - whipCurve(0.5 - h, s)) / h;
			const right = (whipCurve(0.5 + h, s) - whipCurve(0.5, s)) / h;
			expect(right).toBeCloseTo(left, 2);
		}
		const samples = Array.from({ length: 101 }, (_, i) => whipCurve(i / 100, 'bounce'));
		expect(Math.max(...samples)).toBeGreaterThan(1.01);
		expect(whipCurve(0.75, 'snap')).toBe(1);
	});

	it('frame step: the span ramp step × Start/End', () => {
		expect(frameStep({}, { duration: 19, hasFrom: true, hasTo: true })).toBeCloseTo(1 / 20, 12);
		expect(frameStep({}, { duration: 10, hasFrom: false, hasTo: true })).toBeCloseTo(1 / 10, 12);
		expect(
			frameStep({ startPercent: 25, endPercent: 75 }, { duration: 19, hasFrom: true, hasTo: true }),
		).toBeCloseTo(0.025, 12);
		expect(
			frameStep({ startPercent: 50, endPercent: 50 }, { duration: 19, hasFrom: true, hasTo: true }),
		).toBe(0);
	});

	it('Sapphire points and deterministic noises', () => {
		expect(sapphirePoint(0, 0)).toEqual([0.5, 0.5]);
		expect(sapphirePoint(-1, 0)).toEqual([0, 0.5]);
		expect(sapphirePoint(0, 9 / 16)).toEqual([0.5, 0]);
		expect(smoothNoise(0.3, 1, 2.5)).toBe(smoothNoise(0.3, 1, 2.5));
		expect(smoothNoise(0.3, 1, 2.5)).not.toBe(smoothNoise(0.4, 1, 2.5));
		expect(Math.abs(smoothNoise(0.3, 1, 2))).toBeLessThanOrEqual(1);
		expect(Math.hypot(...shakeOffset(0.5, 1, { amplitude: 0, frequency: 2 }))).toBe(0);
	});

	it('FlutterCut: cycles from the start to the end lengths, colour frames, inverts, ends on B', () => {
		const p = { color1Frames: 1, color1Position: 'afterFrom', fromStartFrames: 3, toEndFrames: 3 };
		expect(
			flutterPattern(p, 12)
				.map((f) => ({ from: 'F', to: 'T', color1: 'C', color2: 'W' })[f.show])
				.join(''),
		).toBe('FFFCTTFFCTTT');
		const def = flutterPattern({}, 9);
		expect(def.map((f) => f.show[0]).join('')).toBe('fftt' + 'fftt' + 't');
		const four = flutterPattern(
			{ fromStartFrames: 4, fromEndFrames: 1, toStartFrames: 1, toEndFrames: 4 },
			16,
		);
		expect(four[0]!.show).toBe('from');
		expect(four.at(-1)!.show).toBe('to');
		expect(fromCount(four.slice(0, 5))).toBeGreaterThan(fromCount(four.slice(-5)));
		const inv = flutterPattern({ invert: 'from', normalBefore: 1, invertLength: 1 }, 8);
		expect(inv.map((f) => (f.invert ? 'i' : '.')).join('')).toBe('.i...i..');
		const custom = flutterPattern({ invert: 'custom', normalBefore: 0, invertLength: 1, normalAfter: 1 }, 6);
		expect(custom.map((f) => (f.invert ? 'i' : '.')).join('')).toBe('i.i.i.');
		const both = flutterPattern({ color2Frames: 1, color2Position: 'afterBoth' }, 7);
		expect(both.map((f) => f.show[0]).join('')).toBe('ffcttct');
		expect(flutterAt({}, 0, 9)).toEqual({ show: 'from', invert: false });
		expect(flutterAt({}, 1, 9)).toEqual({ show: 'to', invert: false });
		expect(flutterAt({}, 0.5, 9).show).toBe(def[4]!.show);
	});

	it('TV dead time, film roll frames, card spin, strip timing, parallax growth, dust cells', () => {
		expect(deadWindow({})[0]).toBeCloseTo(0.4, 12);
		expect(deadWindow({})[1]).toBeCloseTo(0.6, 12);
		expect(deadWindow({ deadTimeStart: 1, deadTimeDuration: 0.2 })[1]).toBeCloseTo(1, 12);
		expect(rollFrames(1)).toEqual({ frames: 1, dir: 1 });
		expect(rollFrames(-2.4)).toEqual({ frames: 2, dir: -1 });
		expect(rollFrames(0.2)).toEqual({ frames: 1, dir: 1 });
		expect(cardSpin('left')).toEqual({ axis: 0, sign: 1 });
		expect(cardSpin('down')).toEqual({ axis: 1, sign: -1 });
		expect([0, 1, 2, 3].map(cardHalfTurns)).toEqual([0, 1, 3, 5]);
		expect(stripProgress(0, 0, 10, 1)).toBe(0);
		expect(stripProgress(1, 1, 10, 1)).toBe(1);
		expect(stripProgress(0.2, 0, 10, 0)).toBeCloseTo(0.2 / 0.3, 12);
		expect(stripProgress(0.2, 1, 10, 0)).toBe(0);
		expect(parallaxGrowth(0, 0.9)).toBe(0);
		expect(parallaxGrowth(1, 0.9)).toBe(0);
		expect(parallaxGrowth(0.5, 0.9)).toBe(1);
		expect(parallaxGrowth(0.25, 0.9)).toBeLessThan(parallaxGrowth(0.25, 0));
		const d = dustCells(140, 1920, 1080);
		expect((d.prob * 1920 * 1080) / (d.cell * d.cell)).toBeCloseTo(140, 6);
		expect(dustCells(0, 1920, 1080).prob).toBe(0);
	});

	it('per-frame film / shake signals are pure functions of (params, frame, seed)', () => {
		const p = defaults('jasper.s.film-roll');
		const a = filmRollSignals(p, { frame: 7, fps: 30, seed: 0.42 });
		expect(filmRollSignals(p, { frame: 7, fps: 30, seed: 0.42 })).toEqual(a);
		expect(filmRollSignals(p, { frame: 7, fps: 30, seed: 0.43 })).not.toEqual(a);
		const fb = defaults('jasper.s.film-burn-transition');
		expect(Math.hypot(...flashState(fb, 1, 0, 0, 0.1).move)).toBe(0);
		const m = flashState(fb, 1, 1, 0, 0.1).move;
		expect(m[0]).toBeCloseTo(0, 9);
		expect(m[1]).toBeCloseTo(3, 9); // Motion Angle −90° (clockwise = up on screen) → +y in Sapphire units
		const hp = defaults('jasper.s.hyper-push');
		expect(hyperShake(hp, { frame: 3, fps: 30, seed: 0.2, progress: 0.5 })).toEqual([0, 0]);
		const on = hyperShake({ ...hp, cameraShake: true }, { frame: 3, fps: 30, seed: 0.2, progress: 0.5 });
		expect(Math.hypot(...on)).toBeGreaterThan(0);
		expect(
			Math.hypot(...hyperShake({ ...hp, cameraShake: true }, { frame: 3, fps: 30, seed: 0.2, progress: 0 })),
		).toBe(0);
	});
});

function fromCount(frames: { show: string }[]): number {
	return frames.filter((f) => f.show === 'from').length;
}
