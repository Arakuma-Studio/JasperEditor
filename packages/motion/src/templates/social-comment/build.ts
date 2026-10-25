// social-comment@1 timelines: the schedule of @jasper/mg-templates (`socialCommentSchedule`, shared with the motion
// model) built as paused anime.js timelines. Value engine only (S11:ANM-004): the targets are plain objects, React
// draws inline styles from their seeked values.
import { type SocialCommentSchedule, TEMPLATE_EASE_FUNCTIONS } from '@jasper/mg-templates';
import type { EasingParam } from 'animejs';
import { createPausedTimeline, roundValue, seekCanonical } from '../../runtime/index.ts';

/** Card: scale, opacity, drop (design px), tilt (deg). Word unit: s, o. Heart: s (thump), f (fill). */
export type SocialValues = Record<string, number>;

/** The anime.js ease of a schedule ease name: the closed-form template eases are handed over as functions. */
export function socialEase(name: string): EasingParam {
	return Object.hasOwn(TEMPLATE_EASE_FUNCTIONS, name) ? TEMPLATE_EASE_FUNCTIONS[name]! : name;
}

/** Rest values of the targets: the card at rest, words shown, the heart unscaled and not filled. */
function restTarget(target: number, schedule: SocialCommentSchedule): SocialValues {
	if (target === 0) return { s: 1, o: 1, y: 0, r: 0 };
	if (target === schedule.heartTarget) return { s: 1, f: 0 };
	return { s: 1, o: 1 };
}

/**
 * The timeline of a schedule: targets `[card, ...word units, heart?]`, every track's tweens added with explicit
 * `[from, to]` values (S11:ANM-005) at their content ms. Before its first tween a value shows the track's initial
 * value (the entrance's start, a hidden word, an unfilled heart).
 */
export function buildSocialComment(schedule: SocialCommentSchedule): {
	timeline: ReturnType<typeof createPausedTimeline>;
	targets: SocialValues[];
} {
	const tl = createPausedTimeline();
	const count = 1 + schedule.units + (schedule.heartTarget === null ? 0 : 1);
	const targets = Array.from({ length: count }, (_, i) => restTarget(i, schedule));
	for (const track of schedule.tracks) {
		const target = targets[track.target];
		if (!target) continue;
		target[track.prop] = track.initial;
		for (const tw of track.tweens)
			tl.add(
				target,
				{ [track.prop]: [tw.from, tw.to], duration: tw.dur, ease: socialEase(tw.ease) },
				tw.start,
			);
	}
	return { timeline: tl, targets };
}

/** The like count tick on its own timeline (progress `p` 0 → 1), read un-rounded like counter@1's count. */
export function buildSocialTick(tick: NonNullable<SocialCommentSchedule['tick']>): {
	timeline: ReturnType<typeof createPausedTimeline>;
	target: { p: number };
} {
	const tl = createPausedTimeline();
	const target = { p: 0 };
	tl.add(target, { p: [0, 1], duration: tick.dur, ease: socialEase(tick.ease) }, tick.start);
	return { timeline: tl, target };
}

/**
 * Tick progress at `ms`, un-rounded (the 1e-6 rounding of `useAnimeValues` would move a 5 M count in steps of 5), read
 * right after its canonical seek; values that round to 0 or 1 are exactly 0 / 1 so the first and last frames show 0
 * and the final count.
 */
export function socialTickProgressAt(tick: ReturnType<typeof buildSocialTick>, ms: number): number {
	seekCanonical(tick.timeline, ms);
	const p = tick.target.p;
	const r = roundValue(p);
	return r === 0 || r === 1 ? r : p;
}
