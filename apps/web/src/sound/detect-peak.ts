// Detect Peak (spec 12 §2.7 clip menu, "other audio"): the peak of a project audio clip that is not a library sound,
// measured in the browser — the part of the media the clip uses is decoded (mediabunny, like audio scrubbing), and
// @jasper/audio-fx `analyzeSound` (the Sound Library's own descriptors: the centre of the loudest 2 ms RMS window)
// runs in a worker. The result is written with `soundDesign.setPeak` (one undo step), after which the clip has a peak
// handle, peak snapping, Align Peak…, Swap and In Context like a library sound. No engine route is needed.
import {
	type AudioClip,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type MediaAsset,
	type MediaTimeMap,
	mediaTimeMap,
	type Rational,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { decodeMediaRange } from '../audio/browser-decode.ts';
import { t } from '../i18n/runtime.ts';
import { resolveMediaHandle } from '../panels/program/render-doc.ts';
import type { AnalyzeRequest, AnalyzeResponse } from './analyze.worker.ts';

/** Longest stretch analysed (seconds of the clip's media; ≈ 46 MB of stereo 48 kHz float samples). */
export const DETECT_MAX_SEC = 120;

export class DetectPeakError extends Error {}

type Analysis = { peakSec: number; onsetSec: number; durationSec: number };

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, { resolve(a: Analysis): void; reject(e: Error): void }>();

function getWorker(): Worker | null {
	if (worker !== undefined) return worker;
	try {
		if (typeof Worker === 'undefined' || typeof window === 'undefined') {
			worker = null;
			return worker;
		}
		worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (e: MessageEvent<AnalyzeResponse>) => {
			const p = pending.get(e.data.id);
			pending.delete(e.data.id);
			if (!p) return;
			if (e.data.ok) p.resolve(e.data);
			else p.reject(new DetectPeakError(e.data.message));
		};
		worker.onerror = () => {
			worker = null;
			for (const p of pending.values()) p.reject(new DetectPeakError(t('The analysis stopped')));
			pending.clear();
		};
	} catch {
		worker = null;
	}
	return worker;
}

/** Measures samples (in the worker; synchronously when there is none, e.g. tests). */
export async function analyzeSamples(channels: Float32Array[], sampleRate: number): Promise<Analysis> {
	const w = getWorker();
	if (!w) {
		const { analyzeSound } = await import('@jasper/audio-fx');
		return analyzeSound(channels, sampleRate);
	}
	const id = nextId++;
	return new Promise<Analysis>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		w.postMessage(
			{ id, channels, sampleRate } satisfies AnalyzeRequest,
			channels.map((c) => c.buffer as ArrayBuffer),
		);
	});
}

export type DetectDeps = {
	decode(
		url: string,
		streamIndex: number,
		c0: number,
		c1: number,
		map?: MediaTimeMap,
	): Promise<{ rate: number; data: Float32Array[] } | null>;
	analyze(channels: Float32Array[], sampleRate: number): Promise<Analysis>;
};

const defaultDeps: DetectDeps = { decode: decodeMediaRange, analyze: analyzeSamples };

/**
 * The peak of an audio clip's sound as content flicks from the media start (within the part the clip uses, up to
 * `DETECT_MAX_SEC`). Throws `DetectPeakError` with a message for the user.
 */
export async function detectClipPeak(
	session: EditorSession,
	clip: AudioClip,
	sequenceRate: Rational,
	deps: DetectDeps = defaultDeps,
): Promise<{ peakFlicks: number; truncated: boolean }> {
	const s = session.getState();
	const asset = s.document.media[clip.mediaId] as MediaAsset | undefined;
	if (!asset) throw new DetectPeakError(t('The clip has no media'));
	if (clip.speed.reverse) throw new DetectPeakError(t('A reversed clip has no peak to detect'));
	const h = resolveMediaHandle(asset, s.media[asset.id]);
	if (!h) throw new DetectPeakError(t('The media is offline'));
	const F = FLICKS_PER_SECOND;
	const rate = clip.speed.rate > 0 ? clip.speed.rate : 1;
	const frameFlicks = flicksPerFrame(sequenceRate);
	const c0 = Math.max(0, clip.sourceIn);
	const span = clip.duration * frameFlicks * rate;
	const truncated = span > DETECT_MAX_SEC * F;
	const c1 = c0 + Math.min(span, DETECT_MAX_SEC * F);
	if (!(c1 > c0)) throw new DetectPeakError(t('The clip is empty'));
	const url = h.proxyUrl && h.browserDecodable === false ? h.proxyUrl : h.url;
	let dec: Awaited<ReturnType<DetectDeps['decode']>>;
	try {
		dec = await deps.decode(url, clip.channels.streamIndex, c0, c1, mediaTimeMap(asset) ?? undefined);
	} catch (e) {
		throw new DetectPeakError(
			t('The audio could not be decoded: {0}', e instanceof Error ? e.message : String(e)),
		);
	}
	if (!dec?.data.length || !dec.data.some((c) => c.length > 0))
		throw new DetectPeakError(t('This browser cannot decode the clip’s audio'));
	const a = await deps.analyze(dec.data, dec.rate);
	if (!Number.isFinite(a.peakSec)) throw new DetectPeakError(t('No peak found (the clip is silent)'));
	return { peakFlicks: Math.round(c0 + a.peakSec * F), truncated };
}
