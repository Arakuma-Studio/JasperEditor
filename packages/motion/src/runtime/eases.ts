// The closed list of eases presets and templates may use (S11:TXA-003 `ease` param). Names are ours; values are
// anime.js ease strings. `steps` has no string form in anime.js 4 (removed from the core): resolve it with
// `resolveEase`, which returns the `steps(n)` function.
import type { EasingParam } from 'animejs';
import { steps } from 'animejs/easings';

export type EaseName =
	| 'linear'
	| 'in'
	| 'out'
	| 'inOut'
	| 'outBack'
	| 'outElastic'
	| 'outBounce'
	| 'outExpo'
	| 'inOutExpo'
	| 'steps';

export const EASES: Readonly<Record<EaseName, string>> = Object.freeze({
	linear: 'linear',
	in: 'in',
	out: 'out',
	inOut: 'inOut',
	outBack: 'outBack',
	outElastic: 'outElastic',
	outBounce: 'outBounce',
	outExpo: 'outExpo',
	inOutExpo: 'inOutExpo',
	steps: 'steps',
});

export const EASE_NAMES: readonly EaseName[] = Object.keys(EASES) as EaseName[];

export function isEaseName(v: unknown): v is EaseName {
	return typeof v === 'string' && Object.hasOwn(EASES, v);
}

/** The anime.js ease of a name (`steps` → `steps(count)`, count 8 by default or when not finite; unknown → `out`). */
export function resolveEase(name: EaseName | string, opts: { steps?: number } = {}): EasingParam {
	if (!isEaseName(name)) return EASES.out;
	if (name === 'steps') {
		const n = opts.steps;
		return steps(typeof n === 'number' && Number.isFinite(n) ? Math.max(1, Math.round(n)) : 8);
	}
	return EASES[name];
}
