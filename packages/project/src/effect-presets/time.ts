// Key time mapping of effect presets (S03:FX-030, §12.5 "Duplicate, copy/paste"): saving turns clip content time
// into an offset from the clip's first frame (sequence time, flicks); applying maps the offset by the preset type
// and turns it into the target clip's content time, on the target's frame grid.
//   Scale            o' = o × last' / last      (first and last frame map onto the target's first and last frame)
//   Anchor to In     o' = o                     (same distance from the In point)
//   Anchor to Out    o' = last' − (last − o)    (same distance from the Out point, i.e. the last frame)
// where `last` = (duration − 1) frames of the source and `last'` the same for the target.
import type { ClipTiming } from '../color/retime.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import type { EffectPresetType } from './schema.ts';

/** Offset (flicks from the first frame, sequence time) of a key at content time `time` on a clip. */
export function presetOffsetOf(time: number, clip: ClipTiming, rate: Rational): number {
	const F = flicksPerFrame(rate);
	const i = (time - clip.sourceIn) / (F * clip.speed.rate);
	return Math.round((clip.speed.reverse ? clip.duration - 1 - i : i) * F);
}

/** Maps an offset of a preset saved on `source` onto a target of `target.duration` frames at `target.rate`. */
export function mapPresetOffset(
	type: EffectPresetType,
	offset: number,
	source: { duration: number; rate: Rational },
	target: { duration: number; rate: Rational },
): number {
	const last = (source.duration - 1) * flicksPerFrame(source.rate);
	const lastT = (target.duration - 1) * flicksPerFrame(target.rate);
	if (type === 'anchor-in') return offset;
	if (type === 'anchor-out') return lastT - (last - offset);
	return last > 0 ? (offset * lastT) / last : offset;
}

/**
 * Content time (integer flicks, ≥ 0) of a mapped offset on the target clip: snapped to the target's frame grid
 * (S01:KF-005), then through the clip's in point, speed and direction.
 */
export function contentTimeOfOffset(offset: number, clip: ClipTiming, rate: Rational): number {
	const F = flicksPerFrame(rate);
	const i = Math.round(offset / F);
	const content = clip.speed.reverse
		? clip.sourceIn + (clip.duration - 1 - i) * F * clip.speed.rate
		: clip.sourceIn + i * F * clip.speed.rate;
	return Math.max(0, Math.round(content));
}

/** Both steps: a preset key offset → the target clip's content time. */
export function presetKeyTime(
	type: EffectPresetType,
	offset: number,
	source: { duration: number; rate: Rational },
	target: { timing: ClipTiming; rate: Rational },
): number {
	const mapped = mapPresetOffset(type, offset, source, {
		duration: target.timing.duration,
		rate: target.rate,
	});
	return contentTimeOfOffset(mapped, target.timing, target.rate);
}
