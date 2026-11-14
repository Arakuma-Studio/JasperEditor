// Chunked transcription of the speech a sequence keeps (docs/wp-notes/speech.md "Kept spans"): media ranges — the
// spans a sequence's audio clips play — padded with a little audio either side for context, merged where the padding
// overlaps, and transcribed in ONE speech worker run (the media decoded once, the model loaded once), each range the
// `chunking: "vad"` way (VAD chunks decoded alone, twice with shifted boundaries, merged), best accuracy by default.
// The words come back per requested span, given to it by the sequence transcript's rule (midpoint, or a word whose
// start the span's start cuts off — `heardInSpans`) and clamped into it, so words heard only in the padding (a removed
// take next to the cut) are never returned.
//
// Engine-internal and reusable: Rebuild from script (`transcript-fix/rebuild.ts`) calls it; any job that needs what
// the kept speech really says (restarts across clip boundaries…) can call it with its job context.
import { FLICKS_PER_SECOND } from '@jasper/project';
import { type HeardWord, heardInSpans, REBUILD_DEFAULTS } from '@jasper/project/script-fix';
import { JobError } from '../jobs/types.ts';
import type { SpeechScoreOptions } from './service.ts';

/** One worker run over media ranges (`SpeechService.transcribeSpans`). Times are media flicks. */
export type SpanTranscriptionRequest = {
	/** The asset's engine-store key (not the project media id). */
	mediaKey: string;
	streamIndex?: number;
	/** Sorted, disjoint media ranges to transcribe (already padded). */
	ranges: Array<{ start: number; end: number }>;
	/** ISO 639-1 code; omitted = detected on the first range with voice. */
	language?: string;
	model?: string;
	/** Default `best` (beam 5). */
	accuracy?: 'standard' | 'best';
	device?: 'auto' | 'cpu' | 'gpu';
};

export type SpanTranscriptionResult = {
	model: string;
	language: string;
	/** Words heard inside the ranges (media flicks), sorted. */
	words: HeardWord[];
	device: { encoder: string; decoder: string; label: string; threads: number };
	timings: { decodeMs: number; loadMs: number; transcribeMs: number };
	chunked: { chunks: number; shiftedChunks: number; zones: number; replaced: number } | null;
};

/** The part of `SpeechService` this needs (tests fake it at this boundary). */
export type SpanTranscriber = {
	transcribeSpans(
		request: SpanTranscriptionRequest,
		signal: AbortSignal,
		opts?: SpeechScoreOptions,
	): Promise<SpanTranscriptionResult>;
};

export type KeptSpansRequest = Omit<SpanTranscriptionRequest, 'ranges'> & {
	/** The kept spans (media flicks, sorted, disjoint), e.g. `keptSpans` of `@jasper/project/script-fix`. */
	spans: ReadonlyArray<{ start: number; end: number }>;
	/** Context decoded around each span (seconds; default 0.2). */
	padSeconds?: number;
	/** The media's length (flicks), so padding never runs past it. */
	duration?: number;
};

export type KeptSpansResult = Omit<SpanTranscriptionResult, 'words'> & {
	/** The words of each requested span, in the same order (clamped into the span). */
	spans: Array<{ start: number; end: number; words: HeardWord[] }>;
	/** The padded, merged ranges that were decoded. */
	ranges: Array<{ start: number; end: number }>;
};

/** Most kept spans per run (the reference cut has 340). */
export const MAX_KEPT_SPANS = 20_000;

/** `spans` padded by `pad` flicks either side (within [0, duration]) and merged where they overlap or touch. */
export function paddedRanges(
	spans: ReadonlyArray<{ start: number; end: number }>,
	pad: number,
	duration = Number.POSITIVE_INFINITY,
): Array<{ start: number; end: number }> {
	const out: Array<{ start: number; end: number }> = [];
	const list = spans
		.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
		.map((s) => ({ start: Math.max(0, s.start - pad), end: Math.min(duration, s.end + pad) }))
		.filter((s) => s.end > s.start)
		.sort((a, b) => a.start - b.start);
	for (const s of list) {
		const last = out[out.length - 1];
		if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
		else out.push({ ...s });
	}
	return out;
}

/**
 * Transcribes the kept spans of one media in one worker run (padded by `padSeconds`, chunked by voice) and returns
 * each span's words. Failures are the worker's `JobError`s; an empty or oversized request is `INVALID_SPEC`.
 */
export async function transcribeKeptSpans(
	speech: SpanTranscriber,
	req: KeptSpansRequest,
	signal: AbortSignal,
	opts: SpeechScoreOptions = {},
): Promise<KeptSpansResult> {
	const spans = req.spans.filter(
		(s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
	);
	if (!spans.length) throw new JobError('INVALID_SPEC', 'No kept span to transcribe', false);
	if (spans.length > MAX_KEPT_SPANS)
		throw new JobError('INVALID_SPEC', `At most ${MAX_KEPT_SPANS} kept spans per run`, false);
	const pad = Math.max(0, req.padSeconds ?? REBUILD_DEFAULTS.padSeconds) * FLICKS_PER_SECOND;
	const ranges = paddedRanges(spans, Math.round(pad), req.duration);
	const { spans: _spans, padSeconds: _pad, duration: _dur, ...rest } = req;
	const r = await speech.transcribeSpans({ ...rest, ranges }, signal, opts);
	const per = heardInSpans(r.words, spans);
	const { words: _w, ...meta } = r;
	return {
		...meta,
		ranges,
		spans: spans.map((s, i) => ({ start: s.start, end: s.end, words: per[i]! })),
	};
}
