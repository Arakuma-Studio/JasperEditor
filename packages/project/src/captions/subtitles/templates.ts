// Spec 13 AS-020 / AS-021: subtitle templates — the style, layout, animation, effects, default rules, text transforms
// and highlight of a subtitle group, as one versioned JSON object shared by the built-ins, the user library (engine
// `subtitle-templates/library.json`), the project copies (`ProjectDocument.subtitleTemplates`) and agents.
//
// - `style` is a text style without a font id: the font is named by `fontFamily` (+ the style's weight / italic) and
//   resolved through the font library when applied (a family that is not installed renders with the default family,
//   and the editor shows an "install font" notice). Sizes (font, strokes, shadow, background) are authored for a
//   frame whose shorter side is `reference` (1080) px and scale with the sequence's shorter side.
// - `box.widthPct`: the paragraph box as % of the frame width; `position[aspect]`: the box centre as fractions of
//   the frame, per aspect ratio (16:9, 9:16, 1:1, 4:5; the nearest one is used).
// - `animation.textAnimation`: legacy in/out text animations (windows in seconds; they follow trims by design);
//   `animation.preset`: an effect preset (format of effect-presets/, type "anchor-in"): effects with keyframes whose
//   times count from each clip's In — applied per clip and re-anchored after trims and razor cuts.
// - `highlight`: none / the word being spoken / karaoke (spoken so far) / keywords, drawn with Source Text keys and
//   styled runs (text clips) or the caption highlight (caption tracks).
import { z } from 'zod';
import { type EffectPreset, EffectPresetSchema } from '../../effect-presets/schema.ts';
import { DEFAULT_FONT_FAMILY } from '../../factories.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import { type TextStyle, TextStyleSchema } from '../../schema/sequence.ts';
import { FLICKS_PER_SECOND } from '../../time.ts';
import {
	CutAwareSchema,
	SubtitleRulesSchema,
	SubtitleTextSchema,
	type CutAwareInput,
	type SubtitleRulesInput,
	type SubtitleTextInput,
} from './rules.ts';
import { type SubtitleHighlight, SubtitleHighlightSchema } from './model.ts';

export const SUBTITLE_TEMPLATE_FORMAT = 'jasper-subtitle-template';
export const SUBTITLE_TEMPLATE_VERSION = 1;
export const SUBTITLE_TEMPLATE_MAX_BYTES = 1024 * 1024;
export const SUBTITLE_TEMPLATE_REFERENCE = 1080;

export const ASPECT_KEYS = ['16:9', '9:16', '1:1', '4:5'] as const;
export type AspectKey = (typeof ASPECT_KEYS)[number];
const ASPECTS: Record<AspectKey, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };

const PointSchema = z.strictObject({ x: z.number().min(-1).max(2), y: z.number().min(-1).max(2) });

export const TemplateTextAnimatorSchema = z.strictObject({
	preset: z.string().min(1),
	version: z.number().int().optional(),
	seconds: z.number().min(0.01).max(60).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
});

export const SubtitleTemplateSchema = z.looseObject({
	format: z.literal(SUBTITLE_TEMPLATE_FORMAT),
	version: z.literal(SUBTITLE_TEMPLATE_VERSION),
	id: z.string().min(1).max(80),
	name: z.string().trim().min(1).max(120),
	description: z.string().max(2000).optional(),
	builtIn: z.boolean().optional(),
	createdAt: z.string().max(64).optional(),
	updatedAt: z.string().max(64).optional(),
	/** Default output of the template (Create Subtitles' Output). */
	output: z.enum(['text-clips', 'caption-track']).optional(),
	fontFamily: z.string().trim().min(1).max(200),
	/** A text style without `fontId` (sizes at `reference`). */
	style: TextStyleSchema.omit({ fontId: true }),
	reference: z.number().positive().max(16384).optional(),
	box: z.strictObject({ widthPct: z.number().min(5).max(100) }),
	position: z.looseObject(
		Object.fromEntries(ASPECT_KEYS.map((k) => [k, PointSchema.optional()])) as Record<
			AspectKey,
			z.ZodOptional<typeof PointSchema>
		>,
	),
	animation: z
		.looseObject({
			textAnimation: z
				.strictObject({
					in: TemplateTextAnimatorSchema.nullable().optional(),
					out: TemplateTextAnimatorSchema.nullable().optional(),
				})
				.nullable()
				.optional(),
			preset: EffectPresetSchema.nullable().optional(),
		})
		.optional(),
	rules: SubtitleRulesSchema.optional(),
	text: SubtitleTextSchema.optional(),
	cutAware: CutAwareSchema.optional(),
	highlight: SubtitleHighlightSchema.optional(),
});

export type TemplateTextAnimator = z.infer<typeof TemplateTextAnimatorSchema>;
export type SubtitleTemplate = {
	format: typeof SUBTITLE_TEMPLATE_FORMAT;
	version: typeof SUBTITLE_TEMPLATE_VERSION;
	id: string;
	name: string;
	description?: string;
	builtIn?: boolean;
	createdAt?: string;
	updatedAt?: string;
	output?: 'text-clips' | 'caption-track';
	fontFamily: string;
	style: Omit<TextStyle, 'fontId'>;
	reference?: number;
	box: { widthPct: number };
	position: Partial<Record<AspectKey, { x: number; y: number }>>;
	animation?: {
		textAnimation?: { in?: TemplateTextAnimator | null; out?: TemplateTextAnimator | null } | null;
		preset?: EffectPreset | null;
	};
	rules?: SubtitleRulesInput;
	text?: SubtitleTextInput;
	cutAware?: CutAwareInput;
	highlight?: SubtitleHighlight;
};

export type TemplateParseResult =
	| { ok: true; template: SubtitleTemplate }
	| { ok: false; code: 'E_SCHEMA' | 'E_INVALID_PARAM'; message: string };

/** Validates one template (an agent's JSON, a library entry, a project copy). Never throws. */
export function parseSubtitleTemplate(raw: unknown): TemplateParseResult {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		return { ok: false, code: 'E_SCHEMA', message: 'A subtitle template must be a JSON object' };
	const r = raw as Record<string, unknown>;
	if (r.format !== SUBTITLE_TEMPLATE_FORMAT)
		return {
			ok: false,
			code: 'E_SCHEMA',
			message: `Not a subtitle template (format must be "${SUBTITLE_TEMPLATE_FORMAT}")`,
		};
	if (typeof r.version === 'number' && r.version > SUBTITLE_TEMPLATE_VERSION)
		return {
			ok: false,
			code: 'E_SCHEMA',
			message: `Subtitle template version ${r.version} is newer than this app supports (${SUBTITLE_TEMPLATE_VERSION})`,
		};
	let size = 0;
	try {
		size = new TextEncoder().encode(JSON.stringify(raw)).length;
	} catch {
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The subtitle template is not serialisable' };
	}
	if (size > SUBTITLE_TEMPLATE_MAX_BYTES)
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The subtitle template is larger than 1 MB' };
	const p = SubtitleTemplateSchema.safeParse(raw);
	if (!p.success) {
		const i = p.error.issues[0]!;
		return { ok: false, code: 'E_SCHEMA', message: `${i.path.join('.') || 'template'}: ${i.message}` };
	}
	const preset = p.data.animation?.preset;
	if (preset && preset.type !== 'anchor-in')
		return {
			ok: false,
			code: 'E_INVALID_PARAM',
			message: 'animation.preset must be an "anchor-in" effect preset (keys count from each subtitle\'s In)',
		};
	return { ok: true, template: p.data as unknown as SubtitleTemplate };
}

/** The aspect key nearest to a frame (by log ratio). */
export function aspectKeyOf(width: number, height: number): AspectKey {
	const r = width > 0 && height > 0 ? width / height : 16 / 9;
	let best: AspectKey = '16:9';
	let bestD = Number.POSITIVE_INFINITY;
	for (const k of ASPECT_KEYS) {
		const d = Math.abs(Math.log(r / ASPECTS[k]));
		if (d < bestD) {
			bestD = d;
			best = k;
		}
	}
	return best;
}

/** The box centre (fractions of the frame) of a template for a frame: its aspect, else the nearest one given. */
export function templatePosition(t: SubtitleTemplate, width: number, height: number): { x: number; y: number } {
	const want = aspectKeyOf(width, height);
	if (t.position[want]) return t.position[want]!;
	const r = width > 0 && height > 0 ? width / height : 16 / 9;
	let best: { x: number; y: number } | null = null;
	let bestD = Number.POSITIVE_INFINITY;
	for (const k of ASPECT_KEYS) {
		const p = t.position[k];
		if (!p) continue;
		const d = Math.abs(Math.log(r / ASPECTS[k]));
		if (d < bestD) {
			bestD = d;
			best = p;
		}
	}
	return best ?? { x: 0.5, y: 0.85 };
}

/** Scale of a template's sizes for a frame (its shorter side over the reference). */
export function templateScale(t: SubtitleTemplate, width: number, height: number): number {
	const s = Math.min(width, height) / (t.reference ?? SUBTITLE_TEMPLATE_REFERENCE);
	return Number.isFinite(s) && s > 0 ? s : 1;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** A template's style for a frame, with a font id: sizes scaled, colours and options as authored. */
export function templateStyle(t: SubtitleTemplate, fontId: string, width: number, height: number): TextStyle {
	const k = templateScale(t, width, height);
	const s = JSON.parse(JSON.stringify(t.style)) as TextStyle & Record<string, unknown>;
	s.fontId = fontId;
	s.sizePx = Math.max(1, round2(s.sizePx * k));
	s.strokes = (s.strokes ?? []).map((x) => ({ ...x, widthPx: round2(x.widthPx * k) }));
	if (s.shadow) {
		const sh = s.shadow as NonNullable<TextStyle['shadow']> & { spreadPx?: number };
		sh.distancePx = round2(sh.distancePx * k);
		sh.blurPx = round2(sh.blurPx * k);
		if (typeof sh.spreadPx === 'number') sh.spreadPx = round2(sh.spreadPx * k);
	}
	if (s.background)
		s.background = {
			...s.background,
			paddingPx: round2(s.background.paddingPx * k),
			radiusPx: round2(s.background.radiusPx * k),
		};
	return s as TextStyle;
}

/** Sizes of a clip's style turned back into a template's reference frame (Save as Template). */
export function styleAtReference(style: TextStyle, width: number, height: number): Omit<TextStyle, 'fontId'> {
	const k = Math.min(width, height) / SUBTITLE_TEMPLATE_REFERENCE;
	const inv = Number.isFinite(k) && k > 0 ? 1 / k : 1;
	const { fontId: _f, ...rest } = JSON.parse(JSON.stringify(style)) as TextStyle;
	const s = rest as Omit<TextStyle, 'fontId'>;
	s.sizePx = round2(s.sizePx * inv);
	s.strokes = s.strokes.map((x) => ({ ...x, widthPx: round2(x.widthPx * inv) }));
	if (s.shadow) {
		const sh = s.shadow as NonNullable<TextStyle['shadow']> & { spreadPx?: number };
		sh.distancePx = round2(sh.distancePx * inv);
		sh.blurPx = round2(sh.blurPx * inv);
		if (typeof sh.spreadPx === 'number') sh.spreadPx = round2(sh.spreadPx * inv);
	}
	if (s.background)
		s.background = {
			...s.background,
			paddingPx: round2(s.background.paddingPx * inv),
			radiusPx: round2(s.background.radiusPx * inv),
		};
	return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Built-in templates (AS-021). Neutral names; bundled licence-safe fonts (OFL / Apache) except Pixel Pop, whose
// family the user installs (never bundled; the editor shows an install notice when it is missing).

const hex = (h: string, a = 1): [number, number, number, number] => {
	const n = Number.parseInt(h.replace('#', ''), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};
const WHITE: [number, number, number, number] = [1, 1, 1, 1];

function baseStyle(over: Partial<Omit<TextStyle, 'fontId'>>): Omit<TextStyle, 'fontId'> {
	return {
		weight: 400,
		italic: false,
		sizePx: 80,
		lineHeight: 1.15,
		trackingEm: 0,
		align: 'center',
		direction: 'auto',
		fill: WHITE,
		strokes: [],
		background: null,
		shadow: null,
		allCaps: false,
		...over,
	};
}

const SEC = FLICKS_PER_SECOND;
const PRESET_RATE = { num: 60000, den: 1001 };

/** An anchor-in effect preset for a template animation (key times are offsets from the In, in flicks). */
function animationPreset(
	id: string,
	name: string,
	effects: NonNullable<EffectPreset['effects']>,
): EffectPreset {
	return {
		format: 'jasper-effect-preset',
		version: 1,
		id: `subtitle.${id}`,
		name,
		type: 'anchor-in',
		source: { clipKind: 'text', duration: 120, frameRate: PRESET_RATE },
		effects,
	};
}

const lin = { influence: 1 / 3, slope: 1 };
const key = <T>(seconds: number, value: T, extra: Record<string, unknown> = {}) => ({
	time: Math.round(seconds * SEC),
	value,
	interpolation: 'linear' as const,
	easeIn: lin,
	easeOut: lin,
	...extra,
});

/**
 * S_Shake random amplitude of the Pixel Pop template, converted from the user's Premiere S_Shake (Amplitude 0.6,
 * Frequency 1, X / Y / Tilt Rand Amp 72 / 36 / 5): calibration method and result in docs/wp-notes/auto-subtitles.md
 * (§ "S_Shake calibration"). Our S_Shake offsets are Amplitude × Rand Amp × 0.1 layer-box widths × noise and
 * Amplitude × Tilt Rand Amp × 5° × noise (registry/fx/sapphire-distort-warp/math.ts).
 */
export const PIXEL_POP_SHAKE = { xRandAmp: 0.889, yRandAmp: 0.444, tiltRandAmp: 1 };

const PIXEL_FONT = 'Pixel12x10';
const PIXEL_PURPLE = hex('#AE00FF');
const PIXEL_SHADOW = hex('#221D58', 0.8);

/** The user's 2025 Pixel Pop pop-in (Transform: uniform scale 75 → 108 → 100 %, opacity 0 → 100 %, shutter 360°). */
const PIXEL_POP_PRESET = animationPreset('pixel-pop', 'Pixel Pop', [
	{
		effectId: 'jasper.transform',
		params: {
			uniformScale: { value: true },
			scaleHeight: { value: 75, keyframes: [key(0, 75), key(0.1, 108), key(0.167, 100)] },
			opacity: { value: 0, keyframes: [key(0, 0), key(0.05, 100)] },
			useCompShutterAngle: { value: false },
			shutterAngle: { value: 360 },
		},
	},
	{
		effectId: 'jasper.s.shake',
		params: {
			style: { value: 'normal' },
			amplitude: { value: 0.6 },
			frequency: { value: 1 },
			phase: { value: 0 },
			zDist: { value: 1 },
			motionBlur: { value: false },
			seed: { value: 0 },
			wrapX: { value: 'no' },
			wrapY: { value: 'no' },
			xRandAmp: { value: PIXEL_POP_SHAKE.xRandAmp },
			xRandFreq: { value: 1 },
			xWaveAmp: { value: 0 },
			yRandAmp: { value: PIXEL_POP_SHAKE.yRandAmp },
			yRandFreq: { value: 1 },
			yWaveAmp: { value: 0 },
			zRandAmp: { value: 0 },
			tiltRandAmp: { value: PIXEL_POP_SHAKE.tiltRandAmp },
			tiltRandFreq: { value: 1 },
			tiltWaveAmp: { value: 0 },
		},
	},
]);

/** The 2024 recipe: uniform scale 0.1 → 100 % over 0.083 s, full ease-in on the second key. */
const PIXEL_POP_CLASSIC_PRESET = animationPreset('pixel-pop-classic', 'Pixel Pop Classic', [
	{
		effectId: 'jasper.transform',
		params: {
			uniformScale: { value: true },
			scaleHeight: {
				value: 0.1,
				keyframes: [
					key(0, 0.1, { interpolation: 'bezier', easeOut: lin }),
					key(0.083, 100, { interpolation: 'bezier', easeIn: { influence: 1, slope: 0 } }),
				],
			},
			useCompShutterAngle: { value: false },
			shutterAngle: { value: 360 },
		},
	},
]);

/** The Pixel Pop rules (the user's measured style, spec 13 AS-002). */
export const PIXEL_POP_RULES: SubtitleRulesInput = {
	maxChars: 13,
	lines: 1,
	maxWords: 3,
	minSeconds: 0.2,
	maxSeconds: 2,
	gapFrames: 0,
	breakPauseSeconds: 0.3,
	holdSeconds: 0.5,
	punctuation: 'always',
};
const PIXEL_POP_TEXT: SubtitleTextInput = {
	case: 'as-spoken',
	stripTrailingPunctuation: false,
	replaceGlyphs: true,
	missingGlyphs: '…“”„‘’‚«»–—',
};

const pixelStyle = (sizePx: number, strokePx: number) =>
	baseStyle({
		weight: 500,
		sizePx,
		lineHeight: 1.1,
		fill: WHITE,
		strokes: [{ color: PIXEL_PURPLE, widthPx: strokePx, position: 'outside' }],
		shadow: { color: PIXEL_SHADOW, angleDeg: 0, distancePx: 0, blurPx: 24, spreadPx: 12 } as NonNullable<
			TextStyle['shadow']
		>,
	});

const t = (
	id: string,
	name: string,
	description: string,
	body: Omit<SubtitleTemplate, 'format' | 'version' | 'id' | 'name' | 'description' | 'builtIn'>,
): SubtitleTemplate => ({
	format: SUBTITLE_TEMPLATE_FORMAT,
	version: SUBTITLE_TEMPLATE_VERSION,
	id: `builtin:${id}`,
	name,
	description,
	builtIn: true,
	reference: SUBTITLE_TEMPLATE_REFERENCE,
	...body,
});

export const BUILTIN_SUBTITLE_TEMPLATES: readonly SubtitleTemplate[] = [
	t('pixel-pop', 'Pixel Pop', 'Short pixel-font words that pop in and shake: white, purple outline, soft shadow.', {
		output: 'text-clips',
		fontFamily: PIXEL_FONT,
		style: pixelStyle(98, 11.5),
		box: { widthPct: 75 },
		position: { '9:16': { x: 0.5, y: 0.5 }, '16:9': { x: 0.5, y: 0.83 }, '1:1': { x: 0.5, y: 0.7 }, '4:5': { x: 0.5, y: 0.62 } },
		animation: { preset: PIXEL_POP_PRESET },
		rules: PIXEL_POP_RULES,
		text: PIXEL_POP_TEXT,
		highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
	}),
	t('pixel-pop-classic', 'Pixel Pop Classic', 'Large pixel-font words zooming in from nothing, thick purple outline.', {
		output: 'text-clips',
		fontFamily: PIXEL_FONT,
		style: pixelStyle(130, 30),
		box: { widthPct: 75 },
		position: { '9:16': { x: 0.5, y: 0.5 }, '16:9': { x: 0.5, y: 0.8 }, '1:1': { x: 0.5, y: 0.7 }, '4:5': { x: 0.5, y: 0.62 } },
		animation: { preset: PIXEL_POP_CLASSIC_PRESET },
		rules: PIXEL_POP_RULES,
		text: PIXEL_POP_TEXT,
		highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
	}),
	t('subtitles', 'Subtitles', 'Classic subtitles: two lines on a translucent box at the bottom.', {
		output: 'caption-track',
		fontFamily: 'Source Sans 3',
		style: baseStyle({
			weight: 600,
			sizePx: 48,
			lineHeight: 1.25,
			background: { color: [0, 0, 0, 0.6], paddingPx: 12, radiusPx: 0 },
		}),
		box: { widthPct: 80 },
		position: { '16:9': { x: 0.5, y: 0.86 }, '9:16': { x: 0.5, y: 0.78 }, '1:1': { x: 0.5, y: 0.85 }, '4:5': { x: 0.5, y: 0.84 } },
		highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
	}),
	t('bold-pop', 'Bold Pop', 'Heavy upper-case words with a dark outline that pop in.', {
		output: 'text-clips',
		fontFamily: 'Montserrat',
		style: baseStyle({
			weight: 800,
			sizePx: 92,
			allCaps: true,
			strokes: [{ color: [0, 0, 0, 1], widthPx: 8, position: 'outside' }],
			shadow: { color: [0, 0, 0, 0.5], angleDeg: 90, distancePx: 4, blurPx: 8 },
		}),
		box: { widthPct: 80 },
		position: { '9:16': { x: 0.5, y: 0.58 }, '16:9': { x: 0.5, y: 0.8 }, '1:1': { x: 0.5, y: 0.72 }, '4:5': { x: 0.5, y: 0.64 } },
		animation: { textAnimation: { in: { preset: 'pop', seconds: 0.2 } } },
		rules: { maxChars: 16, lines: 1, maxWords: 3, minSeconds: 0.3, maxSeconds: 2.5, breakPauseSeconds: 0.4, holdSeconds: 0.4, punctuation: 'always' },
		text: { case: 'upper' },
		highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
	}),
	t('word-highlight', 'Word Highlight', 'Short lines where the word being spoken turns yellow.', {
		output: 'text-clips',
		fontFamily: 'Poppins',
		style: baseStyle({
			weight: 700,
			sizePx: 76,
			strokes: [{ color: [0, 0, 0, 1], widthPx: 6, position: 'outside' }],
		}),
		box: { widthPct: 82 },
		position: { '9:16': { x: 0.5, y: 0.62 }, '16:9': { x: 0.5, y: 0.82 }, '1:1': { x: 0.5, y: 0.75 }, '4:5': { x: 0.5, y: 0.68 } },
		rules: { maxChars: 22, lines: 2, maxWords: 6, minSeconds: 0.5, maxSeconds: 4, breakPauseSeconds: 0.6, punctuation: 'always' },
		highlight: { mode: 'word', color: hex('#FFD400') },
	}),
	t('karaoke', 'Karaoke', 'Words fill with colour as they are spoken.', {
		output: 'text-clips',
		fontFamily: 'Montserrat',
		style: baseStyle({
			weight: 800,
			sizePx: 70,
			fill: [1, 1, 1, 1],
			strokes: [{ color: [0, 0, 0, 1], widthPx: 6, position: 'outside' }],
		}),
		box: { widthPct: 84 },
		position: { '9:16': { x: 0.5, y: 0.64 }, '16:9': { x: 0.5, y: 0.83 }, '1:1': { x: 0.5, y: 0.76 }, '4:5': { x: 0.5, y: 0.7 } },
		rules: { maxChars: 28, lines: 2, maxWords: 8, minSeconds: 0.6, maxSeconds: 5, breakPauseSeconds: 0.7, punctuation: 'half' },
		highlight: { mode: 'karaoke', color: hex('#33D6FF') },
	}),
	t('minimal', 'Minimal', 'Plain white text with a soft shadow that fades in.', {
		output: 'text-clips',
		fontFamily: 'Inter',
		style: baseStyle({
			weight: 500,
			sizePx: 54,
			lineHeight: 1.25,
			shadow: { color: [0, 0, 0, 0.6], angleDeg: 90, distancePx: 2, blurPx: 6 },
		}),
		box: { widthPct: 80 },
		position: { '16:9': { x: 0.5, y: 0.87 }, '9:16': { x: 0.5, y: 0.76 }, '1:1': { x: 0.5, y: 0.85 }, '4:5': { x: 0.5, y: 0.82 } },
		animation: { textAnimation: { in: { preset: 'fade', seconds: 0.15 }, out: { preset: 'fade', seconds: 0.1 } } },
		highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
	}),
	t('lower-third', 'Lower Third', 'Left-aligned text on a dark bar in the lower third.', {
		output: 'text-clips',
		fontFamily: 'Source Sans 3',
		style: baseStyle({
			weight: 600,
			sizePx: 46,
			lineHeight: 1.2,
			align: 'left',
			background: { color: [0.06, 0.07, 0.09, 0.78], paddingPx: 16, radiusPx: 6 },
		}),
		box: { widthPct: 56 },
		position: { '16:9': { x: 0.34, y: 0.8 }, '9:16': { x: 0.5, y: 0.74 }, '1:1': { x: 0.4, y: 0.8 }, '4:5': { x: 0.42, y: 0.78 } },
		animation: { textAnimation: { in: { preset: 'slide-right', seconds: 0.25 } } },
		rules: { maxChars: 40, lines: 2, minSeconds: 1, maxSeconds: 6, punctuation: 'half' },
		highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
	}),
];

/** Bundled font families the built-ins use (OFL / Apache, shipped with the app). */
export const BUNDLED_TEMPLATE_FAMILIES = new Set(['Source Sans 3', 'Montserrat', 'Poppins', 'Inter']);

export function builtinSubtitleTemplate(id: string): SubtitleTemplate | null {
	return BUILTIN_SUBTITLE_TEMPLATES.find((x) => x.id === id) ?? null;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** The readable project templates by id. */
export function projectSubtitleTemplates(doc: Pick<ProjectDocument, 'sequences'>): Record<string, SubtitleTemplate> {
	const rec = (doc as { subtitleTemplates?: unknown }).subtitleTemplates;
	const out: Record<string, SubtitleTemplate> = {};
	if (!isPlain(rec)) return out;
	for (const [k, v] of Object.entries(rec)) {
		const r = parseSubtitleTemplate(v);
		if (r.ok && r.template.id === k) out[k] = r.template;
	}
	return out;
}

/** A template by id: the project copy first, then a built-in. */
export function findSubtitleTemplate(
	doc: Pick<ProjectDocument, 'sequences'>,
	id: string,
): SubtitleTemplate | null {
	return projectSubtitleTemplates(doc)[id] ?? builtinSubtitleTemplate(id);
}

/** INV-SUBTITLE (document level): the stored `subtitleTemplates` record. */
export function subtitleTemplatesIssues(doc: ProjectDocument): [string, string[]][] {
	const rec = (doc as { subtitleTemplates?: unknown }).subtitleTemplates;
	if (rec === undefined) return [];
	if (!isPlain(rec)) return [['subtitleTemplates must be an object of templates by id', ['subtitleTemplates']]];
	const out: [string, string[]][] = [];
	const keys = Object.keys(rec);
	if (keys.length > 500) out.push(['more than 500 subtitle templates', ['subtitleTemplates']]);
	for (const k of keys) {
		const r = parseSubtitleTemplate(rec[k]);
		if (!r.ok) out.push([`Subtitle template ${k}: ${r.message}`, ['subtitleTemplates', k]]);
		else if (r.template.id !== k)
			out.push([`Subtitle template ${k}: record key differs from id ${r.template.id}`, ['subtitleTemplates', k]]);
	}
	return out;
}

/** Load repair of `subtitleTemplates` (mutates; idempotent): unreadable templates dropped, keys = ids. */
export function repairSubtitleTemplates(
	doc: ProjectDocument,
	note: (action: string, entity: string, detail: string) => void,
): void {
	const d = doc as { subtitleTemplates?: unknown };
	if (d.subtitleTemplates === undefined) return;
	if (!isPlain(d.subtitleTemplates)) {
		delete d.subtitleTemplates;
		note('drop-subtitle-templates', 'subtitleTemplates', 'unreadable subtitle templates record removed');
		return;
	}
	const rec = d.subtitleTemplates;
	for (const k of Object.keys(rec)) {
		const r = parseSubtitleTemplate(rec[k]);
		if (!r.ok) {
			delete rec[k];
			note('drop-subtitle-template', k, `unreadable subtitle template removed (${r.message})`);
			continue;
		}
		if (r.template.id !== k) {
			(rec[k] as Record<string, unknown>).id = k;
			note('fix-id', k, 'subtitle template record key and id made equal');
		}
	}
	for (const k of Object.keys(rec).slice(500)) {
		delete rec[k];
		note('drop-subtitle-template', k, 'more than 500 subtitle templates');
	}
	if (Object.keys(rec).length === 0) delete d.subtitleTemplates;
}

/** Whether a template's font family is bundled (otherwise it must be installed in the font library). */
export function templateNeedsFont(t: SubtitleTemplate): boolean {
	return !BUNDLED_TEMPLATE_FAMILIES.has(t.fontFamily) && t.fontFamily !== DEFAULT_FONT_FAMILY;
}
