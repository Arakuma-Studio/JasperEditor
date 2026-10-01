// Copying keyframed grades between clips (S06:CGU-004, CGA-002 copy_grade): keyframe times are clip content time,
// so a copied keyframe is re-timed to keep its offset from the clip's first frame. Shared by the web Paste Grade
// and the MCP copy_grade tool.
import type { Keyframe } from '../schema/common.ts';
import { flicksPerFrame, type Rational } from '../time.ts';

/** The clip fields that map sequence frames to content time. */
export type ClipTiming = {
	start: number;
	duration: number;
	sourceIn: number;
	speed: { rate: number; reverse: boolean };
};

/**
 * Keyframe times are clip content time (flicks). A copied keyframe keeps its offset from the clip's first
 * frame: source content time → frame offset in the source clip → content time at that offset in the target.
 * Times are rounded, clamped to ≥ 0 and deduplicated (the later key wins).
 */
export function retimeKeyframes<T>(
	keyframes: readonly Keyframe<T>[],
	from: ClipTiming,
	to: ClipTiming,
	rate: Rational,
): Keyframe<T>[] {
	const F = flicksPerFrame(rate);
	const offset = (t: number) => {
		const i = (t - from.sourceIn) / (F * from.speed.rate);
		return from.speed.reverse ? from.duration - 1 - i : i;
	};
	const at = (i: number) =>
		to.speed.reverse
			? to.sourceIn + (to.duration - 1 - i) * F * to.speed.rate
			: to.sourceIn + i * F * to.speed.rate;
	const byTime = new Map<number, Keyframe<T>>();
	for (const k of keyframes) {
		const time = Math.max(0, Math.round(at(offset(k.time))));
		byTime.set(time, { ...k, time });
	}
	return [...byTime.values()].sort((a, b) => a.time - b.time);
}
