// The CPU part of indexing one sound (wp-note "WP1.2"): `analyzeSound` and the visual data, shared by the worker
// thread (analysis-worker.ts) and the in-thread fallback (analysis.ts). Pure apart from its inputs. A file of at most
// SOUND_TAKES_MAX_FILE_SECONDS arrives whole: its own descriptors and visual data still cover the first
// SOUND_ANALYSIS_SECONDS, and when it has two or more onsets it is also split into takes (P6-E9), each with its
// descriptors and visual data.
import { SOUND_ANALYSIS_SECONDS, SOUND_TAKES_MAX_FILE_SECONDS, type SoundVisual } from '@jasper/api';
import { type AnalysedTake, analyzeSound, analyzeTakes, type SoundDescriptors } from '@jasper/audio-fx';
import { takeIdOf } from '@jasper/project';
import { computeVisual } from './visual.ts';

type Common = {
	channels: Float32Array[];
	rate: number;
	soundId: string;
	fingerprint: string;
	durationSec: number;
};
/**
 * `analyse`: descriptors, visual data and takes; `visual`: visual data alone (peak known from the index); `take-visual`:
 * the visual data of the samples of one take (`soundId` is the take's id).
 */
export type AnalysisJob =
	| (Common & { kind: 'analyse' })
	| (Common & { kind: 'visual'; peakSec: number })
	| (Common & { kind: 'take-visual'; peakSec: number });
export type AnalysedTakeResult = AnalysedTake & { visual: SoundVisual };
export type AnalysisResult = {
	descriptors: SoundDescriptors | null;
	visual: SoundVisual;
	/** `analyse` of a file of 2+ onsets and at most SOUND_TAKES_MAX_FILE_SECONDS: its takes (possibly none). */
	takes?: AnalysedTakeResult[];
};

/** The first `seconds` of planar channels (views, no copy). */
function head(channels: Float32Array[], rate: number, seconds: number): Float32Array[] {
	const n = Math.floor(rate * seconds);
	return channels.map((c) => (c.length > n ? c.subarray(0, n) : c));
}

/** Throws `analyzeSound`'s `SoundAnalysisError` for unusable input. */
export function runAnalysis(job: AnalysisJob): AnalysisResult {
	if (job.kind === 'visual' || job.kind === 'take-visual')
		return {
			descriptors: null,
			visual: computeVisual({
				soundId: job.soundId,
				fingerprint: job.fingerprint,
				durationSec: job.durationSec,
				peakSec: job.peakSec,
				channels: job.kind === 'visual' ? head(job.channels, job.rate, SOUND_ANALYSIS_SECONDS) : job.channels,
				rate: job.rate,
			}),
		};
	const first = head(job.channels, job.rate, SOUND_ANALYSIS_SECONDS);
	let descriptors = analyzeSound(first, job.rate);
	// Longer files are analysed over their first seconds; the duration is the whole file's.
	if (job.durationSec > descriptors.durationSec + 0.05)
		descriptors = { ...descriptors, durationSec: job.durationSec };
	const visual = computeVisual({
		soundId: job.soundId,
		fingerprint: job.fingerprint,
		durationSec: descriptors.durationSec,
		peakSec: descriptors.peakSec,
		channels: first,
		rate: job.rate,
	});
	if (descriptors.onsetCount < 2 || !(job.durationSec <= SOUND_TAKES_MAX_FILE_SECONDS))
		return { descriptors, visual };
	const takes = analyzeTakes(job.channels, job.rate).map((t) => ({
		...t,
		visual: computeVisual({
			soundId: takeIdOf(job.soundId, t.index),
			fingerprint: job.fingerprint,
			durationSec: t.descriptors.durationSec,
			peakSec: t.descriptors.peakSec,
			channels: job.channels.map((c) => c.subarray(t.startSample, t.endSample)),
			rate: job.rate,
		}),
	}));
	return { descriptors, visual, takes };
}
