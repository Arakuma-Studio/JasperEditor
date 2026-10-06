// Invariants and repair of Time Remapping data (workstream `time`), wired into invariants.ts:
// - INV-011: speed keyframes have finite times and sources, strictly increasing times;
// - INV-012: only video clips carry a remap, never together with Reverse Speed; ramps ≥ 0, ease in 0…1, finite edge
//   slopes, timeline speeds within ±20,000 %; Time Interpolation is a known mode;
// - INV-005: every visible frame shows a media time inside the media (one sequence frame of tolerance).
import type { Clip, TimeRemap } from '../schema/sequence.ts';
import { TIME_INTERPOLATIONS } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { remapFitDuration, remapFramesInMedia } from './bounds.ts';
import { activeRemap, effectiveRamp, MAX_REMAP_SPEED, remapSlopes } from './model.ts';

export type RemapIssue = { code: 'INV-005' | 'INV-011' | 'INV-012'; message: string };

type RemapClip = Clip & { timeRemap?: TimeRemap; timeInterpolation?: string };

/** Issues of a clip's time remap / interpolation data. `mediaDur` = media length in flicks (null = unknown). */
export function remapIssues(clip: Clip, rate: Rational, mediaDur: number | null): RemapIssue[] {
	const c = clip as RemapClip;
	const out: RemapIssue[] = [];
	if (c.timeInterpolation !== undefined && !(TIME_INTERPOLATIONS as readonly string[]).includes(c.timeInterpolation))
		out.push({ code: 'INV-012', message: `Clip ${c.id} has an unknown time interpolation "${c.timeInterpolation}"` });
	const r = c.timeRemap;
	if (!r) return out;
	if (c.kind !== 'video') {
		out.push({ code: 'INV-012', message: `Clip ${c.id} is a ${c.kind} clip and cannot be time-remapped` });
		return out;
	}
	const keys = r.keyframes;
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i]!;
		if (!Number.isFinite(k.time) || !Number.isFinite(k.source))
			out.push({ code: 'INV-011', message: `Speed keyframe ${k.id} of ${c.id} is not finite` });
		if (i > 0 && !(k.time > keys[i - 1]!.time))
			out.push({ code: 'INV-011', message: `Speed keyframes of ${c.id} must have strictly increasing times` });
		if (k.ramp !== undefined && !(k.ramp >= 0))
			out.push({ code: 'INV-012', message: `Speed keyframe ${k.id} of ${c.id} has a negative transition` });
		if (k.ease !== undefined && !(k.ease >= 0 && k.ease <= 1))
			out.push({ code: 'INV-012', message: `Speed keyframe ${k.id} of ${c.id} has an ease outside 0…1` });
	}
	for (const v of [r.speedBefore, r.speedAfter])
		if (v !== undefined && !Number.isFinite(v))
			out.push({ code: 'INV-012', message: `Clip ${c.id} has a non-finite edge speed` });
	if (out.length > 0 || !r.enabled) return out;
	if (c.speed.reverse)
		out.push({ code: 'INV-012', message: `Clip ${c.id} is time-remapped and plays in reverse at the same time` });
	const max = MAX_REMAP_SPEED / c.speed.rate + 1e-9;
	if (remapSlopes(r).some((s) => Math.abs(s) > max))
		out.push({ code: 'INV-012', message: `Clip ${c.id} has a speed segment beyond ±20,000 %` });
	// One sequence frame of tolerance at the end of the media (like INV-005 of linear clips).
	const tol = flicksPerFrame(rate) * c.speed.rate * MAX_REMAP_SPEED;
	const dur = mediaDur === null ? null : mediaDur + Math.min(tol, flicksPerFrame(rate) * 2);
	if (activeRemap(c) && !remapFramesInMedia(c, c.start, c.start + c.duration - 1, rate, dur))
		out.push({ code: 'INV-005', message: `Time-remapped clip ${c.id} shows frames outside its media` });
	return out;
}

/** Repairs a clip's remap in place (S01:PER-004 style); returns what was done. */
export function repairRemap(clip: Clip, rate: Rational, mediaDur: number | null): string[] {
	const c = clip as RemapClip;
	const notes: string[] = [];
	if (c.timeInterpolation !== undefined && !(TIME_INTERPOLATIONS as readonly string[]).includes(c.timeInterpolation)) {
		delete c.timeInterpolation;
		notes.push('unknown time interpolation reset to Frame Sampling');
	}
	const r = c.timeRemap;
	if (!r) return notes;
	if (c.kind !== 'video') {
		delete c.timeRemap;
		notes.push(`time remap removed from a ${c.kind} clip`);
		return notes;
	}
	const before = r.keyframes.length;
	const keys = r.keyframes
		.filter((k) => Number.isFinite(k.time) && Number.isFinite(k.source))
		.sort((a, b) => a.time - b.time)
		.filter((k, i, a) => i === 0 || k.time > a[i - 1]!.time);
	if (keys.length !== before) notes.push(`${before - keys.length} invalid speed keyframe(s) removed`);
	for (const k of keys) {
		if (k.ramp !== undefined && !(k.ramp > 0)) delete k.ramp;
		if (k.ease !== undefined) k.ease = Math.min(1, Math.max(0, Number.isFinite(k.ease) ? k.ease : 1));
	}
	r.keyframes = keys;
	keys.forEach((k, i) => {
		const e = effectiveRamp(keys, i);
		if (e > 0) k.ramp = e;
		else delete k.ramp;
	});
	if (r.speedBefore !== undefined && !Number.isFinite(r.speedBefore)) r.speedBefore = 1;
	if (r.speedAfter !== undefined && !Number.isFinite(r.speedAfter)) r.speedAfter = 1;
	if (!r.enabled) return notes;
	if (c.speed.reverse) {
		c.speed.reverse = false;
		notes.push('Reverse Speed turned off on a time-remapped clip');
	}
	if (!remapFramesInMedia(c, c.start, c.start, rate, mediaDur)) {
		delete c.timeRemap;
		notes.push('time remap removed: its first frame was outside the media');
		return notes;
	}
	const fit = remapFitDuration(c, c.duration, rate, mediaDur);
	if (fit < c.duration) {
		notes.push(`trimmed from ${c.duration} to ${fit} frames to stay inside the media`);
		c.duration = fit;
	}
	return notes;
}
