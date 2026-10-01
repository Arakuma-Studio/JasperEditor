// Text animator catalogue (S11:TXA-002…004, ARCHITECTURE §20.1): pure metadata of the in/out presets of text
// clips. Implementations live in `@jasper/motion/text`, keyed `id@version`. The catalogue is filled by
// wp-m2-text-anim; the window maths (anchoring + compression) is shared by the snapshot, commands and the UI.
import type { ZodType } from 'zod';
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

/** The shipped presets (S11:TXA-003). Empty until wp-m2-text-anim lands. */
export const TEXT_ANIMATION_SPECS: readonly TextAnimationSpec[] = [];

export const textAnimationKey = (id: string, version: number) => `${id}@${version}`;

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
