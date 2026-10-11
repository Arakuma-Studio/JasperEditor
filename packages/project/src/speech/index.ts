// Speech-to-text results in the model (wp speech, docs/wp-notes/speech.md). Pure.
//
// - `distributeSequenceWords`: a transcript of a sequence's MIX (words in sequence time) becomes media transcripts:
//   each word goes to the clip it is heard through — audio tracks top first, the first enabled, non-reversed audio
//   clip whose range covers the word's midpoint (the same rule as sequenceWords, so the
//   derived sequence transcript reads the words back where they were spoken) — and is mapped into that clip's media
//   time through its speed. Each media also gets the media ranges its clips play (`coverage`).
// - `mergeTranscriptWords`: words of a partial transcript replace an existing transcript's words inside its
//   coverage only (re-transcribing a sequence keeps the words of media parts it does not play).
import { tickOf } from '../captions/formats/rate.ts';
import { mergeRanges } from '../captions/sequence-transcript.ts';
import { normalizeWords } from '../captions/words.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Transcript, TranscriptWord } from '../schema/media.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';

/** A recognised word (flicks). */
export type RecognizedWord = {
	text: string;
	start: number;
	end: number;
	confidence?: number | null;
	speaker?: string | null;
};

export type MediaWords = {
	mediaId: string;
	words: TranscriptWord[];
	/** Media ranges (flicks) the sequence plays from this media, merged. */
	coverage: Array<[number, number]>;
};

type AudioClip = Clip & { kind: 'audio'; mediaId: string };

/** Splits sequence-time words (a mix transcript) into media transcripts of the clips they are heard through. */
export function distributeSequenceWords(
	doc: Pick<ProjectDocument, 'sequences' | 'media'>,
	sequenceId: string,
	words: readonly RecognizedWord[],
	range?: { start: number; end: number },
): { media: MediaWords[]; unassigned: number } {
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	if (!seq) return { media: [], unassigned: words.length };
	const rate = seq.settings.frameRate;
	const F = tickOf(1, rate);
	const lanes: AudioClip[][] = seq.audioTracks.map((t) =>
		(Object.values(seq.clips) as Clip[])
			.filter(
				(c): c is AudioClip =>
					c.trackId === t.id &&
					c.kind === 'audio' &&
					c.enabled &&
					!c.speed.reverse &&
					c.speed.rate > 0 &&
					typeof (c as { mediaId?: unknown }).mediaId === 'string' &&
					!!doc.media[(c as { mediaId: string }).mediaId],
			)
			.sort((a, b) => a.start - b.start),
	);
	const byMedia = new Map<string, { words: TranscriptWord[]; coverage: Array<[number, number]> }>();
	const entry = (id: string) => {
		let e = byMedia.get(id);
		if (!e) {
			e = { words: [], coverage: [] };
			byMedia.set(id, e);
		}
		return e;
	};
	// coverage: the media ranges of the clips heard inside the transcribed range
	const rs = range ? tickOf(range.start, rate) : Number.NEGATIVE_INFINITY;
	const re = range ? tickOf(range.end, rate) : Number.POSITIVE_INFINITY;
	for (const lane of lanes)
		for (const c of lane) {
			const a = Math.max(tickOf(c.start, rate), rs);
			const b = Math.min(tickOf(c.start + c.duration, rate), re);
			if (b <= a) continue;
			const toMedia = (t: number) => c.sourceIn + Math.round((t - tickOf(c.start, rate)) * c.speed.rate);
			entry(c.mediaId).coverage.push([Math.max(0, toMedia(a)), Math.max(0, toMedia(b))]);
		}
	let unassigned = 0;
	for (const w of words) {
		const mid = w.start + Math.floor((Math.max(w.end, w.start) - w.start) / 2);
		let hit: AudioClip | null = null;
		for (const lane of lanes) {
			hit =
				lane.find((c) => mid >= tickOf(c.start, rate) && mid < tickOf(c.start + c.duration, rate)) ?? null;
			if (hit) break;
		}
		if (!hit) {
			unassigned++;
			continue;
		}
		const c0 = tickOf(hit.start, rate);
		const k = hit.speed.rate;
		const toMedia = (t: number) => hit.sourceIn + Math.round((t - c0) * k);
		const mediaEnd = hit.sourceIn + Math.round(hit.duration * F * k);
		const start = Math.max(hit.sourceIn, toMedia(w.start));
		const end = Math.min(mediaEnd, Math.max(start, toMedia(w.end)));
		entry(hit.mediaId).words.push({
			text: w.text,
			start,
			end,
			confidence: typeof w.confidence === 'number' ? w.confidence : null,
			speaker: w.speaker ?? null,
			breakBefore: 'none',
		});
	}
	const media: MediaWords[] = [];
	for (const [mediaId, e] of byMedia)
		media.push({
			mediaId,
			words: normalizeWords(e.words),
			coverage: mergeRanges(e.coverage.map(([a, b]): [number, number] => [Math.min(a, b), Math.max(a, b)])),
		});
	return { media, unassigned };
}

/** Whether `t` lies in one of the (sorted, disjoint) ranges. */
function inRanges(ranges: ReadonlyArray<readonly [number, number]>, t: number): boolean {
	let lo = 0;
	let hi = ranges.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ranges[mid]![1] <= t) lo = mid + 1;
		else hi = mid;
	}
	return lo < ranges.length && ranges[lo]![0] <= t;
}

/**
 * The words of `existing` outside `coverage` plus `incoming` (which lies inside it), and the union coverage
 * (undefined when `existing` covered the whole media).
 */
export function mergeTranscriptWords(
	existing: Pick<Transcript, 'words' | 'coverage'>,
	incoming: readonly TranscriptWord[],
	coverage: ReadonlyArray<readonly [number, number]>,
): { words: TranscriptWord[]; coverage: Array<[number, number]> | undefined } {
	const kept = existing.words.filter((w) => !inRanges(coverage, w.start + Math.floor((w.end - w.start) / 2)));
	const words = normalizeWords([...kept, ...incoming]);
	const union = existing.coverage
		? mergeRanges([...existing.coverage, ...coverage].map(([a, b]): [number, number] => [a, b]))
		: undefined;
	return { words, coverage: union };
}

/** `en` when translating, else the recognised language. */
export function transcriptLanguage(language: string, task: 'transcribe' | 'translate' | undefined): string {
	return task === 'translate' ? 'en' : language;
}

/** A finished recognition (the engine's `TranscriptionResult`, structurally). Times are flicks. */
export type RecognitionResult = {
	target:
		| { type: 'media'; mediaKey?: string }
		| {
				type: 'sequence';
				sequenceId: string;
				range: { startFrame: number; endFrame: number };
				mixHash: string;
		  };
	model: string;
	language: string;
	task: 'transcribe' | 'translate';
	words: readonly RecognizedWord[];
	speakers: Record<string, { name: string }>;
};

export type AttachPlan =
	| {
			commands: Array<Record<string, unknown> & { type: 'transcript.attach'; mediaId: string }>;
			/** Words attached, per media. */
			media: Array<{ mediaId: string; words: number }>;
			/** Mix words heard through no audio clip (dropped). */
			unassigned: number;
	  }
	| { error: string };

/**
 * The `transcript.attach` commands for a finished recognition: a media result attaches to `mediaId`; a sequence-mix
 * result is distributed to the clip media (`distributeSequenceWords`) — refused when the sequence's mix changed since
 * it was rendered (`mixHash`, from `mixFingerprint`). Media that already have a transcript are replaced (media
 * result) or merged inside the mix coverage (mix result), or skipped when `replace` is false.
 */
export function transcriptAttachPlan(
	doc: Pick<ProjectDocument, 'sequences' | 'media' | 'transcripts'>,
	res: RecognitionResult,
	opts: { mediaId?: string; replace: boolean; currentMixHash?: string },
): AttachPlan {
	const meta = {
		language: transcriptLanguage(res.language, res.task),
		origin: 'whisper-local',
		model: res.model,
		...(res.task === 'translate' ? { task: 'translate', sourceLanguage: res.language } : {}),
	};
	if (res.target.type === 'media') {
		const mediaId = opts.mediaId;
		if (!mediaId || !doc.media[mediaId]) return { error: 'The media is no longer in the project' };
		return {
			commands: [
				{
					type: 'transcript.attach',
					mediaId,
					...meta,
					words: res.words.map((w) => ({ ...w })),
					speakers: res.speakers,
					mode: opts.replace ? 'replace' : 'keep',
				},
			],
			media: [{ mediaId, words: res.words.length }],
			unassigned: 0,
		};
	}
	const seq = doc.sequences[res.target.sequenceId];
	if (!seq) return { error: 'The sequence is no longer in the project' };
	if (opts.currentMixHash !== undefined && opts.currentMixHash !== res.target.mixHash)
		return { error: 'The sequence changed while its mix was being transcribed; transcribe it again' };
	const r = distributeSequenceWords(doc, seq.id, res.words, {
		start: res.target.range.startFrame,
		end: res.target.range.endFrame,
	});
	const commands: Array<Record<string, unknown> & { type: 'transcript.attach'; mediaId: string }> = [];
	const media: Array<{ mediaId: string; words: number }> = [];
	for (const m of r.media) {
		const existing = Object.values(doc.transcripts).some((t) => t.mediaId === m.mediaId);
		if (existing && !opts.replace) continue;
		commands.push({
			type: 'transcript.attach',
			mediaId: m.mediaId,
			...meta,
			words: m.words,
			speakers: res.speakers,
			coverage: m.coverage,
			mode: existing ? 'merge' : 'replace',
		});
		media.push({ mediaId: m.mediaId, words: m.words.length });
	}
	if (!commands.length) return { error: 'No clip media to attach the words to' };
	return { commands, media, unassigned: r.unassigned };
}
