// @jasper/motion/text — text animator implementations (S11 §4.2, ARCHITECTURE §20.2), keyed `id@version` like
// `TEXT_ANIMATION_SPECS` in @jasper/project (a test asserts both lists match), and the window maths the text
// layer needs to seek them (S11:TXA-004). Owner: wp-m2-text-anim.
import type { ResolvedTextAnimator, TextAnimationSide } from '@jasper/project';
import { frameToMs, needsShaping, type TextUnit } from '../runtime/index.ts';
import { PRESET_IMPLS } from './presets.ts';
import type { TextAnimationImpl } from './types.ts';

export { orderRanks, typewriterCaretVisible, typewriterSchedule } from './presets.ts';
export {
	REST_UNIT_VALUES,
	type TextAnimationBuildContext,
	type TextAnimationImpl,
	type TextCaretContext,
	type UnitValues,
} from './types.ts';

/** The shipped implementations (one per catalogue preset). */
export const TEXT_ANIMATION_IMPLS: Readonly<Record<string, TextAnimationImpl>> = PRESET_IMPLS;

/** The implementation of a resolved animator, or undefined (unknown presets render at rest, S11:TXA-008). */
export function textAnimationImpl(
	a: Pick<ResolvedTextAnimator, 'preset' | 'version'>,
): TextAnimationImpl | undefined {
	return TEXT_ANIMATION_IMPLS[`${a.preset}@${a.version}`];
}

/** The side playing at a clip-local frame and the seek time of its In-ordered timeline. */
export type ActiveTextAnimation = {
	side: TextAnimationSide;
	animator: ResolvedTextAnimator;
	/** Seek time of the In-ordered timeline (Out windows play it mirrored). */
	ms: number;
	durationMs: number;
};

/**
 * Window of a clip-local frame (S11:TXA-004): In covers `[0, in)` (frame k → seek k), Out covers
 * `[duration − out, duration)` played mirrored (its last frame is the In timeline's start). Transition handles
 * clamp: before the clip the In start state, after it the Out end state. Seek times are whole frames
 * (`frame · 1000 / fps`, S11:ANM-003). Null = rest.
 */
export function activeTextAnimation(
	animation: { in?: ResolvedTextAnimator; out?: ResolvedTextAnimator } | undefined,
	localFrame: number,
	duration: number,
	fps: number,
): ActiveTextAnimation | null {
	const f = Math.round(localFrame);
	const a = animation?.in;
	if (a && a.frames > 0 && f < a.frames)
		return {
			side: 'in',
			animator: a,
			ms: frameToMs(Math.max(0, f), fps),
			durationMs: frameToMs(a.frames, fps),
		};
	const b = animation?.out;
	if (b && b.frames > 0 && f >= duration - b.frames) {
		const k = Math.min(f - (duration - b.frames), b.frames - 1);
		return {
			side: 'out',
			animator: b,
			ms: frameToMs(b.frames - 1 - k, fps),
			durationMs: frameToMs(b.frames, fps),
		};
	}
	return null;
}

/** The unit of an animator for a text: its `unit` param (or the preset default); `char` → `word` for RTL/complex scripts. */
export function textAnimationUnit(
	impl: TextAnimationImpl,
	params: Record<string, unknown>,
	text: string,
): TextUnit {
	const u = params.unit;
	const unit: TextUnit = u === 'char' || u === 'word' || u === 'line' ? u : impl.unitDefault;
	return unit === 'char' && needsShaping(text) ? 'word' : unit;
}
