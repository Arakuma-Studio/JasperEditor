// Detect Peak's worker (spec 12 §2.7 "other audio: Detect Peak"): measures decoded samples with @jasper/audio-fx
// `analyzeSound` (the descriptors the Sound Library indexes with), off the main thread.
import { analyzeSound } from '@jasper/audio-fx';

export type AnalyzeRequest = { id: number; channels: Float32Array[]; sampleRate: number };
export type AnalyzeResponse =
	| { id: number; ok: true; peakSec: number; onsetSec: number; durationSec: number }
	| { id: number; ok: false; message: string };

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
	const { id, channels, sampleRate } = e.data;
	try {
		const d = analyzeSound(channels, sampleRate);
		(self as unknown as Worker).postMessage({
			id,
			ok: true,
			peakSec: d.peakSec,
			onsetSec: d.onsetSec,
			durationSec: d.durationSec,
		} satisfies AnalyzeResponse);
	} catch (err) {
		(self as unknown as Worker).postMessage({
			id,
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		} satisfies AnalyzeResponse);
	}
};
