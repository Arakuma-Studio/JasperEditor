// Text animator catalogue (S11:TXA-002…004, ARCHITECTURE §20.1): pure metadata of the in/out presets of text
// clips. Implementations live in `@jasper/motion/text`, keyed `id@version` (a motion test asserts both lists
// match). The window maths (anchoring + compression) is shared by the snapshot, commands and the UI.
import { type ZodType, z } from 'zod';
import type { TextAnimation, TextAnimator } from './schema/sequence.ts';
import type { Rational } from './time.ts';

export type TextAnimationSide = 'in' | 'out';
export const TEXT_ANIMATION_SIDES: readonly TextAnimationSide[] = ['in', 'out'];

/** Frame rate the catalogue's `defaultDurationFrames` refer to (scaled to the sequence rate on apply). */
export const TEXT_ANIMATION_REFERENCE_FPS = 30;

export type TextAnimationSpec = {
	id: string;
	version: number;
	label: string;
	/** Gallery chip, e.g. `Fade`, `Slide`, `Pop`, `Typewriter`, `Reveal`. */
	category: string;
	/** Sides the preset supports (`out` plays the mirrored motion). */
	phases: readonly TextAnimationSide[];
	/** Strict zod object; every field defaulted (parsing `{}` yields the defaults). */
	paramsSchema: ZodType;
	defaults: Record<string, unknown>;
	/** Window length at TEXT_ANIMATION_REFERENCE_FPS. */
	defaultDurationFrames: number;
	description: string;
};

// ---------------------------------------------------------------- the catalogue (S11:TXA-003)

/** Animated piece of the text (S11 §0 *Unit*). */
export const TEXT_ANIMATION_UNITS = ['char', 'word', 'line'] as const;
/** Order in which the stagger visits the units (`random` is seeded by the clip id). */
export const TEXT_ANIMATION_ORDERS = ['forward', 'backward', 'center', 'edges', 'random'] as const;
/** Ease names: the closed list of `@jasper/motion` `EASES` (a motion test asserts both lists match). */
export const TEXT_ANIMATION_EASES = [
	'linear',
	'in',
	'out',
	'inOut',
	'outBack',
	'outElastic',
	'outBounce',
	'outExpo',
	'inOutExpo',
	'steps',
] as const;

const unitParam = (d: (typeof TEXT_ANIMATION_UNITS)[number]) =>
	z.enum(TEXT_ANIMATION_UNITS).default(d).describe('Animated piece: each character, word or laid-out line');
const staggerParam = (d: number) =>
	z
		.number()
		.min(0)
		.max(1)
		.default(d)
		.describe('Fraction of the window spread across the units (0 = all together)');
const orderParam = () =>
	z.enum(TEXT_ANIMATION_ORDERS).default('forward').describe('Order in which the units start');
const easeParam = (d: (typeof TEXT_ANIMATION_EASES)[number]) =>
	z.enum(TEXT_ANIMATION_EASES).default(d).describe('Easing of each unit');
const distanceParam = (d: number) =>
	z.number().min(0).max(4000).default(d).describe('Travel in pixels of the text box');

/** Builds a spec whose `defaults` are exactly what its schema yields for `{}`. */
function preset(
	s: Omit<TextAnimationSpec, 'defaults' | 'phases' | 'version' | 'paramsSchema'> & {
		params: z.ZodRawShape;
	},
): TextAnimationSpec {
	const { params, ...rest } = s;
	const paramsSchema = z.strictObject(params);
	return {
		...rest,
		version: 1,
		phases: ['in', 'out'],
		paramsSchema,
		defaults: paramsSchema.parse({}) as Record<string, unknown>,
	};
}

const slide = (id: string, label: string, direction: string) =>
	preset({
		id,
		label,
		category: 'Slide',
		defaultDurationFrames: 20,
		description: `Units slide ${direction} into place while fading in (out: the mirrored motion).`,
		params: {
			unit: unitParam('word'),
			stagger: staggerParam(0.3),
			order: orderParam(),
			ease: easeParam('outExpo'),
			distance: distanceParam(60),
		},
	});

/**
 * The shipped presets (S11:TXA-003). Every preset works as In and Out; Out plays the mirrored motion (the In
 * motion reversed in time: the last unit in is the first out).
 */
export const TEXT_ANIMATION_SPECS: readonly TextAnimationSpec[] = [
	preset({
		id: 'fade',
		label: 'Fade',
		category: 'Fade',
		defaultDurationFrames: 15,
		description: 'Opacity from 0 to 100 %, optionally staggered across units.',
		params: {
			unit: unitParam('word'),
			stagger: staggerParam(0),
			order: orderParam(),
			ease: easeParam('out'),
		},
	}),
	slide('slide-up', 'Slide Up', 'up'),
	slide('slide-down', 'Slide Down', 'down'),
	slide('slide-left', 'Slide Left', 'left'),
	slide('slide-right', 'Slide Right', 'right'),
	preset({
		id: 'pop',
		label: 'Pop',
		category: 'Pop',
		defaultDurationFrames: 20,
		description: 'Units scale up from a small size with a springy overshoot.',
		params: {
			unit: unitParam('char'),
			stagger: staggerParam(0.4),
			order: orderParam(),
			scale: z.number().min(0).max(4).default(0).describe('Start scale (1 = 100 %)'),
			bounce: z.number().min(0).max(0.9).default(0.5).describe('Spring bounce (0 = no overshoot)'),
		},
	}),
	preset({
		id: 'blur',
		label: 'Blur',
		category: 'Blur',
		defaultDurationFrames: 20,
		description: 'Units come into focus from a blur while fading in.',
		params: {
			unit: unitParam('word'),
			stagger: staggerParam(0.2),
			order: orderParam(),
			ease: easeParam('out'),
			blur: z.number().min(0).max(200).default(16).describe('Start blur radius in pixels'),
		},
	}),
	preset({
		id: 'typewriter',
		label: 'Typewriter',
		category: 'Typewriter',
		defaultDurationFrames: 30,
		description: 'Characters appear one after another, with an optional caret (out: deleted backwards).',
		params: {
			unit: z.enum(['char', 'word']).default('char').describe('Typed piece: each character or word'),
			caret: z.boolean().default(true).describe('Show a caret after the last typed unit'),
		},
	}),
	preset({
		id: 'tracking',
		label: 'Tracking',
		category: 'Tracking',
		defaultDurationFrames: 30,
		description: 'Letter spacing collapses from wide while fading in (out: expands while fading out).',
		params: {
			unit: unitParam('line'),
			stagger: staggerParam(0),
			order: orderParam(),
			ease: easeParam('outExpo'),
			spacing: z.number().min(0).max(5).default(0.5).describe('Extra letter spacing at the start, in em'),
		},
	}),
	preset({
		id: 'mask-reveal',
		label: 'Mask Reveal',
		category: 'Reveal',
		defaultDurationFrames: 20,
		description: 'Units rise into view from behind a mask at each line.',
		params: {
			unit: unitParam('line'),
			stagger: staggerParam(0.3),
			order: orderParam(),
			ease: easeParam('outExpo'),
		},
	}),
	preset({
		id: 'rotate-in',
		label: 'Rotate In',
		category: 'Rotate',
		defaultDurationFrames: 20,
		description: 'Units turn into place around their centre while fading in.',
		params: {
			unit: unitParam('char'),
			stagger: staggerParam(0.4),
			order: orderParam(),
			ease: easeParam('outBack'),
			angle: z.number().min(-720).max(720).default(90).describe('Start rotation in degrees'),
		},
	}),
	preset({
		id: 'drop',
		label: 'Drop',
		category: 'Drop',
		defaultDurationFrames: 25,
		description: 'Units fall from above and bounce into place.',
		params: {
			unit: unitParam('char'),
			stagger: staggerParam(0.4),
			order: orderParam(),
			ease: easeParam('outBounce'),
			distance: distanceParam(120),
		},
	}),
];

export const textAnimationKey = (id: string, version: number) => `${id}@${version}`;

/** The newest catalogue version of a preset id, or undefined. */
export function latestTextAnimationSpec(
	id: string,
	specs: readonly TextAnimationSpec[] = TEXT_ANIMATION_SPECS,
): TextAnimationSpec | undefined {
	let best: TextAnimationSpec | undefined;
	for (const s of specs) if (s.id === id && (!best || s.version > best.version)) best = s;
	return best;
}

/** Catalogue entry by id and version, or undefined. */
export function getTextAnimationSpec(
	id: string,
	version: number,
	specs: readonly TextAnimationSpec[] = TEXT_ANIMATION_SPECS,
): TextAnimationSpec | undefined {
	return specs.find((s) => s.id === id && s.version === version);
}

/** A reference-rate frame count at another frame rate (round, ≥ 1); also used by the sequence fps remap. */
export function scaleAnimationFrames(
	frames: number,
	toFps: Rational | number,
	fromFps: Rational | number = TEXT_ANIMATION_REFERENCE_FPS,
): number {
	const rate = (r: Rational | number) => (typeof r === 'number' ? r : r.num / r.den);
	return Math.max(1, Math.round((frames * rate(toFps)) / rate(fromFps)));
}

/** One side as rendered: params with the preset defaults merged (when known) and the compressed window. */
export type ResolvedTextAnimator = {
	preset: string;
	version: number;
	params: Record<string, unknown>;
	/** Window length in frames after compression (S11:TXA-004). */
	frames: number;
};

export type TextAnimationWindows = {
	in?: ResolvedTextAnimator;
	out?: ResolvedTextAnimator;
	/** `in + out` exceeded the clip and both were scaled (warning W_ANIMATION_COMPRESSED). */
	compressed: boolean;
	/** Presets not in the catalogue (preserved, passed through with their stored params). */
	unknown: string[];
};

/** Params of a side: the preset's defaults ⊕ the stored params, parsed by its schema when it accepts them. */
export function textAnimatorParams(
	animator: Pick<TextAnimator, 'params'>,
	spec: TextAnimationSpec | undefined,
): Record<string, unknown> {
	if (!spec) return { ...animator.params };
	const merged = { ...spec.defaults, ...animator.params };
	const parsed = spec.paramsSchema.safeParse(merged);
	return parsed.success ? (parsed.data as Record<string, unknown>) : merged;
}

/**
 * Compressed window lengths (S11:TXA-004): `in` covers `[0, in)`, `out` covers `[duration − out, duration)`.
 * When `in + out > duration` both are scaled proportionally (integers, each ≥ 1 while the clip has room for both).
 */
export function compressAnimationWindows(
	duration: number,
	inFrames: number,
	outFrames: number,
): { in: number; out: number; compressed: boolean } {
	const d = Math.max(1, Math.floor(duration));
	const total = inFrames + outFrames;
	if (total <= d) return { in: inFrames, out: outFrames, compressed: false };
	if (inFrames === 0) return { in: 0, out: d, compressed: true };
	if (outFrames === 0) return { in: d, out: 0, compressed: true };
	if (d === 1) return { in: 1, out: 1, compressed: true };
	const i = Math.min(d - 1, Math.max(1, Math.round((inFrames * d) / total)));
	return { in: i, out: d - i, compressed: true };
}

/**
 * Resolves the animators of a text clip for rendering (snapshot `animation`, S11:TXA-009): params with defaults
 * merged for known presets, windows compressed to the clip's duration. Pure; absent/null sides are omitted.
 */
export function resolveTextAnimationWindows(
	clip: { duration: number; textAnimation?: TextAnimation | null },
	specs: readonly TextAnimationSpec[] = TEXT_ANIMATION_SPECS,
): TextAnimationWindows {
	const ta = clip.textAnimation;
	const sides = { in: ta?.in ?? null, out: ta?.out ?? null };
	const unknown: string[] = [];
	const resolved: Partial<Record<TextAnimationSide, Omit<ResolvedTextAnimator, 'frames'>>> = {};
	for (const side of TEXT_ANIMATION_SIDES) {
		const a = sides[side];
		if (!a) continue;
		const spec = getTextAnimationSpec(a.preset, a.version, specs);
		if (!spec) unknown.push(textAnimationKey(a.preset, a.version));
		resolved[side] = { preset: a.preset, version: a.version, params: textAnimatorParams(a, spec) };
	}
	const w = compressAnimationWindows(
		clip.duration,
		sides.in ? Math.max(1, Math.round(sides.in.durationFrames)) : 0,
		sides.out ? Math.max(1, Math.round(sides.out.durationFrames)) : 0,
	);
	return {
		...(resolved.in ? { in: { ...resolved.in, frames: w.in } } : {}),
		...(resolved.out ? { out: { ...resolved.out, frames: w.out } } : {}),
		compressed: w.compressed,
		unknown,
	};
}
