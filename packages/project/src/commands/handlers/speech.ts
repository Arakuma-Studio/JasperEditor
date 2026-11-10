// A media asset has one attached transcript shared by all its clips.
import { normalizeWords } from '../../captions/words.ts';
import type { Transcript } from '../../schema/media.ts';
import {
	mergeTranscriptSegments,
	mergeTranscriptWords,
	normalizeRedecodedRanges,
	normalizeTranscriptSegments,
	transcriptRedecoded,
	transcriptSegments,
} from '../../speech/index.ts';
import type { HandlerMap } from './util.ts';

export const SPEECH_OWNER = 'speech';

export const speechHandlers = {
	'transcript.attach': (doc, cmd, h) => {
		if (!doc.media[cmd.mediaId]) return h.fail('E_NOT_FOUND', `Media not found: ${cmd.mediaId}`);
		for (const w of cmd.words)
			if (w.end < w.start) h.fail('E_INVALID_PARAM', `Word "${w.text}" ends before it starts`);
		const coverage = cmd.coverage
			? cmd.coverage
					.map(([a, b]): [number, number] => [Math.min(a, b), Math.max(a, b)])
					.sort((a, b) => a[0] - b[0])
			: undefined;
		const speakers: Record<string, { name: string }> = { ...(cmd.speakers ?? {}) };
		for (const w of cmd.words)
			if (w.speaker && !speakers[w.speaker])
				speakers[w.speaker] = { name: `Speaker ${Object.keys(speakers).length + 1}` };
		const segments = cmd.segments ? normalizeTranscriptSegments(cmd.segments) : undefined;
		const redecoded = normalizeRedecodedRanges(cmd.redecoded);
		const words = normalizeWords(
			cmd.words.map((w) => ({
				text: w.text,
				start: w.start,
				end: w.end,
				confidence: w.confidence ?? null,
				speaker: w.speaker ?? null,
				breakBefore: 'none' as const,
			})),
		);
		// the media's current transcripts (the last one is the one in use, `transcriptForMedia`)
		const existing = (Object.values(doc.transcripts) as Transcript[]).filter(
			(t) => t.mediaId === cmd.mediaId,
		);
		const current = existing[existing.length - 1];
		const mode = cmd.mode ?? 'replace';
		if (current && mode === 'keep') {
			h.defineRef(cmd.ref, current.id);
			return { transcriptId: current.id, words: current.words.length, skipped: true };
		}
		const meta = {
			language: cmd.language,
			origin: cmd.origin ?? 'whisper-local',
			...(cmd.model ? { model: cmd.model } : {}),
			...(cmd.task ? { task: cmd.task } : {}),
			...(cmd.sourceLanguage ? { sourceLanguage: cmd.sourceLanguage } : {}),
			createdAt: h.ctx.now(),
		};
		// hidden takes: the ranges are bound to this recognition (`transcriptRedecoded`)
		const markOf = (ranges: Array<[number, number]>) =>
			ranges.length ? { createdAt: meta.createdAt, ranges } : undefined;
		if (current) {
			const t = doc.transcripts[current.id] as Transcript;
			if (mode === 'merge' && coverage) {
				const merged = mergeTranscriptWords(current, words, coverage);
				t.words = merged.words;
				if (merged.coverage) t.coverage = merged.coverage;
				else delete t.coverage;
				t.speakers = { ...current.speakers, ...speakers };
				const segs = mergeTranscriptSegments(transcriptSegments(current), segments ?? [], coverage);
				if (segs.length) t.segments = segs;
				else delete t.segments;
				// re-decoded ranges outside the coverage stay; inside it the new transcription's count
				const inCoverage = (r: readonly [number, number]) =>
					coverage.some(([a, b]) => (r[0] + r[1]) / 2 >= a && (r[0] + r[1]) / 2 < b);
				const red = markOf(
					normalizeRedecodedRanges([
						...transcriptRedecoded(current).filter((r) => !inCoverage(r)),
						...redecoded,
					]),
				);
				if (red) t.redecoded = red;
				else delete t.redecoded;
			} else {
				t.words = words;
				t.speakers = speakers;
				if (coverage) t.coverage = coverage;
				else delete t.coverage;
				if (segments?.length) t.segments = segments;
				else delete t.segments;
				const red = markOf(redecoded);
				if (red) t.redecoded = red;
				else delete t.redecoded;
			}
			Object.assign(t, meta);
			if (!cmd.task) delete t.task;
			if (!cmd.sourceLanguage) delete t.sourceLanguage;
			if (!cmd.model) delete t.model;
			// older duplicates of the media's transcript would shadow nothing but confuse readers: drop them
			for (const old of existing.slice(0, -1)) {
				const used = Object.values(doc.sequences).some((s) =>
					Object.values(s.clips).some((c) => (c as { transcriptId?: string }).transcriptId === old.id),
				);
				if (!used) delete doc.transcripts[old.id];
			}
			h.defineRef(cmd.ref, current.id);
			return { transcriptId: current.id, words: t.words.length, replaced: true };
		}
		const id = h.ids.next('trs');
		doc.transcripts[id] = {
			id,
			mediaId: cmd.mediaId,
			words,
			speakers,
			...meta,
			...(coverage ? { coverage } : {}),
			...(segments?.length ? { segments } : {}),
			...(redecoded.length ? { redecoded: markOf(redecoded) } : {}),
		} as Transcript;
		h.defineRef(cmd.ref, id);
		return { transcriptId: id, words: words.length, replaced: false };
	},
} satisfies HandlerMap;
