// Spec 13 AS-002 / AS-011: the rules of Create Subtitles — layout and timing (`SubtitleRules`), text transforms
// (`SubtitleText`) and cut awareness (`CutAwareOptions`). Commands, the dialog and MCP share these schemas; every
// field is optional on input and resolved against the generic (Premiere-like) defaults or a template's defaults.
// Stored resolved (all fields) in `Sequence.captionGroups[id]` so `captions.regenerate` repeats a generation.
import { z } from 'zod';

/** Generic defaults: Premiere's Create Captions (spec 13 AS-002; docs/wp-notes/captions.md). */
export const GENERIC_SUBTITLE_RULES = {
	maxChars: 42,
	lines: 2,
	maxWords: null as number | null,
	minSeconds: 1,
	maxSeconds: 7,
	gapFrames: 0,
	breakPauseSeconds: 1,
	holdSeconds: null as number | null,
	punctuation: 'half' as PunctuationBreak,
};

export const PUNCTUATION_BREAKS = ['never', 'half', 'always'] as const;
export type PunctuationBreak = (typeof PUNCTUATION_BREAKS)[number];

/** Layout and timing rules (AS-002). Ranges are the dialog's. */
export const SubtitleRulesSchema = z.strictObject({
	maxChars: z
		.number()
		.int()
		.min(7)
		.max(72)
		.optional()
		.describe('Maximum characters per line (7–72, default 42)'),
	lines: z.number().int().min(1).max(3).optional().describe('Lines per subtitle (1–3, default 2)'),
	maxWords: z
		.number()
		.int()
		.min(1)
		.max(20)
		.nullable()
		.optional()
		.describe('Maximum words per subtitle (1–20; null = off, the default)'),
	minSeconds: z
		.number()
		.min(0.1)
		.max(10)
		.optional()
		.describe('Minimum duration in seconds (0.1–10, default 1)'),
	maxSeconds: z
		.number()
		.min(0.5)
		.max(60)
		.optional()
		.describe('Maximum duration in seconds (0.5–60, default 7)'),
	gapFrames: z
		.number()
		.int()
		.min(0)
		.max(30)
		.optional()
		.describe('Frames between subtitles (0–30, default 0)'),
	breakPauseSeconds: z
		.number()
		.min(0.05)
		.max(10)
		.optional()
		.describe('A pause at least this long starts a new subtitle (0.05–10 s, default 1)'),
	holdSeconds: z
		.number()
		.min(0)
		.max(10)
		.nullable()
		.optional()
		.describe(
			'Hold a subtitle on screen until the next one, up to this many seconds (null = off, the default)',
		),
	punctuation: z
		.enum(PUNCTUATION_BREAKS)
		.optional()
		.describe('Break after punctuation: never, once the subtitle is half full ("half", default), or always'),
});
export type SubtitleRulesInput = z.infer<typeof SubtitleRulesSchema>;
export type SubtitleRules = typeof GENERIC_SUBTITLE_RULES;

export const TEXT_CASES = ['as-spoken', 'upper', 'lower', 'sentence'] as const;
export type TextCase = (typeof TEXT_CASES)[number];

/** Glyph replacements applied when `replaceGlyphs` is on (fonts without typographic punctuation). */
export const GLYPH_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	['…', '...'],
	['“', '"'],
	['”', '"'],
	['„', '"'],
	['«', '"'],
	['»', '"'],
	['‘', "'"],
	['’', "'"],
	['‚', "'"],
	['–', '-'],
	['—', '-'],
	[' ', ' '],
];

/** Text transforms (AS-002). */
export const SubtitleTextSchema = z.strictObject({
	case: z.enum(TEXT_CASES).optional().describe('as-spoken (default), upper, lower or sentence'),
	stripTrailingPunctuation: z
		.boolean()
		.optional()
		.describe('Remove punctuation at the end of each subtitle (default false)'),
	replaceGlyphs: z
		.boolean()
		.optional()
		.describe('Replace glyphs the font lacks: … → ..., “ ” → ", ‘ ’ → \', – — → - (default false)'),
	/** The characters the chosen font lacks (from its character map); absent = every replaceable glyph. */
	missingGlyphs: z.string().max(512).optional(),
	profanity: z
		.strictObject({
			words: z.array(z.string().trim().min(1).max(64)).max(2000),
			mask: z.enum(['asterisks', 'first-letter']).optional(),
		})
		.nullable()
		.optional()
		.describe('Mask these words (case and punctuation ignored); null = off'),
});
export type SubtitleTextInput = z.infer<typeof SubtitleTextSchema>;
export type SubtitleText = {
	case: TextCase;
	stripTrailingPunctuation: boolean;
	replaceGlyphs: boolean;
	missingGlyphs?: string;
	profanity: { words: string[]; mask: 'asterisks' | 'first-letter' } | null;
};
export const GENERIC_SUBTITLE_TEXT: SubtitleText = {
	case: 'as-spoken',
	stripTrailingPunctuation: false,
	replaceGlyphs: false,
	profanity: null,
};

export const TRANSITION_BEHAVIOURS = ['snap', 'avoid'] as const;

/** Cut awareness (AS-010 / AS-011). */
export const CutAwareSchema = z.strictObject({
	enabled: z.boolean().optional().describe('Cut-aware timing (default true)'),
	lookBackSeconds: z
		.number()
		.min(0)
		.max(2)
		.optional()
		.describe('Start a subtitle on a cut up to this long before its first word (default 0.5 s)'),
	lookAheadSeconds: z
		.number()
		.min(0)
		.max(0.5)
		.optional()
		.describe('Move a start to a cut up to this long after it (default 0.05 s)'),
	trackIds: z
		.array(z.string().min(1))
		.max(1000)
		.nullable()
		.optional()
		.describe('Video tracks that define the picture (default null: every track below the subtitles)'),
	overlayCoverage: z
		.number()
		.min(0.01)
		.max(1)
		.optional()
		.describe('An overlay covering at least this fraction of the frame is a cut (default 0.5)'),
	includeJumpCuts: z.boolean().optional(),
	includeOverlays: z.boolean().optional(),
	transitions: z
		.enum(TRANSITION_BEHAVIOURS)
		.optional()
		.describe(
			'At two-sided transitions: snap boundaries to the edit point (default) or avoid the transition',
		),
});
export type CutAwareInput = z.infer<typeof CutAwareSchema>;
export type CutAwareOptions = {
	enabled: boolean;
	lookBackSeconds: number;
	lookAheadSeconds: number;
	trackIds: string[] | null;
	overlayCoverage: number;
	includeJumpCuts: boolean;
	includeOverlays: boolean;
	transitions: (typeof TRANSITION_BEHAVIOURS)[number];
};
export const DEFAULT_CUT_AWARE: CutAwareOptions = {
	enabled: true,
	lookBackSeconds: 0.5,
	lookAheadSeconds: 0.05,
	trackIds: null,
	overlayCoverage: 0.5,
	includeJumpCuts: true,
	includeOverlays: true,
	transitions: 'snap',
};

/** Wordless pieces shorter than this (frames) are dropped (AS-010 step 4). */
export const MIN_WORDLESS_PIECE_FRAMES = 3;
/** Two-sided transitions shorter than this (frames) are hard cuts, not zones (AS-013). */
export const MIN_ZONE_FRAMES = 3;

const defined = <T extends object>(o: T | undefined | null): Partial<T> => {
	const out: Partial<T> = {};
	if (!o) return out;
	for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	return out;
};

/** Rules from base (generic or a template's) and an input patch. */
export function resolveSubtitleRules(
	input: SubtitleRulesInput | undefined,
	base: Partial<SubtitleRules> = {},
): SubtitleRules {
	const r = { ...GENERIC_SUBTITLE_RULES, ...defined(base), ...defined(input) } as SubtitleRules;
	if (r.maxSeconds < r.minSeconds) r.maxSeconds = r.minSeconds;
	return r;
}

export function resolveSubtitleText(
	input: SubtitleTextInput | undefined,
	base: Partial<SubtitleText> = {},
): SubtitleText {
	const r = { ...GENERIC_SUBTITLE_TEXT, ...defined(base), ...defined(input) } as SubtitleText;
	if (r.profanity) r.profanity = { words: [...r.profanity.words], mask: r.profanity.mask ?? 'asterisks' };
	return r;
}

export function resolveCutAware(
	input: CutAwareInput | boolean | undefined,
	base: Partial<CutAwareOptions> = {},
): CutAwareOptions {
	if (typeof input === 'boolean') return { ...DEFAULT_CUT_AWARE, ...defined(base), enabled: input };
	return { ...DEFAULT_CUT_AWARE, ...defined(base), ...defined(input) } as CutAwareOptions;
}

/** Strict readers of stored (resolved) values: commands store full objects; damaged ones are repaired on load. */
export const StoredSubtitleRulesSchema = z.strictObject({
	maxChars: z.number().int().min(7).max(72),
	lines: z.number().int().min(1).max(3),
	maxWords: z.number().int().min(1).max(20).nullable(),
	minSeconds: z.number().min(0.1).max(10),
	maxSeconds: z.number().min(0.1).max(60),
	gapFrames: z.number().int().min(0).max(30),
	breakPauseSeconds: z.number().min(0.05).max(10),
	holdSeconds: z.number().min(0).max(10).nullable(),
	punctuation: z.enum(PUNCTUATION_BREAKS),
});
export const StoredSubtitleTextSchema = z.strictObject({
	case: z.enum(TEXT_CASES),
	stripTrailingPunctuation: z.boolean(),
	replaceGlyphs: z.boolean(),
	missingGlyphs: z.string().max(512).optional(),
	profanity: z
		.strictObject({
			words: z.array(z.string().min(1).max(64)).max(2000),
			mask: z.enum(['asterisks', 'first-letter']),
		})
		.nullable(),
});
export const StoredCutAwareSchema = z.strictObject({
	enabled: z.boolean(),
	lookBackSeconds: z.number().min(0).max(2),
	lookAheadSeconds: z.number().min(0).max(0.5),
	trackIds: z.array(z.string().min(1)).max(1000).nullable(),
	overlayCoverage: z.number().min(0.01).max(1),
	includeJumpCuts: z.boolean(),
	includeOverlays: z.boolean(),
	transitions: z.enum(TRANSITION_BEHAVIOURS),
});
