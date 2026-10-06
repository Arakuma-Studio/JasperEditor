// Auto-ducking on the model side (audio-mix): turns trigger activity regions (sequence time) into the volume keyframes
// of a target clip (content time). The audio analysis (RMS envelope → activity regions) is `@jasper/audio-dsp`
// (`envelopeDb`, `activeRegions`, `planDucking`); the engine runs it on the mixed triggers
// (`POST /api/audio/activity`) and the UI / MCP / Essential Sound submit `audio.autoDuck` with the regions.
import { duckKeyframes, sensitivityThresholdDb } from '@jasper/audio-dsp';
import { contentTimeAt } from '../derive/index.ts';
import type { Rational } from '../time.ts';
import { FLICKS_PER_SECOND, flicksPerFrame } from '../time.ts';
import type { AudioClip, NestAudioClip } from '../schema/sequence.ts';

export type DuckOptions = {
	/** Reduce the target by this much under the triggers (dB, positive). Premiere's default: 18 dB. */
	amountDb: number;
	/** Fade duration of each ramp (ms). Premiere's default: 800 ms. */
	fadeMs: number;
};

/** Premiere Essential Sound ▸ Ducking defaults (Sensitivity 6, Reduce By −18 dB, Fades 800 ms). */
export const DUCK_DEFAULTS = { sensitivity: 6, amountDb: 18, fadeMs: 800 } as const;

export { sensitivityThresholdDb };

/**
 * Volume keyframes (content time, flicks, dB) that duck `clip` under `regions` (sequence flicks): ramps from the
 * clip's static level down by `amountDb` over `fadeMs` before each region and back up after it; regions whose ramps
 * overlap stay ducked between them; everything is clamped to the clip (a cut ramp gets a keyframe at the edge).
 */
export function duckClipKeyframes(
	clip: Pick<AudioClip | NestAudioClip, 'start' | 'duration' | 'sourceIn' | 'speed' | 'volumeDb'>,
	rate: Rational,
	regions: readonly (readonly [number, number])[],
	opts: DuckOptions,
): { time: number; value: number }[] {
	const F = flicksPerFrame(rate);
	const toS = (flicks: number) => flicks / FLICKS_PER_SECOND;
	const clipStart = toS(clip.start * F);
	const clipEnd = toS((clip.start + clip.duration) * F);
	const kf = duckKeyframes(
		regions.map(([a, b]) => [toS(a), toS(b)] as [number, number]),
		clipStart,
		clipEnd,
		clip.volumeDb.value,
		Math.abs(opts.amountDb),
		opts.fadeMs / 1000,
	);
	const out = kf.map(({ t, db }) => ({
		time: Math.max(0, Math.round(contentTimeAt(clip, (t * FLICKS_PER_SECOND) / F, rate))),
		value: Math.max(-96, Math.min(15, db)),
	}));
	out.sort((a, b) => a.time - b.time);
	// Strictly increasing content times (a reversed clip runs backwards; equal times keep the later value).
	const dedup: { time: number; value: number }[] = [];
	for (const k of out) {
		const last = dedup[dedup.length - 1];
		if (last && last.time === k.time) last.value = k.value;
		else dedup.push(k);
	}
	return dedup;
}
