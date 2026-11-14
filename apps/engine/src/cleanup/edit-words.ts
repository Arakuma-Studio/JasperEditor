// Chunked words for the repeats-in-the-edit check (docs/wp-notes/transcript-cleanup.md "Repeats at cuts"):
//   - spans: every kept span of the dialogue track, padded `EDIT_SPAN_PAD_S`, is laid on a synthetic sequence with
//     `EDIT_GAP_S` of silence between spans (a silence of 2 s always ends a VAD chunk, so each span is decoded on its
//     own) and transcribed as one `chunking: "vad"` sequence-mix job of the speech service — one job, one model load,
//     for every span not in the cache. The words are mapped back to media time per span and cached per media range
//     (`<cache>/<fingerprint>/span-words-<hash>.json`, a `media-cache` entry), so a later run decodes only new spans.
//   - mix (the closed loop): the sequence's own mixdown, transcribed with `chunking: "vad"`; words in sequence time.
// Cost: the decoded audio is the kept audio plus 0.4 s per span (silence between spans is skipped by the VAD chunker);
// VAD chunking decodes about twice (docs/wp-notes/speech.md §11.3). Requests above `EDIT_MAX_SPANS` spans or
// `EDIT_MAX_SECONDS` of padded audio are refused rather than queued.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type EngineJob,
	type TranscribeSequenceRequest,
	TranscriptionResultSchema,
	type TranscriptResultWord,
} from '@jasper/api';
import {
	EDIT_SPAN_PAD_S,
	type EditSpan,
	type EditWord,
	editSpanRequest,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	makeEnvelope,
	type ProjectDocument,
	type Rational,
	type Sequence,
} from '@jasper/project';
import { z } from 'zod';
import { type JobContext, JobError } from '../jobs/types.ts';
import { fingerprintHex } from '../media/fingerprint.ts';
import { atomicWriteFile } from '../tools/fs.ts';

/** Silence between two spans on the synthetic sequence (more than the VAD chunker's 2 s chunk-ending silence). */
export const EDIT_GAP_S = 2.5;
/** At most this many spans in one request… */
export const EDIT_MAX_SPANS = 5000;
/** …and this much padded audio (seconds, 4 h). */
export const EDIT_MAX_SECONDS = 4 * 3600;
/** Version of the cached span words (bump when what is cached changes). */
const SPAN_WORDS_VERSION = 1;

/** Runs a sequence-mix transcription and returns its words (sequence flicks); the seam tests replace. */
export type SequenceTranscriber = (
	req: TranscribeSequenceRequest,
	ctx: JobContext,
) => Promise<{ words: TranscriptResultWord[]; jobId: string | null }>;

export type EditWordsReport = {
	spans: number;
	cached: number;
	transcribed: number;
	jobId: string | null;
};

const CachedSchema = z.object({
	version: z.literal(SPAN_WORDS_VERSION),
	words: z
		.array(
			z.object({
				text: z.string().max(200),
				start: z.number().int().min(0),
				end: z.number().int().min(0),
				confidence: z.number().min(0).max(1).nullable(),
			}),
		)
		.max(100_000),
});

/** The speech service's sequence transcription, waited for (cancelling the caller cancels it). */
export function speechTranscriber(
	submit: (req: TranscribeSequenceRequest, origin: EngineJob['origin']) => Promise<EngineJob>,
	queue: { wait(id: string): Promise<EngineJob>; cancel(id: string): unknown },
): SequenceTranscriber {
	return async (req, ctx) => {
		const job = await submit(req, ctx.job.origin);
		const onAbort = () => queue.cancel(job.id);
		ctx.signal.addEventListener('abort', onAbort, { once: true });
		let fin: EngineJob;
		try {
			fin = await queue.wait(job.id);
		} finally {
			ctx.signal.removeEventListener('abort', onAbort);
		}
		ctx.signal.throwIfAborted();
		if (fin.state !== 'succeeded')
			throw new JobError(
				fin.error?.code ?? 'TRANSCRIPTION_FAILED',
				`transcription ${fin.state}: ${fin.error?.message ?? ''}`.trim(),
				fin.error?.retryable ?? false,
			);
		const res = TranscriptionResultSchema.safeParse(fin.result);
		if (!res.success) throw new JobError('INVALID_RESPONSE', 'The transcription result is unreadable', false);
		return { words: res.data.words, jobId: job.id };
	};
}

export class EditWordsService {
	constructor(
		private readonly cacheDir: string,
		private readonly transcribe: SequenceTranscriber,
	) {}

	private cachePath(doc: ProjectDocument, r: ReturnType<typeof editSpanRequest>, key: string): string | null {
		const fp = (doc.media[r.mediaId] as { fingerprint?: unknown } | undefined)?.fingerprint;
		if (typeof fp !== 'string') return null;
		let hex: string;
		try {
			hex = fingerprintHex(fp);
		} catch {
			return null;
		}
		const hash = createHash('sha256')
			.update(JSON.stringify({ kind: 'span-words', v: SPAN_WORDS_VERSION, ...r, mediaId: undefined, key }))
			.digest('hex')
			.slice(0, 12);
		return join(this.cacheDir, hex, `span-words-${hash}.json`);
	}

	private async readCache(path: string | null): Promise<EditWord[] | null> {
		if (!path) return null;
		try {
			const r = CachedSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
			return r.success ? r.data.words : null;
		} catch {
			return null;
		}
	}

	/**
	 * Chunked words of every span (media flicks, keyed by `spanKey`): from the cache, the rest from one transcription
	 * of a synthetic sequence holding the padded spans. `options` (model, language) are part of the cache key.
	 */
	async spanWords(
		doc: ProjectDocument,
		seq: Sequence,
		spans: readonly EditSpan[],
		options: { model?: string; language?: string; projectId?: string },
		ctx: JobContext,
		pads: readonly number[] = [EDIT_SPAN_PAD_S],
	): Promise<{ words: Array<Map<string, EditWord[]>>; report: EditWordsReport }> {
		const key = JSON.stringify({
			model: options.model ?? null,
			language: options.language ?? null,
			chunking: 'vad',
		});
		// one decode per padding (the second confirms the first: other context, other chunk boundaries), all in one job
		const out = pads.map(() => new Map<string, EditWord[]>());
		const todo: Array<{
			span: EditSpan;
			pad: number;
			r: ReturnType<typeof editSpanRequest>;
			path: string | null;
		}> = [];
		const seen = new Set<string>();
		let cached = 0;
		for (const span of spans) {
			const k = spanKey(span);
			if (seen.has(k)) continue;
			seen.add(k);
			let hits = 0;
			for (const [pad, padS] of pads.entries()) {
				const r = clampRequest(doc, editSpanRequest(span, padS));
				const path = this.cachePath(doc, r, key);
				const hit = await this.readCache(path);
				if (hit) {
					out[pad]!.set(k, hit);
					hits++;
				} else todo.push({ span, pad, r, path });
			}
			if (hits === pads.length) cached++;
		}
		const report: EditWordsReport = {
			spans: seen.size,
			cached,
			transcribed: seen.size - cached,
			jobId: null,
		};
		if (!todo.length) return { words: out, report };
		if (todo.length > EDIT_MAX_SPANS)
			throw new JobError(
				'EDIT_CHECK_TOO_LARGE',
				`${todo.length} span decodes to transcribe (at most ${EDIT_MAX_SPANS})`,
				false,
			);
		const secs = todo.reduce((s, t) => s + (t.r.end - t.r.start) / FLICKS_PER_SECOND, 0);
		if (secs > EDIT_MAX_SECONDS)
			throw new JobError(
				'EDIT_CHECK_TOO_LARGE',
				`${Math.round(secs)} s of kept audio to transcribe (at most ${EDIT_MAX_SECONDS} s)`,
				false,
			);
		const { envelope, sequenceId, slots } = spanSequence(doc, seq, todo);
		const res = await this.transcribe(
			{
				envelope: envelope as unknown as TranscribeSequenceRequest['envelope'],
				sequenceId,
				chunking: 'vad',
				...(options.model ? { model: options.model } : {}),
				...(options.language ? { language: options.language } : {}),
				...(options.projectId ? { projectId: options.projectId } : {}),
			},
			ctx,
		);
		report.jobId = res.jobId;
		// words → the slot they lie in → media time
		const per = slots.map(() => [] as EditWord[]);
		for (const w of res.words) {
			const mid = (w.start + w.end) / 2;
			const i = slots.findIndex((s) => mid >= s.seqStart && mid < s.seqEnd);
			if (i < 0) continue;
			const s = slots[i]!;
			const at = s.mediaStart - s.seqStart;
			per[i]!.push({
				text: w.text,
				start: Math.max(0, w.start + at),
				end: Math.max(0, w.end + at),
				confidence: w.confidence,
			});
		}
		for (const [i, t] of todo.entries()) {
			out[t.pad]!.set(spanKey(t.span), per[i]!);
			if (t.path)
				await atomicWriteFile(t.path, JSON.stringify({ version: SPAN_WORDS_VERSION, words: per[i] })).catch(
					() => undefined,
				);
		}
		return { words: out, report };
	}

	/** Chunked words of the sequence's own mixdown (sequence flicks): the closed loop. */
	async mixWords(
		doc: ProjectDocument,
		seq: Sequence,
		options: { model?: string; language?: string; projectId?: string },
		ctx: JobContext,
	): Promise<{ words: TranscriptResultWord[]; jobId: string | null }> {
		return this.transcribe(
			{
				envelope: envelopeOf(doc) as unknown as TranscribeSequenceRequest['envelope'],
				sequenceId: seq.id,
				chunking: 'vad',
				...(options.model ? { model: options.model } : {}),
				...(options.language ? { language: options.language } : {}),
				...(options.projectId ? { projectId: options.projectId } : {}),
			},
			ctx,
		);
	}
}

/** Ids of the synthetic sequence's track (ids are unique across the document). */
const SYNTH_TRACK = 'trk_EDTCHECK00000000';

const envelopeOf = (document: ProjectDocument) =>
	makeEnvelope(document, { revision: 0, savedAt: new Date(0).toISOString(), platform: 'engine' });

/** The key of a span's words (its media range). */
export const spanKey = (s: EditSpan) =>
	`${s.mediaId}\u0000${s.stream}\u0000${s.mediaStart}\u0000${s.mediaEnd}`;

/** A padded range never past the media's end. */
function clampRequest(
	doc: ProjectDocument,
	r: ReturnType<typeof editSpanRequest>,
): ReturnType<typeof editSpanRequest> {
	const d = Number((doc.media[r.mediaId]?.probe as { durationFlicks?: unknown } | undefined)?.durationFlicks);
	return Number.isFinite(d) && d > 0 ? { ...r, end: Math.max(r.start, Math.min(r.end, d)) } : r;
}

/**
 * The synthetic sequence: the span clips' copies on the dialogue track, each over its padded range, `EDIT_GAP_S` of
 * silence apart (whole frames); every other clip, track, link and transition left out. Slots in sequence flicks.
 */
function spanSequence(
	doc: ProjectDocument,
	seq: Sequence,
	todo: ReadonlyArray<{ span: EditSpan; r: ReturnType<typeof editSpanRequest> }>,
): {
	envelope: ReturnType<typeof envelopeOf>;
	sequenceId: string;
	slots: Array<{ seqStart: number; seqEnd: number; mediaStart: number }>;
} {
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const gap = Math.ceil((EDIT_GAP_S * FLICKS_PER_SECOND) / F);
	const trackId = seq.clips[todo[0]!.span.clipId]!.trackId;
	const track = seq.audioTracks.find((t) => t.id === trackId)!;
	const clips: Sequence['clips'] = {};
	const slots: Array<{ seqStart: number; seqEnd: number; mediaStart: number }> = [];
	let at = 0;
	todo.forEach(({ span, r }, i) => {
		const src = seq.clips[span.clipId]!;
		const frames = Math.max(1, Math.floor((r.end - r.start) / F));
		const id = `clp_EDTCHECK${String(i).padStart(8, '0')}`;
		const c = structuredClone(src) as Sequence['clips'][string] & { edgeFades?: unknown };
		delete c.edgeFades;
		Object.assign(c, {
			id,
			trackId: SYNTH_TRACK,
			start: at,
			duration: frames,
			sourceIn: r.start,
			linkId: null,
			groupId: null,
			markers: [],
		});
		clips[id] = c;
		slots.push({ seqStart: at * F, seqEnd: (at + frames) * F, mediaStart: r.start });
		at += frames + gap;
	});
	const sequenceId = 'seq_EDTCHECK00000000';
	const synth: Sequence = {
		...seq,
		id: sequenceId,
		videoTracks: [],
		audioTracks: [{ ...track, id: SYNTH_TRACK, mute: false, solo: false }],
		captionTracks: [],
		clips,
		transitions: {},
		links: {},
		groups: {},
		markers: [],
		inPoint: null,
		outPoint: null,
		workArea: null,
		captionGroups: {},
	};
	delete (synth as { cleanup?: unknown }).cleanup;
	const document = { ...doc, sequences: { ...doc.sequences, [sequenceId]: synth } } as ProjectDocument;
	return { envelope: envelopeOf(document), sequenceId, slots };
}
