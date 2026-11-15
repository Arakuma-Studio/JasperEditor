// Ease curves by name (docs/wp-notes/easing.md § Easing commands): a built-in preset id or name (case-insensitive),
// a CSS keyword (`linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out` → the `basic.*` preset with that timing) or
// `cubic-bezier(x1, y1, x2, y2)` (exactly four plain decimal numbers). Shared by apply_ease (apps/mcp) and the scene
// file format (`scene/`), so both accept the same names and refuse the same malformed input.
import { type CubicEase, CubicEaseSchema, EASE_Y_LIMIT, type EaseCurve, type EasePreset } from './curve.ts';
import { builtinEasePresets } from './presets.ts';

/** CSS easing keywords → the built-in preset with the same timing. */
export const CSS_EASE_KEYWORDS: Readonly<Record<string, string>> = {
	linear: 'basic.linear',
	ease: 'basic.ease',
	'ease-in': 'basic.ease-in',
	'ease-out': 'basic.ease-out',
	'ease-in-out': 'basic.ease-in-out',
};

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const CUBIC_RE = /^cubic-bezier\s*\(([^()]*)\)$/i;

export type EaseNameResult =
	| { ok: true; curve: EaseCurve; name: string; presetId?: string }
	| { ok: false; message: string; near: string[] };

/** The built-in preset with this id, else the one with this name (case-insensitive). */
export function easePresetByIdOrName(text: string): EasePreset | undefined {
	const all = builtinEasePresets();
	const lower = text.trim().toLowerCase();
	return all.find((p) => p.id === text) ?? all.find((p) => p.name.toLowerCase() === lower);
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Resolves an ease name; never throws (malformed input is `{ok: false}` naming the problem and close preset ids). */
export function parseEaseName(input: string): EaseNameResult {
	const text = input.trim();
	const m = CUBIC_RE.exec(text);
	if (m) {
		const parts = m[1]!.split(',').map((s) => s.trim());
		if (parts.length !== 4 || parts.some((p) => !NUMBER_RE.test(p)))
			return {
				ok: false,
				message: `Invalid cubic-bezier "${text}": it takes four numbers, e.g. cubic-bezier(0.25, 0.1, 0.25, 1)`,
				near: [],
			};
		const [x1, y1, x2, y2] = parts.map(Number) as [number, number, number, number];
		const parsed = CubicEaseSchema.safeParse({ kind: 'cubic', x1, y1, x2, y2 });
		if (!parsed.success)
			return {
				ok: false,
				message: `Invalid cubic-bezier "${text}": x1, x2 must be in 0…1, y1, y2 in −${EASE_Y_LIMIT}…${EASE_Y_LIMIT}`,
				near: [],
			};
		const c = parsed.data as CubicEase;
		return { ok: true, curve: c, name: `cubic-bezier(${r4(c.x1)}, ${r4(c.y1)}, ${r4(c.x2)}, ${r4(c.y2)})` };
	}
	const lower = text.toLowerCase();
	const keyword = Object.hasOwn(CSS_EASE_KEYWORDS, lower) ? CSS_EASE_KEYWORDS[lower] : undefined;
	const preset = easePresetByIdOrName(keyword ?? text);
	if (preset) return { ok: true, curve: preset.curve, name: preset.name, presetId: preset.id };
	const near = lower
		? builtinEasePresets()
				.filter((p) => p.id.includes(lower) || p.name.toLowerCase().includes(lower))
				.slice(0, 8)
				.map((p) => p.id)
		: [];
	return { ok: false, message: `Unknown ease preset "${text}"`, near };
}
