// Spec 13 SH-003: deep, per-field text style patches (batch styling, linked project text styles).
//
// A patch names only the fields it changes. Plain-object fields (`shadow`, `background`, `openType`) merge field by
// field, so `{shadow: {blurPx: 4}}` keeps the shadow's colour, angle, distance and spread; `null` removes a nullable
// object (`shadow: null` = no shadow) or an optional field (`kerning: null` = the read-time default). `strokes` is
// either a whole list (replaced) or edits of the list (`set` fields of stroke i, `remove` indices, `add` strokes).
// Pure: no document access; `diffStyle` is the inverse of `applyStylePatch` (applyStylePatch(a, diffStyle(a, b)) = b).
import { z } from 'zod';
import type { RGBA } from '../schema/common.ts';
import {
	TEXT_FIGURE_STYLES,
	TEXT_FIGURE_WIDTHS,
	TEXT_JUSTIFY_LAST,
	TEXT_SCRIPTS,
	TextKerningSchema,
	type TextStyle,
	TextStyleSchema,
} from '../schema/sequence.ts';

/** Most strokes a text style may carry (bounds what an untrusted patch allocates). */
export const MAX_TEXT_STROKES = 16;
/** Most project text styles in one document. */
export const MAX_TEXT_STYLES = 1000;
export const MAX_TEXT_STYLE_NAME = 120;

export type TextStroke = TextStyle['strokes'][number];
export type TextShadow = NonNullable<TextStyle['shadow']> & { spreadPx?: number };
export type TextBackground = NonNullable<TextStyle['background']>;

/** A stroke added where a style had none (Properties ▸ Add Stroke, `strokes.set` past the end). */
export const DEFAULT_TEXT_STROKE: TextStroke = { color: [0, 0, 0, 1], widthPx: 4, position: 'outside' };
/**
 * The shadow a partial shadow patch starts from when the style has none (Premiere's Shadow defaults). Only the
 * required fields: merging a complete shadow over it gives that shadow exactly (`spreadPx` absent = 0).
 */
export const DEFAULT_TEXT_SHADOW: TextShadow = {
	color: [0, 0, 0, 0.75],
	angleDeg: 135,
	distancePx: 7,
	blurPx: 10,
};
/** The box a partial background patch starts from (the Properties Box defaults). */
export const DEFAULT_TEXT_BACKGROUND: TextBackground = { color: [0, 0, 0, 0.6], paddingPx: 16, radiusPx: 0 };

const unit = z.number().min(0).max(1);
const ColorArg = z.tuple([unit, unit, unit, unit]);
const px = (max: number) => z.number().min(0).max(max);
const signedPx = z.number().min(-100_000).max(100_000);

export const TextStrokeArgSchema = z.strictObject({
	color: ColorArg,
	widthPx: px(1000),
	position: z.enum(['outside', 'center', 'inside']),
});
const StrokeFieldsSchema = TextStrokeArgSchema.partial();
const StrokeIndex = z
	.number()
	.int()
	.min(0)
	.max(MAX_TEXT_STROKES - 1);

/** `strokes`: a whole list, or edits of each clip's own list (applied in the order set → remove → add). */
export const TextStrokesPatchSchema = z.union([
	z.array(TextStrokeArgSchema).max(MAX_TEXT_STROKES),
	z.strictObject({
		/** Fields of stroke `index`; a clip without that stroke gets one (defaults + fields) at the end. */
		set: z
			.array(z.strictObject({ index: StrokeIndex, ...StrokeFieldsSchema.shape }))
			.max(MAX_TEXT_STROKES)
			.optional(),
		/** Strokes removed by index (indices of the list after `set`; missing indices are ignored). */
		remove: z.array(StrokeIndex).max(MAX_TEXT_STROKES).optional(),
		/** Strokes appended to every clip's list. */
		add: z.array(TextStrokeArgSchema).max(MAX_TEXT_STROKES).optional(),
	}),
]);

export const TextShadowPatchSchema = z
	.strictObject({
		color: ColorArg.optional(),
		angleDeg: z.number().min(-36_000).max(36_000).optional(),
		distancePx: z.number().min(-10_000).max(10_000).optional(),
		blurPx: px(1000).optional(),
		/** SH-002/SH-004: dilation of the glyph alpha before the blur (`TextStyle.shadow.spreadPx`, 0 = none). */
		spreadPx: px(1000).nullable().optional(),
	})
	.nullable();

export const TextBackgroundPatchSchema = z
	.strictObject({
		color: ColorArg.optional(),
		paddingPx: px(10_000).optional(),
		radiusPx: px(10_000).optional(),
	})
	.nullable();

const nb = <T extends z.ZodType>(s: T) => s.nullable().optional();
export const TextOpenTypePatchSchema = z
	.strictObject({
		discretionaryLigatures: nb(z.boolean()),
		contextualAlternates: nb(z.boolean()),
		stylisticAlternates: nb(z.boolean()),
		stylisticSets: nb(z.array(z.number().int().min(1).max(20)).max(20)),
		swash: nb(z.boolean()),
		titling: nb(z.boolean()),
		ordinals: nb(z.boolean()),
		fractions: nb(z.boolean()),
		allSmallCaps: nb(z.boolean()),
		figureStyle: nb(z.enum(TEXT_FIGURE_STYLES)),
		figureWidth: nb(z.enum(TEXT_FIGURE_WIDTHS)),
	})
	.nullable();

/** SH-003 `text.setStyle` patch: every field optional; `null` removes optional fields and nullable objects. */
export const TextStylePatchSchema = z.strictObject({
	/** A font id of `doc.fonts` (or a temp ref of a `font.add` earlier in the transaction). */
	fontId: z.string().min(1).optional(),
	weight: z.number().int().min(1).max(1000).optional(),
	italic: z.boolean().optional(),
	sizePx: z.number().positive().max(10_000).optional(),
	lineHeight: z.number().positive().max(100).optional(),
	trackingEm: z.number().min(-10_000).max(10_000).optional(),
	align: z.enum(['left', 'center', 'right', 'justify']).optional(),
	direction: z.enum(['ltr', 'rtl', 'auto']).optional(),
	fill: ColorArg.optional(),
	strokes: TextStrokesPatchSchema.optional(),
	background: TextBackgroundPatchSchema.optional(),
	shadow: TextShadowPatchSchema.optional(),
	allCaps: z.boolean().optional(),
	kerning: nb(TextKerningSchema),
	baselineShiftPx: nb(signedPx),
	tsume: nb(z.number().min(0).max(100)),
	fauxBold: nb(z.boolean()),
	fauxItalic: nb(z.boolean()),
	smallCaps: nb(z.boolean()),
	script: nb(z.enum(TEXT_SCRIPTS)),
	ligatures: nb(z.boolean()),
	openType: TextOpenTypePatchSchema.optional(),
	fontVariations: nb(
		z
			.record(z.string().regex(/^[\x20-\x7e]{4}$/), z.number().min(-100_000).max(100_000))
			.refine((r) => Object.keys(r).length <= 64, 'at most 64 axes'),
	),
	justifyLast: nb(z.enum(TEXT_JUSTIFY_LAST)),
	indentLeftPx: nb(signedPx),
	indentRightPx: nb(signedPx),
	indentFirstLinePx: nb(signedPx),
	spaceBeforePx: nb(signedPx),
	spaceAfterPx: nb(signedPx),
});
export type TextStylePatch = z.infer<typeof TextStylePatchSchema>;

/**
 * Stored per-clip deviations from a linked project text style (`TextClip.styleOverrides`): a patch whose strokes are
 * a whole list. Read leniently: unknown (newer) fields are kept.
 */
export const TextStyleOverridesSchema = z.looseObject({
	...TextStylePatchSchema.shape,
	strokes: z.array(TextStrokeArgSchema).max(MAX_TEXT_STROKES).optional(),
});
export type TextStyleOverrides = z.infer<typeof TextStyleOverridesSchema>;

/** Fields a style always has (never removed by `null`). */
const REQUIRED_KEYS = new Set([
	'fontId',
	'weight',
	'italic',
	'sizePx',
	'lineHeight',
	'trackingEm',
	'align',
	'direction',
	'fill',
	'strokes',
	'allCaps',
]);
/** Objects that `null` turns off. */
const NULLABLE_OBJECTS = new Set(['shadow', 'background']);
/** Objects merged field by field. */
const MERGED_OBJECTS = new Set(['shadow', 'background', 'openType']);

const isPlain = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Structural equality ignoring key order (JSON values). */
export function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
		return true;
	}
	if (isPlain(a) && isPlain(b)) {
		const ka = Object.keys(a).filter((k) => a[k] !== undefined);
		const kb = Object.keys(b).filter((k) => b[k] !== undefined);
		if (ka.length !== kb.length) return false;
		for (const k of ka) if (!sameValue(a[k], b[k])) return false;
		return true;
	}
	return false;
}

const defaultsOf = (key: string): Record<string, unknown> =>
	key === 'shadow'
		? (DEFAULT_TEXT_SHADOW as Record<string, unknown>)
		: key === 'background'
			? (DEFAULT_TEXT_BACKGROUND as Record<string, unknown>)
			: {};

function applyStrokes(list: readonly TextStroke[], patch: unknown): TextStroke[] {
	if (Array.isArray(patch)) return clone(patch) as TextStroke[];
	const p = (isPlain(patch) ? patch : {}) as {
		set?: ({ index: number } & Partial<TextStroke>)[];
		remove?: number[];
		add?: TextStroke[];
	};
	const out = clone([...list]) as TextStroke[];
	for (const { index, ...fields } of p.set ?? []) {
		const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
		if (index < out.length) out[index] = { ...out[index]!, ...clone(defined) };
		else out.push({ ...clone(DEFAULT_TEXT_STROKE), ...clone(defined) } as TextStroke);
	}
	const drop = [...new Set(p.remove ?? [])].filter((i) => i < out.length).sort((a, b) => b - a);
	for (const i of drop) out.splice(i, 1);
	for (const s of p.add ?? []) out.push(clone(s));
	return out;
}

/** The style with `patch` applied (a new object; `base` is not changed). */
export function applyStylePatch(base: TextStyle, patch: TextStylePatch | TextStyleOverrides): TextStyle {
	const out = clone(base) as unknown as Record<string, unknown>;
	for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
		if (v === undefined) continue;
		if (k === 'strokes') {
			out.strokes = applyStrokes((out.strokes as TextStroke[] | undefined) ?? [], v);
			continue;
		}
		if (v === null) {
			if (NULLABLE_OBJECTS.has(k)) out[k] = null;
			else if (!REQUIRED_KEYS.has(k)) delete out[k];
			continue;
		}
		if (MERGED_OBJECTS.has(k) && isPlain(v)) {
			const merged = clone(isPlain(out[k]) ? (out[k] as Record<string, unknown>) : defaultsOf(k));
			for (const [sk, sv] of Object.entries(v)) {
				if (sv === undefined) continue;
				if (sv === null) delete merged[sk];
				else merged[sk] = clone(sv);
			}
			out[k] = merged;
			continue;
		}
		out[k] = clone(v);
	}
	return out as unknown as TextStyle;
}

/**
 * What `style` changes relative to `base`, as stored overrides (strokes as a whole list, merged objects field by
 * field, `null` for removed fields). Empty object = the same style.
 */
export function diffStyle(base: TextStyle, style: TextStyle): TextStyleOverrides {
	const a = base as unknown as Record<string, unknown>;
	const b = style as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (sameValue(a[k], b[k])) continue;
		if (b[k] === undefined) {
			if (!REQUIRED_KEYS.has(k)) out[k] = null;
			continue;
		}
		const av = a[k];
		const bv = b[k];
		if (MERGED_OBJECTS.has(k) && isPlain(av) && isPlain(bv)) {
			const sub: Record<string, unknown> = {};
			for (const sk of new Set([...Object.keys(av), ...Object.keys(bv)])) {
				if (sameValue(av[sk], bv[sk])) continue;
				sub[sk] = bv[sk] === undefined ? null : clone(bv[sk]);
			}
			if (Object.keys(sub).length) out[k] = sub;
			continue;
		}
		out[k] = clone(bv);
	}
	return out as TextStyleOverrides;
}

/**
 * clip.update's text style merge (schema `TextStyleSchema.partial()`): fields replace, except a shadow or background
 * object given over an existing one, which merges into it so fields the caller did not name (a shadow's `spreadPx`,
 * fields of newer builds) survive. Callers pass whole objects there, so their result is unchanged otherwise.
 */
export function mergeStyleFields(base: TextStyle, fields: Partial<TextStyle>): TextStyle {
	const out = { ...base } as Record<string, unknown>;
	for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
		if (v === undefined) continue;
		const cur = out[k];
		out[k] = NULLABLE_OBJECTS.has(k) && isPlain(v) && isPlain(cur) ? { ...cur, ...v } : v;
	}
	return out as TextStyle;
}

/** Why `style` is not a storable text style (schema, stroke count, colour range), or null. */
export function textStyleProblem(style: unknown): string | null {
	const r = TextStyleSchema.safeParse(style);
	if (!r.success) {
		const i = r.error.issues[0]!;
		return `${i.path.join('.') || 'style'}: ${i.message}`;
	}
	const s = r.data as TextStyle;
	if (s.strokes.length > MAX_TEXT_STROKES) return `at most ${MAX_TEXT_STROKES} strokes`;
	const colors: [string, RGBA][] = [['fill', s.fill as RGBA]];
	for (const [i, st] of s.strokes.entries()) colors.push([`strokes.${i}.color`, st.color as RGBA]);
	if (s.shadow) colors.push(['shadow.color', s.shadow.color as RGBA]);
	if (s.background) colors.push(['background.color', s.background.color as RGBA]);
	for (const [where, c] of colors)
		if (!c.every((x) => Number.isFinite(x) && x >= 0 && x <= 1))
			return `${where}: colour components must be 0..1`;
	const spread = (s.shadow as { spreadPx?: unknown } | null)?.spreadPx;
	if (spread !== undefined && !(typeof spread === 'number' && Number.isFinite(spread) && spread >= 0))
		return 'shadow.spreadPx: must be a number ≥ 0';
	return null;
}

/** Top-level fields a patch names (for `runs: "clear-overridden"`). */
export function patchedFields(patch: TextStylePatch): string[] {
	return Object.entries(patch)
		.filter(([, v]) => v !== undefined)
		.map(([k]) => k);
}
