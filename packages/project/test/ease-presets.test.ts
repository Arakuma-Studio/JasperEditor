import { describe, expect, it } from 'vitest';
import {
	BUILTIN_EASE_PRESETS,
	backStrengthForOvershoot,
	bezierProgress,
	bounceRestitution,
	builtinEasePresets,
	type CubicEase,
	cubicToEases,
	type EaseCurve,
	type EasePreset,
	easeCurveMaxError,
	easeCurveSegments,
	elasticEase,
	evaluateEaseCurve,
	type MultiEase,
	matchEasePreset,
	overshootEase,
	springEase,
} from '../src/index.ts';

const PRESETS = builtinEasePresets();

const byId = (id: string) => {
	const p = PRESETS.find((q) => q.id === id);
	if (!p) throw new Error(`no preset ${id}`);
	return p;
};

/** Robert Penner's equations, written out independently of the catalog (the reference for the port). */
const PI = Math.PI;
const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const PENNER: Record<string, (x: number) => number> = {
	'sine-in': (x) => 1 - Math.cos((x * PI) / 2),
	'sine-out': (x) => Math.sin((x * PI) / 2),
	'sine-in-out': (x) => -(Math.cos(PI * x) - 1) / 2,
	'quad-in': (x) => x * x,
	'quad-out': (x) => 1 - (1 - x) * (1 - x),
	'quad-in-out': (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2),
	'cubic-in': (x) => x ** 3,
	'cubic-out': (x) => 1 - (1 - x) ** 3,
	'cubic-in-out': (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
	'quart-in': (x) => x ** 4,
	'quart-out': (x) => 1 - (1 - x) ** 4,
	'quart-in-out': (x) => (x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2),
	'quint-in': (x) => x ** 5,
	'quint-out': (x) => 1 - (1 - x) ** 5,
	'quint-in-out': (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
	'expo-in': (x) => (x === 0 ? 0 : 2 ** (10 * x - 10)),
	'expo-out': (x) => (x === 1 ? 1 : 1 - 2 ** (-10 * x)),
	'expo-in-out': (x) =>
		x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2,
	'circ-in': (x) => 1 - Math.sqrt(1 - x ** 2),
	'circ-out': (x) => Math.sqrt(1 - (x - 1) ** 2),
	'circ-in-out': (x) =>
		x < 0.5 ? (1 - Math.sqrt(1 - (2 * x) ** 2)) / 2 : (Math.sqrt(1 - (-2 * x + 2) ** 2) + 1) / 2,
	'back-in': (x) => c3 * x ** 3 - c1 * x ** 2,
	'back-out': (x) => 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2,
	'back-in-out': (x) =>
		x < 0.5
			? ((2 * x) ** 2 * ((c2 + 1) * 2 * x - c2)) / 2
			: ((2 * x - 2) ** 2 * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2,
};

const cubicOf = (p: EasePreset) => {
	expect(p.curve.kind).toBe('cubic');
	return p.curve as CubicEase;
};

describe('built-in ease catalog', () => {
	it('Penner presets match independently written Penner equations within 0.002', () => {
		for (const [name, fn] of Object.entries(PENNER)) {
			const p = byId(`penner.${name}`);
			expect(easeCurveMaxError(p.curve, fn, 1999), name).toBeLessThanOrEqual(0.002);
		}
		// Polynomials of degree ≤ 3 convert exactly.
		expect(cubicOf(byId('penner.quad-in'))).toMatchObject({ x1: 1 / 3, x2: 2 / 3 });
		expect(
			easeCurveMaxError(byId('penner.back-out').curve, PENNER['back-out'] as (x: number) => number),
		).toBeLessThan(1e-6);
	});

	it('Basic presets match the keyframe model (Linear, Easy Ease, Ease In / Ease Out) and CSS keywords', () => {
		const LIN = { influence: 1 / 3, slope: 1 };
		const EASY = { influence: 1 / 3, slope: 0 };
		const model: [string, { influence: number; slope: number }, { influence: number; slope: number }][] = [
			['basic.linear', LIN, LIN],
			['basic.easy-ease', EASY, EASY],
			// Ease In = the arriving key's in ease {⅓, 0}; the leaving key stays linear.
			['basic.easy-ease-in', LIN, EASY],
			// Ease Out = the leaving key's out ease {⅓, 0}.
			['basic.easy-ease-out', EASY, LIN],
		];
		for (const [id, out, inn] of model) {
			const p = byId(id);
			for (let i = 0; i <= 1000; i++)
				expect(evaluateEaseCurve(p.curve, i / 1000)).toBeCloseTo(bezierProgress(i / 1000, out, inn), 9);
			const eases = cubicToEases(cubicOf(p));
			expect(eases.easeOut.influence).toBeCloseTo(out.influence, 12);
			expect(eases.easeOut.slope).toBeCloseTo(out.slope, 12);
			expect(eases.easeIn.influence).toBeCloseTo(inn.influence, 12);
			expect(eases.easeIn.slope).toBeCloseTo(inn.slope, 12);
		}
		// W3C css-easing-1 keyword values.
		expect(cubicOf(byId('basic.ease'))).toEqual({ kind: 'cubic', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 });
		expect(cubicOf(byId('basic.ease-in'))).toEqual({ kind: 'cubic', x1: 0.42, y1: 0, x2: 1, y2: 1 });
		expect(cubicOf(byId('basic.ease-out'))).toEqual({ kind: 'cubic', x1: 0, y1: 0, x2: 0.58, y2: 1 });
		expect(cubicOf(byId('basic.ease-in-out'))).toEqual({ kind: 'cubic', x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
	});

	it('Material presets carry the published token values', () => {
		const want: Record<string, [number, number, number, number]> = {
			standard: [0.2, 0, 0, 1],
			'standard-decelerate': [0, 0, 0, 1],
			'standard-accelerate': [0.3, 0, 1, 1],
			'emphasized-decelerate': [0.05, 0.7, 0.1, 1],
			'emphasized-accelerate': [0.3, 0, 0.8, 0.15],
			'legacy-standard': [0.4, 0, 0.2, 1],
			'legacy-decelerate': [0, 0, 0.2, 1],
			'legacy-accelerate': [0.4, 0, 1, 1],
		};
		for (const [id, [x1, y1, x2, y2]] of Object.entries(want))
			expect(cubicOf(byId(`material.${id}`))).toEqual({ kind: 'cubic', x1, y1, x2, y2 });
		const emph = byId('material.emphasized').curve as MultiEase;
		expect(easeCurveSegments(emph)).toEqual([
			[
				[0, 0],
				[0.05, 0],
				[0.133333, 0.06],
				[0.166666, 0.4],
			],
			[
				[0.166666, 0.4],
				[0.208333, 0.82],
				[0.25, 1],
				[1, 1],
			],
		]);
	});

	it('overshoot presets peak at their amounts', () => {
		for (const [amount, p] of [
			['light', 0.05],
			['medium', 0.12],
			['strong', 0.25],
		] as const) {
			const out = byId(`overshoot.overshoot-out-${amount}`).curve;
			const inn = byId(`overshoot.anticipate-in-${amount}`).curve;
			let peak = Number.NEGATIVE_INFINITY;
			let dip = Number.POSITIVE_INFINITY;
			for (let i = 0; i <= 4000; i++) {
				peak = Math.max(peak, evaluateEaseCurve(out, i / 4000));
				dip = Math.min(dip, evaluateEaseCurve(inn, i / 4000));
			}
			expect(peak - 1).toBeCloseTo(p, 4);
			expect(dip).toBeCloseTo(-p, 4);
		}
		// The strength formula reproduces Penner's 10 % constant.
		expect(backStrengthForOvershoot(0.1)).toBeCloseTo(1.70158, 4);
		expect(overshootEase(0.1, 'out')(0.5)).toBeCloseTo(PENNER['back-out']?.(0.5) as number, 4);
	});

	it('bounce presets follow the restitution model: contacts at 1, apex heights e^(2k)', () => {
		for (const n of [2, 3, 4, 5]) {
			const e = bounceRestitution(n);
			expect(e ** (2 * n)).toBeCloseTo(0.01, 12);
			const curve = byId(`bounce.out-${n}`).curve;
			const fn = (x: number) => evaluateEaseCurve(curve, x);
			let sum = 0;
			for (let k = 1; k <= n; k++) sum += e ** k;
			const t0 = 1 / (1 + 2 * sum);
			expect(Math.abs(fn(t0) - 1)).toBeLessThanOrEqual(0.002);
			let start = t0;
			for (let k = 1; k <= n; k++) {
				const dur = 2 * e ** k * t0;
				expect(Math.abs(fn(start + dur / 2) - (1 - e ** (2 * k)))).toBeLessThanOrEqual(0.002);
				expect(Math.abs(fn(start + dur) - 1)).toBeLessThanOrEqual(0.002);
				start += dur;
			}
			expect(start).toBeCloseTo(1, 12);
		}
	});

	it('elastic and spring sources end exactly at 1 and stay within their envelopes', () => {
		for (const fn of [elasticEase(3, 6, 'out'), elasticEase(5, 3, 'in'), springEase(0.15), springEase(1)]) {
			expect(fn(0)).toBeCloseTo(0, 12);
			expect(fn(1)).toBeCloseTo(1, 12);
		}
		// Elastic out with d = 6: |out − 1| ≤ the normalised envelope.
		const el = elasticEase(3, 6, 'out');
		for (let i = 0; i <= 1000; i++) {
			const x = i / 1000;
			const env = (Math.exp(-6 * x) - Math.exp(-6)) / (1 - Math.exp(-6));
			expect(Math.abs(el(x) - 1)).toBeLessThanOrEqual(env + 1e-12);
		}
		// Critically damped: monotone, no overshoot.
		const crit = springEase(1);
		for (let i = 1; i <= 1000; i++) expect(crit(i / 1000)).toBeGreaterThanOrEqual(crit((i - 1) / 1000));
		// Underdamped ζ = 0.3: first overshoot ≈ e^(−πζ/√(1−ζ²)) of the change.
		const bouncy = springEase(0.3);
		let peak = 0;
		for (let i = 0; i <= 4000; i++) peak = Math.max(peak, bouncy(i / 4000));
		expect(peak - 1).toBeCloseTo(Math.exp((-Math.PI * 0.3) / Math.sqrt(1 - 0.09)), 2);
	});

	it('refuses mutation of the public read-only preset catalog', () => {
		expect(() => (BUILTIN_EASE_PRESETS as EasePreset[]).push(PRESETS[0] as EasePreset)).toThrow(TypeError);
	});
});

describe('matchEasePreset', () => {
	it('matches whatever the representation (a cubic written as a two-piece multi curve)', () => {
		const c = cubicOf(byId('basic.ease-in-out'));
		// de Casteljau split at t = ½: the same curve as a multi curve.
		const P = [
			[0, 0],
			[c.x1, c.y1],
			[c.x2, c.y2],
			[1, 1],
		] as const;
		const mid = (a: readonly number[], b: readonly number[]) =>
			[((a[0] as number) + (b[0] as number)) / 2, ((a[1] as number) + (b[1] as number)) / 2] as [
				number,
				number,
			];
		const a = mid(P[0], P[1]);
		const b = mid(P[1], P[2]);
		const cc = mid(P[2], P[3]);
		const d = mid(a, b);
		const e = mid(b, cc);
		const m = mid(d, e);
		const multi: EaseCurve = {
			kind: 'multi',
			points: [
				{ x: 0, y: 0, out: a },
				{ x: m[0], y: m[1], in: d, out: e },
				{ x: 1, y: 1, in: cc },
			],
		};
		expect(matchEasePreset(multi)?.id).toBe('basic.ease-in-out');
	});

	it('returns null for a curve far from every preset and honours the list and tolerance', () => {
		const odd: CubicEase = { kind: 'cubic', x1: 0.9, y1: -0.7, x2: 0.1, y2: 1.8 };
		expect(matchEasePreset(odd)).toBeNull();
		const near: CubicEase = { kind: 'cubic', x1: 0.42, y1: 0.001, x2: 0.58, y2: 1 };
		expect(matchEasePreset(near)?.id).toBe('basic.ease-in-out');
		expect(matchEasePreset(near, PRESETS, 1e-6)).toBeNull();
		const mine: EasePreset = { id: 'user.odd', name: 'Odd', group: 'user', curve: odd };
		expect(matchEasePreset(odd, [mine])).toBe(mine);
		expect(matchEasePreset(odd, [])).toBeNull();
		expect(matchEasePreset(near, PRESETS, Number.NaN)?.id).toBe('basic.ease-in-out');
	});

	it('prefers the closest of several matching presets', () => {
		const a: EasePreset = {
			id: 'a',
			name: 'A',
			group: 'g',
			curve: { kind: 'cubic', x1: 0.4, y1: 0, x2: 0.6, y2: 1 },
		};
		const b: EasePreset = {
			id: 'b',
			name: 'B',
			group: 'g',
			curve: { kind: 'cubic', x1: 0.41, y1: 0, x2: 0.6, y2: 1 },
		};
		const probe: CubicEase = { kind: 'cubic', x1: 0.409, y1: 0, x2: 0.6, y2: 1 };
		expect(matchEasePreset(probe, [a, b], 0.01)?.id).toBe('b');
	});
});
