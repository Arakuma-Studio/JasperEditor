// The CPU part of indexing one sound (wp-note "WP1.2"): `analyzeSound` and the visual data, shared by the worker
// thread (analysis-worker.ts) and the in-thread fallback (analysis.ts). Pure apart from its inputs.
import type { SoundVisual } from '@jasper/api';
import { analyzeSound, type SoundDescriptors } from '@jasper/audio-fx';
import { computeVisual } from './visual.ts';

type Common = {
	channels: Float32Array[];
	rate: number;
	soundId: string;
	fingerprint: string;
	durationSec: number;
};
/** `analyse`: descriptors and visual data; `visual`: visual data alone (peak known from the index). */
export type AnalysisJob = (Common & { kind: 'analyse' }) | (Common & { kind: 'visual'; peakSec: number });
export type AnalysisResult = { descriptors: SoundDescriptors | null; visual: SoundVisual };

/** Throws `analyzeSound`'s `SoundAnalysisError` for unusable input. */
export function runAnalysis(job: AnalysisJob): AnalysisResult {
	if (job.kind === 'visual')
		return {
			descriptors: null,
			visual: computeVisual({
				soundId: job.soundId,
				fingerprint: job.fingerprint,
				durationSec: job.durationSec,
				peakSec: job.peakSec,
				channels: job.channels,
				rate: job.rate,
			}),
		};
	let descriptors = analyzeSound(job.channels, job.rate);
	// Longer files are analysed over their first seconds; the duration is the whole file's.
	if (job.durationSec > descriptors.durationSec + 0.05)
		descriptors = { ...descriptors, durationSec: job.durationSec };
	const visual = computeVisual({
		soundId: job.soundId,
		fingerprint: job.fingerprint,
		durationSec: descriptors.durationSec,
		peakSec: descriptors.peakSec,
		channels: job.channels,
		rate: job.rate,
	});
	return { descriptors, visual };
}
