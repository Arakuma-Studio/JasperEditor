// Native retime plan (workstream `time`): for every sequence frame a retimed video layer draws, the media frames that
// make its picture (`pickFrames` of @jasper/project: the same choice as the preview decoder) — reverse, time remaps,
// Frame Blending / Optical Flow and variable-frame-rate media. Pure; the decoder and the compositor follow it.
import {
	activeRemap,
	clipPictureTime,
	FLICKS_PER_SECOND,
	type FramePick,
	fileTimeOf,
	type FrameTimes,
	pickFrames,
	type Rational,
	type RenderVisualClip,
	remapEvaluator,
	type TimeInterpolation,
} from '@jasper/project';

export type RetimeFrame = FramePick & {
	/** Sequence frame. */
	frame: number;
	/** Media seconds shown (from the start of the file). */
	seconds: number;
};

export type RetimePlan = {
	/** First / one-past-last sequence frame of the intermediate. */
	f0: number;
	f1: number;
	interpolation: TimeInterpolation;
	frames: RetimeFrame[];
};

/** The clip-local frame whose picture is shown at `local` (freeze-frame transition handles: the edge frame). */
export function pictureLocal(
	c: Pick<RenderVisualClip, 'duration' | 'headHandle' | 'tailHandle' | 'freezeHead' | 'freezeTail'>,
	local: number,
): number {
	const firstReal = -(c.headHandle ?? 0) + (c.freezeHead ?? 0);
	if (c.freezeHead && local < firstReal) return firstReal;
	const lastReal = c.duration + (c.tailHandle ?? 0) - (c.freezeTail ?? 0) - 1;
	if (c.freezeTail && local > lastReal) return lastReal;
	return local;
}

/** Media seconds a retimed clip shows at sequence frame `f`. */
export function mediaSecondsAt(
	c: RenderVisualClip,
	f: number,
	fps: Rational,
	ev?: ReturnType<typeof remapEvaluator> | null,
): number {
	const pt = clipPictureTime(c, c.start + pictureLocal(c, f - c.start), fps);
	const m = ev ? ev(pt).m : pt;
	// imports (Interpret Footage): interpreted media time → file time (assumed frame rate, loop).
	return Math.max(0, fileTimeOf(c.mediaTime, m) / FLICKS_PER_SECOND);
}

/** The retime plan of a clip over sequence frames [f0, f1). */
export function planRetime(
	c: RenderVisualClip,
	f0: number,
	f1: number,
	fps: Rational,
	times: FrameTimes,
): RetimePlan {
	const interpolation = c.retime?.interpolation ?? 'frame-sampling';
	const remap = activeRemap(c);
	const ev = remap ? remapEvaluator(remap) : null;
	const frames: RetimeFrame[] = [];
	for (let f = f0; f < f1; f++) {
		const seconds = mediaSecondsAt(c, f, fps, ev);
		frames.push({ frame: f, seconds, ...pickFrames(times, seconds, interpolation) });
	}
	return { f0, f1, interpolation, frames };
}

/** Pairs of the plan in output order: consecutive frames that use the same (a, b) share one flow computation. */
export function pairRuns(
	frames: readonly RetimeFrame[],
): { a: number; b: number; from: number; to: number }[] {
	const out: { a: number; b: number; from: number; to: number }[] = [];
	for (let i = 0; i < frames.length; i++) {
		const f = frames[i]!;
		const last = out[out.length - 1];
		if (last && last.a === f.a && last.b === f.b && last.to === i) last.to = i + 1;
		else out.push({ a: f.a, b: f.b, from: i, to: i + 1 });
	}
	return out;
}
