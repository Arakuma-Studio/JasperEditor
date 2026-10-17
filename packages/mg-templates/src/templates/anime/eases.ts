// The anime.js 4.5.0 eases the anime templates use, as plain functions (ported from animejs
// `dist/modules/easings/eases/parser.js`, MIT, Copyright (c) 2025 Julian Garnier; the curves are Robert Penner's,
// BSD; record in licenses/ported/anime-template-motion.md). This package never imports animejs (ARCHITECTURE §3.1):
// the templates' sound-design motion model (`animeTemplateSpeed`) evaluates the same curves the renderer seeks, and
// @jasper/motion's tests compare both at every frame.

export type EaseFn = (t: number) => number;

const { pow, sin, sqrt, cos, asin, PI } = Math;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** anime.js `Back` default overshoot. */
const BACK_OVERSHOOT = 1.7;
/** anime.js `minValue`. */
const MIN_VALUE = 1e-11;

/** `easeInPower(p = 1.68)`: t^p. */
const easeInPower =
	(p = 1.68): EaseFn =>
	(t) =>
		pow(t, p);

const easeInFunctions: Record<string, EaseFn> = {
	'': easeInPower(),
	Quad: easeInPower(2),
	Cubic: easeInPower(3),
	Quart: easeInPower(4),
	Quint: easeInPower(5),
	Sine: (t) => 1 - cos((t * PI) / 2),
	Circ: (t) => 1 - sqrt(1 - t * t),
	Expo: (t) => (t ? pow(2, 10 * t - 10) : 0),
	Bounce: (t) => {
		// anime.js: `while (t < ((pow2 = pow(2, --b)) - 1) / 11);`
		let b = 3;
		let pow2 = pow(2, b);
		while (t < (pow2 - 1) / 11) {
			b--;
			pow2 = pow(2, b);
		}
		return 1 / pow(4, 3 - b) - 7.5625 * pow((pow2 * 3 - 2) / 22 - t, 2);
	},
	Back: (t) => (BACK_OVERSHOOT + 1) * t * t * t - BACK_OVERSHOOT * t * t,
	Elastic: ((amplitude = 1, period = 0.3) => {
		const a = clamp(amplitude, 1, 10);
		const p = clamp(period, MIN_VALUE, 2);
		const s = (p / (2 * PI)) * asin(1 / a);
		const e = (2 * PI) / p;
		return (t: number) => (t === 0 || t === 1 ? t : -a * pow(2, -10 * (1 - t)) * sin((1 - t - s) * e));
	})(),
};

const easeTypes: Record<string, (easeIn: EaseFn) => EaseFn> = {
	in: (easeIn) => (t) => easeIn(t),
	out: (easeIn) => (t) => 1 - easeIn(1 - t),
	inOut: (easeIn) => (t) => (t < 0.5 ? easeIn(t * 2) / 2 : 1 - easeIn(t * -2 + 2) / 2),
	outIn: (easeIn) => (t) => (t < 0.5 ? (1 - easeIn(1 - t * 2)) / 2 : (easeIn(t * 2 - 1) + 1) / 2),
};

const linear: EaseFn = (t) => t;
const cache = new Map<string, EaseFn>();

/**
 * The ease function of an anime.js ease string without parameters (`'out'`, `'inExpo'`, `'outBack'`, `'linear'`…);
 * an unknown name is anime.js's `none` (linear), as the parser does.
 */
export function animeEase(name: string): EaseFn {
	const hit = cache.get(name);
	if (hit) return hit;
	let fn: EaseFn = linear;
	for (const type of Object.keys(easeTypes))
		if (name.startsWith(type)) {
			const rest = name.slice(type.length);
			// longest type first: 'inOut' before 'in', 'outIn' before 'out'
			if ((type === 'in' && rest.startsWith('Out')) || (type === 'out' && rest.startsWith('In'))) continue;
			const easeIn = easeInFunctions[rest];
			if (easeIn) fn = easeTypes[type]!(easeIn);
			break;
		}
	cache.set(name, fn);
	return fn;
}

/**
 * The ease string a template's `ease` param resolves to (`@jasper/motion` `easeOf`): the names of `EASES` except
 * `steps` (its function has no string form: templates fall back to `out`), anything else `out`.
 */
export function animeTemplateEaseName(name: unknown): string {
	return typeof name === 'string' && ANIME_EASE_NAMES.has(name) ? name : 'out';
}

const ANIME_EASE_NAMES: ReadonlySet<string> = new Set([
	'linear',
	'in',
	'out',
	'inOut',
	'outBack',
	'outElastic',
	'outBounce',
	'outExpo',
	'inOutExpo',
]);
