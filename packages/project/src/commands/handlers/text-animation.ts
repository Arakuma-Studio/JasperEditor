// Text animators on text clips (M2, S11:TXA-004…006, ARCHITECTURE §20.1): `clip.addText {textAnimation}`, the
// `textAnimation` patch of clip.update (also reached by `param.set` on the `textAnimation.*` properties), the
// razor rule and the W_ANIMATION_COMPRESSED warning. Owner: wp-m2-text-anim.
import type { Draft } from 'immer';
import type { ProjectDocument } from '../../schema/document.ts';
import type { Clip, TextAnimation, TextAnimator } from '../../schema/sequence.ts';
import {
	compressAnimationWindows,
	getTextAnimationSpec,
	latestTextAnimationSpec,
	scaleAnimationFrames,
	TEXT_ANIMATION_SIDES,
	type TextAnimationSide,
	type TextAnimationSpec,
	textAnimationKey,
} from '../../text-animations.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import type { ClipPatch, TextAnimationInput, TextAnimatorInput } from '../schemas/clip.ts';

export const TEXT_ANIMATION_OWNER = 'wp-m2-text-anim';

type DText = Draft<Extract<Clip, { kind: 'text' }>>;

function specFor(
	preset: string,
	version: number | undefined,
	side: TextAnimationSide,
	h: HandlerContext,
): TextAnimationSpec {
	const spec =
		version === undefined ? latestTextAnimationSpec(preset) : getTextAnimationSpec(preset, version);
	if (!spec)
		h.fail(
			'E_UNKNOWN_EFFECT',
			`Unknown text animation ${version === undefined ? preset : textAnimationKey(preset, version)}`,
			{ path: ['textAnimation', side, 'preset'] },
		);
	if (!spec.phases.includes(side))
		h.fail('E_INVALID_PARAM', `Text animation ${spec.id} cannot be used as ${side}`, {
			path: ['textAnimation', side, 'preset'],
		});
	return spec;
}

/** Validates `params` against the preset's strict schema (every field defaulted); errors carry the path. */
function validParams(
	spec: TextAnimationSpec,
	params: Record<string, unknown>,
	side: TextAnimationSide,
	h: HandlerContext,
): Record<string, unknown> {
	const parsed = spec.paramsSchema.safeParse(params);
	if (!parsed.success) {
		const issue = parsed.error.issues[0]!;
		const path = issue.path.map(String);
		h.fail(
			'E_INVALID_PARAM',
			`Invalid ${spec.id} param${path.length ? ` ${path.join('.')}` : ''}: ${issue.message}`,
			{ path: ['textAnimation', side, 'params', ...path] },
		);
	}
	return parsed.data as Record<string, unknown>;
}

/** A new side from a preset: params = defaults ⊕ given; window = given or the default at the sequence fps. */
function newAnimator(
	side: TextAnimationSide,
	input: TextAnimatorInput,
	seq: DSeq,
	h: HandlerContext,
): TextAnimator {
	const spec = specFor(input.preset, input.version, side, h);
	return {
		preset: spec.id,
		version: spec.version,
		durationFrames:
			input.durationFrames ?? scaleAnimationFrames(spec.defaultDurationFrames, seq.settings.frameRate),
		params: validParams(spec, { ...spec.defaults, ...(input.params ?? {}) }, side, h),
	};
}

/** Sets or removes one side; a clip without sides has no `textAnimation` at all (absent, never `{}`). */
function setSide(clip: DText, side: TextAnimationSide, a: TextAnimator | null): void {
	if (a) {
		clip.textAnimation ??= {};
		clip.textAnimation[side] = a;
	} else if (clip.textAnimation) delete clip.textAnimation[side];
	if (clip.textAnimation && !clip.textAnimation.in && !clip.textAnimation.out) delete clip.textAnimation;
}

/** Warns when the clip's in + out windows exceed its duration (they are scaled at render time, TXA-004). */
function warnIfCompressed(clip: DText, h: HandlerContext): void {
	if (compressionOf(clip)) h.warn('W_ANIMATION_COMPRESSED', compressionMessage(clip), ['textAnimation']);
}

function compressionOf(clip: { duration: number; textAnimation?: TextAnimation | null }): boolean {
	const ta = clip.textAnimation;
	if (!ta || (!ta.in && !ta.out)) return false;
	return compressAnimationWindows(clip.duration, ta.in?.durationFrames ?? 0, ta.out?.durationFrames ?? 0)
		.compressed;
}

function compressionMessage(clip: { id: string; duration: number; textAnimation?: TextAnimation | null }) {
	const ta = clip.textAnimation!;
	return `Text animations of ${clip.id} (in ${ta.in?.durationFrames ?? 0} + out ${ta.out?.durationFrames ?? 0} frames) exceed its ${clip.duration} frames and are scaled to fit`;
}

/** clip.addText `textAnimation`: writes the animators of the new clip (called after its layout). */
export function applyInitialTextAnimation(
	_doc: DDoc,
	seq: DSeq,
	clip: DClip,
	input: TextAnimationInput | undefined,
	h: HandlerContext,
): void {
	if (input === undefined) return;
	const t = clip as DText;
	for (const side of TEXT_ANIMATION_SIDES) {
		const s = input[side];
		if (s) setSide(t, side, newAnimator(side, s, seq, h));
	}
	warnIfCompressed(t, h);
}

/**
 * clip.update `{textAnimation}` (S11:TXA-006): `null` removes both sides; per side `null` removes it, an object
 * with `preset` replaces it (params reset to the preset's defaults, then merged), an object without `preset`
 * merges into the current side. Returns true when it handled the patch.
 */
export function applyTextAnimationPatch(
	_doc: DDoc,
	seq: DSeq,
	clip: DClip,
	p: Pick<ClipPatch, 'textAnimation'>,
	h: HandlerContext,
): boolean {
	if (p.textAnimation === undefined) return false;
	const t = clip as DText;
	if (p.textAnimation === null) {
		delete t.textAnimation;
		return true;
	}
	for (const side of TEXT_ANIMATION_SIDES) {
		const s = p.textAnimation[side];
		if (s === undefined) continue;
		if (s === null) setSide(t, side, null);
		else if (s.preset !== undefined) setSide(t, side, newAnimator(side, { ...s, preset: s.preset }, seq, h));
		else setSide(t, side, mergedAnimator(t, side, s, h));
	}
	warnIfCompressed(t, h);
	return true;
}

/** Merges a patch without `preset` into the current side (version change re-validates the params). */
function mergedAnimator(
	clip: DText,
	side: TextAnimationSide,
	s: Omit<TextAnimatorInput, 'preset'>,
	h: HandlerContext,
): TextAnimator {
	const cur = clip.textAnimation?.[side];
	if (!cur)
		h.fail('E_INVALID_PARAM', `Clip ${clip.id} has no ${side} animation; pass a preset`, {
			path: ['textAnimation', side, 'preset'],
		});
	const version = s.version ?? cur.version;
	const params = { ...(cur.params as Record<string, unknown>), ...(s.params ?? {}) };
	const known = getTextAnimationSpec(cur.preset, version);
	if (!known && (s.params !== undefined || s.version !== undefined))
		h.fail('E_UNKNOWN_EFFECT', `Unknown text animation ${textAnimationKey(cur.preset, version)}`, {
			path: ['textAnimation', side, 'preset'],
		});
	return {
		preset: cur.preset,
		version,
		durationFrames: s.durationFrames ?? cur.durationFrames,
		// Unknown presets are preserved untouched (S11:TXA-008); known ones are validated as a whole.
		params: known ? validParams(known, { ...known.defaults, ...params }, side, h) : params,
	};
}

/**
 * Razor (S11:TXA-005): the left part keeps `in` and drops `out`, the right part keeps `out` and drops `in`
 * (windows stay anchored to the visible edges).
 */
export function splitTextAnimation(left: DClip, right: DClip): void {
	if (left.kind !== 'text' || right.kind !== 'text') return;
	setSide(left as DText, 'out', null);
	setSide(right as DText, 'in', null);
}

/**
 * Transaction-level W_ANIMATION_COMPRESSED (S11:TXA-004) for edits other than the animator commands (trims,
 * razor, speed, frame-rate changes): text clips whose windows became compressed by the transaction. Clips the
 * text-animation handlers already warned about are skipped.
 */
export function compressionWarnings(
	before: ProjectDocument,
	after: ProjectDocument,
	warned: readonly { code: string; message: string }[],
): { code: 'W_ANIMATION_COMPRESSED'; message: string; path: string[] }[] {
	if (before === after) return [];
	const out: { code: 'W_ANIMATION_COMPRESSED'; message: string; path: string[] }[] = [];
	for (const [seqId, seq] of Object.entries(after.sequences)) {
		const prevSeq = before.sequences[seqId];
		if (prevSeq === seq) continue;
		for (const clip of Object.values(seq.clips)) {
			if (clip.kind !== 'text' || !clip.textAnimation || prevSeq?.clips[clip.id] === clip) continue;
			if (!compressionOf(clip)) continue;
			const prev = prevSeq?.clips[clip.id];
			if (prev?.kind === 'text' && compressionOf(prev) && sameWindows(prev, clip)) continue;
			const message = compressionMessage(clip);
			if (warned.some((w) => w.code === 'W_ANIMATION_COMPRESSED' && w.message === message)) continue;
			out.push({ code: 'W_ANIMATION_COMPRESSED', message, path: ['sequences', seqId, 'clips', clip.id] });
		}
	}
	return out;
}

function sameWindows(
	a: { duration: number; textAnimation?: TextAnimation | null },
	b: { duration: number; textAnimation?: TextAnimation | null },
): boolean {
	return (
		a.duration === b.duration &&
		a.textAnimation?.in?.durationFrames === b.textAnimation?.in?.durationFrames &&
		a.textAnimation?.out?.durationFrames === b.textAnimation?.out?.durationFrames
	);
}

/** Sequence frame-rate change (S11:TXA-005): animator windows keep their length in time (round, ≥ 1). */
export function remapTextAnimationFrames(
	clip: DClip,
	from: { num: number; den: number },
	to: { num: number; den: number },
): void {
	if (clip.kind !== 'text' || !clip.textAnimation) return;
	for (const side of TEXT_ANIMATION_SIDES) {
		const a = clip.textAnimation[side];
		if (a) a.durationFrames = scaleAnimationFrames(a.durationFrames, to, from);
	}
}
