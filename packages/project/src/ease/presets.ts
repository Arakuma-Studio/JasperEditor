// Built-in ease presets (keyframe assistant). Our own catalog, built from public math: the CSS easing keywords
// (W3C css-easing-1), Robert Penner's easing equations (MIT, licenses/ported/easing-penner.md), Material Design 3
// motion tokens (published values) and our own physics (overshoot by peak, elastic, bounce, spring). Curves that
// are not given as cubic-beziers are fitted from their source function with `fitEaseCurve` the first time the
// catalog is read: a monotone curve one cubic-bezier matches within PRESET_CUBIC_TOLERANCE is that cubic (applied as
// the handles of the existing keys, so moving a key rescales the ease), anything else a multi curve within 0.002.
// Formulas and sources: docs/wp-notes/easing.md "Built-in presets".
import {
	type CubicEase,
	type EaseCurve,
	type EasePreset,
	evaluateEaseCurve,
	type MultiEase,
} from './curve.ts';
import { fitEaseCurve } from './fit.ts';

/** A progress function on [0, 1] with f(0) = 0 and f(1) = 1. */
export type EaseFunction = (x: number) => number;

export type EasePresetGroup = { readonly id: string; readonly name: string };

export const BUILTIN_EASE_GROUPS: readonly EasePresetGroup[] = Object.freeze([
	{ id: 'basic', name: 'Basic' },
	{ id: 'penner', name: 'Classic Equations' },
	{ id: 'overshoot', name: 'Overshoot & Anticipation' },
	{ id: 'elastic', name: 'Elastic' },
	{ id: 'bounce', name: 'Bounce' },
	{ id: 'spring', name: 'Spring' },
	{ id: 'material', name: 'Material Motion' },
]);

// ---------------------------------------------------------------------------------------------------------------
// Source functions

const PI = Math.PI;

/** Robert Penner's equations, normalised to t ∈ [0, 1] (port record: licenses/ported/easing-penner.md). */
export type PennerFamily = 'sine' | 'quad' | 'cubic' | 'quart' | 'quint' | 'expo' | 'circ' | 'back';
export type EaseDirection = 'in' | 'out' | 'in-out';
export const PENNER_FAMILIES: readonly PennerFamily[] = [
	'sine',
	'quad',
	'cubic',
	'quart',
	'quint',
	'expo',
	'circ',
	'back',
];
const POWERS: Partial<Record<PennerFamily, number>> = { quad: 2, cubic: 3, quart: 4, quint: 5 };
/** Penner's back overshoot constant (10 % overshoot) and its in-out variant. */
const BACK_S = 1.70158;
const BACK_S_IN_OUT = BACK_S * 1.525;

/** f(x) of Penner's `family` in `direction`. */
export function pennerEase(family: PennerFamily, direction: EaseDirection): EaseFunction {
	const n = POWERS[family];
	const inFn: EaseFunction =
		n !== undefined
			? (x) => x ** n
			: family === 'sine'
				? (x) => 1 - Math.cos((x * PI) / 2)
				: family === 'expo'
					? (x) => (x <= 0 ? 0 : 2 ** (10 * x - 10))
					: family === 'circ'
						? (x) => 1 - Math.sqrt(Math.max(0, 1 - x * x))
						: (x) => (BACK_S + 1) * x * x * x - BACK_S * x * x;
	if (direction === 'in') return inFn;
	if (direction === 'out') {
		if (family === 'expo') return (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
		return (x) => 1 - inFn(1 - x);
	}
	if (family === 'back') {
		const c = BACK_S_IN_OUT;
		return (x) =>
			x < 0.5
				? ((2 * x) ** 2 * ((c + 1) * 2 * x - c)) / 2
				: ((2 * x - 2) ** 2 * ((c + 1) * (2 * x - 2) + c) + 2) / 2;
	}
	if (family === 'expo')
		return (x) =>
			x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2;
	return inOut(inFn);
}

/** Analytic derivative of Penner's expo (its ends are special-cased, so finite differences there are wrong). */
function pennerExpoDerivative(direction: EaseDirection): EaseFunction {
	const k = 10 * Math.LN2;
	if (direction === 'in') return (x) => k * 2 ** (10 * x - 10);
	if (direction === 'out') return (x) => k * 2 ** (-10 * x);
	return (x) => (x < 0.5 ? k * 2 ** (20 * x - 10) : k * 2 ** (-20 * x + 10));
}

/** In-out from an in function: the in curve over the first half, its point reflection over the second. */
function inOut(inFn: EaseFunction): EaseFunction {
	return (x) => (x < 0.5 ? inFn(2 * x) / 2 : 1 - inFn(2 - 2 * x) / 2);
}
/** The time reversal of a curve: out(x) = 1 − in(1 − x). */
function reverse(fn: EaseFunction): EaseFunction {
	return (x) => 1 - fn(1 - x);
}

/**
 * Back-curve strength s for a peak overshoot p: the out curve f(x) = 1 + (s+1)u³ + s·u² (u = x − 1) peaks at
 * u = −2s / (3(s+1)) with overshoot 4s³ / (27(s+1)²), increasing in s; solved by bisection.
 */
export function backStrengthForOvershoot(p: number): number {
	const target = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
	const over = (s: number) => (4 * s ** 3) / (27 * (s + 1) ** 2);
	let lo = 0;
	let hi = 64;
	for (let i = 0; i < 100; i++) {
		const mid = (lo + hi) / 2;
		if (over(mid) < target) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/** Overshoot by `p` (0.1 = 10 % of the change) before settling: f(x) = 1 + (s+1)(x−1)³ + s(x−1)². */
export function overshootEase(p: number, direction: EaseDirection): EaseFunction {
	const s = backStrengthForOvershoot(p);
	const out: EaseFunction = (x) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
	if (direction === 'out') return out;
	const inFn = reverse(out);
	return direction === 'in' ? inFn : inOut(inFn);
}

/**
 * Elastic: a cosine of `swings` full cycles under an exponential envelope that reaches exactly 0 at x = 1:
 * out(x) = 1 − cos(2π·n·x) · (e^(−d·x) − e^(−d)) / (1 − e^(−d)); in(x) = 1 − out(1 − x).
 */
export function elasticEase(swings: number, decay: number, direction: 'in' | 'out'): EaseFunction {
	const n = Math.max(1, Math.min(32, Number.isFinite(swings) ? swings : 1));
	const d = Math.max(0.1, Math.min(50, Number.isFinite(decay) ? decay : 1));
	const tail = Math.exp(-d);
	const out: EaseFunction = (x) => 1 - (Math.cos(2 * PI * n * x) * (Math.exp(-d * x) - tail)) / (1 - tail);
	return direction === 'out' ? out : reverse(out);
}

/**
 * Bounce: a ball dropped from height 1 at rest under constant gravity, each impact keeping `restitution` e of its
 * speed. Fall time t0, bounce k lasts 2·e^k·t0 and peaks at e^(2k); t0 = 1 / (1 + 2·Σ_{k=1..N} e^k) makes the
 * N bounces end at x = 1. out(x) = 1 − height.
 */
export function bounceEase(bounces: number, restitution: number, direction: EaseDirection): EaseFunction {
	const N = Math.max(1, Math.min(16, Math.round(Number.isFinite(bounces) ? bounces : 1)));
	const e = Math.max(0.01, Math.min(0.99, Number.isFinite(restitution) ? restitution : 0.5));
	// starts[k] / durs[k] / peaks[k]: start, duration and apex height of bounce k + 1.
	const starts: number[] = [];
	const durs: number[] = [];
	const peaks: number[] = [];
	let sum = 0;
	for (let k = 1; k <= N; k++) sum += e ** k;
	const t0 = 1 / (1 + 2 * sum);
	let start = t0;
	for (let k = 1; k <= N; k++) {
		starts.push(start);
		durs.push(2 * e ** k * t0);
		peaks.push(e ** (2 * k));
		start += 2 * e ** k * t0;
	}
	const out: EaseFunction = (x) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		if (x <= t0) return (x / t0) ** 2;
		let k = 0;
		while (k < N - 1 && x > (starts[k] as number) + (durs[k] as number)) k++;
		const half = (durs[k] as number) / 2;
		const u = Math.min(1, Math.max(-1, (x - (starts[k] as number) - half) / half));
		return 1 - (peaks[k] as number) * (1 - u * u);
	};
	if (direction === 'out') return out;
	const inFn = reverse(out);
	return direction === 'in' ? inFn : inOut(inFn);
}

/** Restitution giving a last (N-th) bounce of 1 % of the drop: e^(2N) = 0.01. */
export const bounceRestitution = (bounces: number) => 0.01 ** (1 / (2 * Math.max(1, bounces)));

/** Envelope left at x = 1 by the spring presets (0.1 % of the change). */
const SPRING_SETTLE = 0.001;

/**
 * Spring: a unit-mass damped oscillator released at rest at 0 toward 1, damping ratio ζ. Underdamped:
 * y(τ) = 1 − e^(−ζωτ)(cos ω_d τ + (ζω/ω_d) sin ω_d τ), ω_d = ω√(1−ζ²), with ω = ln(1/ε)/ζ so the envelope is ε at
 * τ = 1. Critical (ζ = 1): y = 1 − e^(−ωτ)(1 + ωτ) with (1 + ω)e^(−ω) = ε. The curve is y / y(1), exactly 1 at 1.
 */
export function springEase(dampingRatio: number): EaseFunction {
	const zeta = Math.max(0.05, Math.min(1, Number.isFinite(dampingRatio) ? dampingRatio : 1));
	let raw: EaseFunction;
	if (zeta >= 1) {
		let w = 10;
		for (let i = 0; i < 50; i++) {
			// Newton on g(ω) = ln(1 + ω) − ω − ln ε.
			const g = Math.log(1 + w) - w - Math.log(SPRING_SETTLE);
			w -= g / (1 / (1 + w) - 1);
		}
		raw = (x) => 1 - Math.exp(-w * x) * (1 + w * x);
	} else {
		const w = Math.log(1 / SPRING_SETTLE) / zeta;
		const wd = w * Math.sqrt(1 - zeta * zeta);
		raw = (x) => 1 - Math.exp(-zeta * w * x) * (Math.cos(wd * x) + ((zeta * w) / wd) * Math.sin(wd * x));
	}
	const end = raw(1);
	return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : raw(x) / end);
}

// ---------------------------------------------------------------------------------------------------------------
// Catalog

const cubic = (x1: number, y1: number, x2: number, y2: number): CubicEase => ({
	kind: 'cubic',
	x1,
	y1,
	x2,
	y2,
});

/** M3 "emphasized": the two-piece path M 0,0 C 0.05,0 0.133333,0.06 0.166666,0.4 C 0.208333,0.82 0.25,1 1,1. */
const M3_EMPHASIZED: MultiEase = {
	kind: 'multi',
	points: [
		{ x: 0, y: 0, out: [0.05, 0] },
		{ x: 0.166666, y: 0.4, in: [0.133333, 0.06], out: [0.208333, 0.82] },
		{ x: 1, y: 1, in: [0.25, 1] },
	],
};

/** A catalog entry before fitting: a curve given exactly, or a source function to fit. */
type Spec = {
	id: string;
	name: string;
	group: string;
	curve?: EaseCurve;
	fn?: EaseFunction;
	derivative?: EaseFunction;
};

const DIRECTION_NAMES: Record<EaseDirection, string> = { in: 'In', out: 'Out', 'in-out': 'In-Out' };
const PENNER_NAMES: Record<PennerFamily, string> = {
	sine: 'Sine',
	quad: 'Quad',
	cubic: 'Cubic',
	quart: 'Quart',
	quint: 'Quint',
	expo: 'Expo',
	circ: 'Circ',
	back: 'Back',
};
/** Peak overshoot / anticipation of the overshoot group. */
export const OVERSHOOT_AMOUNTS = { light: 0.05, medium: 0.12, strong: 0.25 } as const;
/** Envelope decay rate d of the elastic presets. */
export const ELASTIC_DECAYS = { soft: 3, medium: 6, strong: 10 } as const;
/** Damping ratios of the spring presets. */
export const SPRING_RATIOS = { critical: 1, smooth: 0.7, gentle: 0.5, bouncy: 0.3, wobbly: 0.15 } as const;

const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);

function specs(): Spec[] {
	const out: Spec[] = [];
	const add = (group: string, id: string, name: string, src: Omit<Spec, 'id' | 'name' | 'group'>) =>
		out.push({ id: `${group}.${id}`, name, group, ...src });

	// Basic: the keyframe model's eases (Linear = {⅓, 1}, Easy Ease = {⅓, 0} on both sides, Ease In / Ease Out
	// = {⅓, 0} on the arriving / leaving side only) and the CSS keywords.
	add('basic', 'linear', 'Linear', { curve: cubic(1 / 3, 1 / 3, 2 / 3, 2 / 3) });
	add('basic', 'easy-ease', 'Easy Ease', { curve: cubic(1 / 3, 0, 2 / 3, 1) });
	add('basic', 'easy-ease-in', 'Easy Ease In', { curve: cubic(1 / 3, 1 / 3, 2 / 3, 1) });
	add('basic', 'easy-ease-out', 'Easy Ease Out', { curve: cubic(1 / 3, 0, 2 / 3, 2 / 3) });
	add('basic', 'ease', 'Ease (CSS)', { curve: cubic(0.25, 0.1, 0.25, 1) });
	add('basic', 'ease-in', 'Ease In (CSS)', { curve: cubic(0.42, 0, 1, 1) });
	add('basic', 'ease-out', 'Ease Out (CSS)', { curve: cubic(0, 0, 0.58, 1) });
	add('basic', 'ease-in-out', 'Ease In-Out (CSS)', { curve: cubic(0.42, 0, 0.58, 1) });

	for (const family of PENNER_FAMILIES)
		for (const dir of ['in', 'out', 'in-out'] as const)
			add('penner', `${family}-${dir}`, `${PENNER_NAMES[family]} ${DIRECTION_NAMES[dir]}`, {
				fn: pennerEase(family, dir),
				...(family === 'expo' ? { derivative: pennerExpoDerivative(dir) } : {}),
			});

	for (const [amount, p] of Object.entries(OVERSHOOT_AMOUNTS)) {
		const label = cap(amount);
		add('overshoot', `anticipate-in-${amount}`, `Anticipate In (${label})`, { fn: overshootEase(p, 'in') });
		add('overshoot', `overshoot-out-${amount}`, `Overshoot Out (${label})`, { fn: overshootEase(p, 'out') });
		add('overshoot', `anticipate-overshoot-${amount}`, `Anticipate & Overshoot (${label})`, {
			fn: overshootEase(p, 'in-out'),
		});
	}

	for (const swings of [2, 3, 5])
		for (const [decay, d] of Object.entries(ELASTIC_DECAYS))
			add('elastic', `out-${swings}-${decay}`, `Elastic Out: ${swings} Swings, ${cap(decay)} Decay`, {
				fn: elasticEase(swings, d, 'out'),
			});
	for (const swings of [2, 3, 5])
		add('elastic', `in-${swings}-medium`, `Elastic In: ${swings} Swings, Medium Decay`, {
			fn: elasticEase(swings, ELASTIC_DECAYS.medium, 'in'),
		});

	for (const dir of ['out', 'in', 'in-out'] as const)
		for (const n of [2, 3, 4, 5])
			add('bounce', `${dir}-${n}`, `Bounce ${DIRECTION_NAMES[dir]}: ${n} Bounces`, {
				fn: bounceEase(n, bounceRestitution(n), dir),
			});

	const springNames: Record<keyof typeof SPRING_RATIOS, string> = {
		critical: 'Spring: Critically Damped',
		smooth: 'Spring: Smooth',
		gentle: 'Spring: Gentle',
		bouncy: 'Spring: Bouncy',
		wobbly: 'Spring: Wobbly',
	};
	for (const [id, zeta] of Object.entries(SPRING_RATIOS))
		add('spring', id, springNames[id as keyof typeof SPRING_RATIOS], { fn: springEase(zeta) });

	// Material Design 3 motion tokens (values: docs/wp-notes/easing.md "Built-in presets" → sources).
	add('material', 'standard', 'Standard', { curve: cubic(0.2, 0, 0, 1) });
	add('material', 'standard-decelerate', 'Standard Decelerate', { curve: cubic(0, 0, 0, 1) });
	add('material', 'standard-accelerate', 'Standard Accelerate', { curve: cubic(0.3, 0, 1, 1) });
	add('material', 'emphasized', 'Emphasized', { curve: M3_EMPHASIZED });
	add('material', 'emphasized-decelerate', 'Emphasized Decelerate', { curve: cubic(0.05, 0.7, 0.1, 1) });
	add('material', 'emphasized-accelerate', 'Emphasized Accelerate', { curve: cubic(0.3, 0, 0.8, 0.15) });
	add('material', 'legacy-standard', 'Legacy Standard', { curve: cubic(0.4, 0, 0.2, 1) });
	add('material', 'legacy-decelerate', 'Legacy Decelerate', { curve: cubic(0, 0, 0.2, 1) });
	add('material', 'legacy-accelerate', 'Legacy Accelerate', { curve: cubic(0.4, 0, 1, 1) });
	return out;
}

/**
 * Largest max |curve − source| a preset may have as one cubic-bezier (1 % of the value change) instead of a multi
 * curve. A cubic preset sets the handles of the selected keys; a multi one bakes keys at its points, which then do
 * not rescale when the outer keys move. Measured errors: docs/wp-notes/easing.md "Measured accuracy".
 */
const PRESET_CUBIC_TOLERANCE = 0.01;

let catalog: { presets: readonly EasePreset[]; sources: ReadonlyMap<string, EaseFunction> } | undefined;

function build() {
	if (catalog) return catalog;
	const presets: EasePreset[] = [];
	const sources = new Map<string, EaseFunction>();
	for (const s of specs()) {
		const curve =
			s.curve ??
			fitEaseCurve(s.fn as EaseFunction, {
				cubicTolerance: PRESET_CUBIC_TOLERANCE,
				...(s.derivative ? { derivative: s.derivative } : {}),
			});
		// Not re-validated here (zod's first parse costs more than the fitting); the tests parse every preset with
		// EasePresetSchema, and the fitter only emits curves inside the schema's bounds.
		presets.push(Object.freeze({ id: s.id, name: s.name, group: s.group, curve }));
		sources.set(s.id, s.fn ?? ((x: number) => evaluateEaseCurve(curve, x)));
	}
	catalog = { presets: Object.freeze(presets), sources };
	return catalog;
}

/** The built-in presets in catalog order (built and fitted on first call, then cached). */
export function builtinEasePresets(): readonly EasePreset[] {
	return build().presets;
}

/** The function a built-in preset was fitted from (or its exact curve), for accuracy checks and previews. */
export function builtinEaseSource(id: string): EaseFunction | undefined {
	return build().sources.get(id);
}

/**
 * The built-in presets as an array whose contents are built on first access (no fitting at import time). Reads
 * (index, length, iteration, array methods) all go to `builtinEasePresets()`.
 */
export const BUILTIN_EASE_PRESETS: readonly EasePreset[] = new Proxy([] as EasePreset[], {
	get: (_t, key) => Reflect.get(build().presets, key),
	has: (_t, key) => Reflect.has(build().presets, key),
	ownKeys: () => Reflect.ownKeys(build().presets),
	getOwnPropertyDescriptor: (target, key) => {
		const presets = build().presets;
		// Proxy invariants: `length` is the target's own non-configurable, writable property, so it is reported
		// with the target's attributes; the elements exist only on the frozen catalog and are reported configurable.
		if (key === 'length') return { ...Reflect.getOwnPropertyDescriptor(target, key), value: presets.length };
		const d = Reflect.getOwnPropertyDescriptor(presets, key);
		return d && { ...d, configurable: true };
	},
	set: () => false,
	defineProperty: () => false,
	deleteProperty: () => false,
});

// ---------------------------------------------------------------------------------------------------------------
// Matching

/** Sample count of `matchEasePreset` (x = i / MATCH_SAMPLES). */
const MATCH_SAMPLES = 256;
const sampledCache = new WeakMap<EaseCurve, Float64Array>();

function sampled(curve: EaseCurve): Float64Array {
	const hit = sampledCache.get(curve);
	if (hit) return hit;
	const ys = new Float64Array(MATCH_SAMPLES + 1);
	for (let i = 0; i <= MATCH_SAMPLES; i++) ys[i] = evaluateEaseCurve(curve, i / MATCH_SAMPLES);
	sampledCache.set(curve, ys);
	return ys;
}

/**
 * The preset whose curve is within `tolerance` of `curve` at every one of 257 evenly spaced x (so a cubic and an
 * equivalent multi curve match), the closest one when several do (first in catalog order on ties); null if none.
 */
export function matchEasePreset(
	curve: EaseCurve,
	presets: readonly EasePreset[] = BUILTIN_EASE_PRESETS,
	tolerance = 1e-3,
): EasePreset | null {
	const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 1e-3;
	const ys = new Float64Array(MATCH_SAMPLES + 1);
	for (let i = 0; i <= MATCH_SAMPLES; i++) {
		const y = evaluateEaseCurve(curve, i / MATCH_SAMPLES);
		if (!Number.isFinite(y)) return null;
		ys[i] = y;
	}
	let best: EasePreset | null = null;
	let bestErr = Number.POSITIVE_INFINITY;
	for (const p of presets) {
		const ps = sampled(p.curve);
		let worst = 0;
		for (let i = 0; i <= MATCH_SAMPLES && worst <= tol; i++)
			worst = Math.max(worst, Math.abs((ps[i] as number) - (ys[i] as number)));
		if (worst <= tol && worst < bestErr) {
			best = p;
			bestErr = worst;
		}
	}
	return best;
}
