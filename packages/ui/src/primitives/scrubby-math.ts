export type NumericSpec = { min?: number; max?: number; step?: number; precision?: number };

const decimalPrecision = (precision: number) =>
	Number.isFinite(precision) ? Math.trunc(Math.max(0, Math.min(10, precision))) : 0;

/** Rounds to `precision` decimals (0 = integers), avoiding binary noise. */
export function roundTo(value: number, precision = 0): number {
	const f = 10 ** decimalPrecision(precision);
	return Math.round(value * f) / f;
}

/** Clamps to [min, max] and rounds; the displayed value is always this one (S05:CT-025). */
export function clampValue(value: number, spec: NumericSpec): number {
	let v = value;
	if (spec.min !== undefined) v = Math.max(spec.min, v);
	if (spec.max !== undefined) v = Math.min(spec.max, v);
	return roundTo(v, spec.precision ?? 0);
}

/** Step multiplier for the held modifiers: Shift = 10×, Ctrl/Cmd = 0.1× (S05:CT-021). */
export function stepMultiplier(mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): number {
	if (mods.shiftKey) return 10;
	if (mods.ctrlKey || mods.metaKey) return 0.1;
	return 1;
}

/** Value change for `px` pixels of horizontal drag (1 step per px by default). */
export function scrubDelta(
	px: number,
	step: number,
	mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
	pixelsPerStep = 1,
): number {
	return (px / pixelsPerStep) * step * stepMultiplier(mods);
}

/**
 * Evaluates edit-mode input relative to `current` (S05:CT-022): a plain number, or `+10`, `-5`, `*2`,
 * `/2`, `x2`. Commas are accepted as decimal separators. Returns null when the text is not valid.
 */
export function evaluateEntry(text: string, current: number): number | null {
	const s = text.trim().replace(/,/g, '.').replace(/\s+/g, '');
	if (!s) return null;
	const num = (t: string) => (/^\d*\.?\d+$|^\d+\.$/.test(t) ? Number(t) : Number.NaN);
	let out: number;
	const op = s[0];
	const rest = s.slice(1);
	if (op === '+' && rest) out = current + num(rest);
	else if (op === '*' || op === 'x' || op === 'X') out = current * num(rest);
	else if (op === '/') {
		const d = num(rest);
		out = d === 0 ? Number.NaN : current / d;
	} else if (op === '-' && rest) {
		// "-5" is ambiguous: Premiere treats a leading minus in hot text as "subtract". We follow CT-022:
		// `-5` is relative. Use `=-5` to type an absolute negative value.
		out = current - num(rest);
	} else if (op === '=') {
		const body = rest.startsWith('-') ? -num(rest.slice(1)) : num(rest);
		out = body;
	} else out = num(s);
	return Number.isFinite(out) ? out : null;
}

/** Display text for a value (mixed values show an en dash, S05:CT-024). */
export function formatNumber(value: number | null, precision = 0): string {
	if (value === null || !Number.isFinite(value)) return '–';
	const digits = decimalPrecision(precision);
	return roundTo(value, digits).toFixed(digits);
}
