// spec 13 AS-073 — runs of shaken layers. A shaken layer the native kernel cannot draw (S_Shake with motion blur,
// RGB split or wrap: `loweredRefusal`) is baked as a master; the masters of a track that follow each other closely
// bake as ONE master per run (one render's fixed cost and one composite input instead of one each). The layer bake
// (extension.ts) and the memory preflight (export/memory.ts) group with this one rule.
import type { RenderVisualClip } from '@jasper/project';

const SHAKE = 'jasper.s.shake';
/** A run spans clips at most this far apart (frames) … */
export const RUN_GAP = 60;
/** … and at most this long in all (frames), which bounds one render's length and a failed run's retry. */
export const RUN_MAX_FRAMES = 3600;

/** Whether a master-baked layer may join a run (shaken, normal blend, no handles or fades: drawn as one input). */
export function runEligible(c: RenderVisualClip): boolean {
	return (
		c.effects.some((fx) => fx.enabled && fx.effectId === SHAKE) &&
		(c.blendMode ?? 'normal') === 'normal' &&
		!c.headHandle &&
		!c.tailHandle &&
		!c.fades?.length
	);
}

/**
 * The runs (two or more clips) of one track's eligible master layers, in time order: a run breaks where clips
 * overlap, where the gap exceeds `RUN_GAP` or where the run would exceed `RUN_MAX_FRAMES`.
 */
export function shakeRuns<T>(items: readonly T[], clipOf: (it: T) => RenderVisualClip): T[][] {
	const sorted = [...items].sort((a, b) => clipOf(a).start - clipOf(b).start);
	const out: T[][] = [];
	let cur: T[] = [];
	const flush = () => {
		if (cur.length >= 2) out.push(cur);
		cur = [];
	};
	for (const it of sorted) {
		const c = clipOf(it);
		const prev = cur.length ? clipOf(cur[cur.length - 1]!) : null;
		const first = cur.length ? clipOf(cur[0]!) : null;
		if (
			prev &&
			first &&
			(c.start < prev.start + prev.duration ||
				c.start - (prev.start + prev.duration) > RUN_GAP ||
				c.start + c.duration - first.start > RUN_MAX_FRAMES)
		)
			flush();
		cur.push(it);
	}
	flush();
	return out;
}
