// Spec 17 SC-071 "Replace all N": after the user corrects one misrecognised spelling, the other occurrences of the
// same recogniser spelling in the sequence's transcripts become `transcript.replaceWords` edits (plain data): same
// normalised words, the occurrence's own punctuation and sentence-start capital, the span split by characters, the
// edited spot and no-op occurrences left out, deterministic and bounded.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	findReplaceAll,
	findReplaceAllInSequence,
	type ProjectDocument,
	REPLACE_ALL_LIMITS,
	sequenceMediaTranscripts,
	type Transcript,
} from '../src/index.ts';

const S = 705_600_000;

/** A transcript whose words are 0.5 s long with 0.1 s gaps, starting at `t0` seconds. */
function transcript(id: string, mediaId: string | null, text: string, t0 = 0): Transcript {
	return {
		id,
		mediaId,
		language: 'es',
		origin: 'whisper-local',
		speakers: {},
		words: text.split(' ').map((w, i) => ({
			text: w,
			start: Math.round((t0 + i * 0.6) * S),
			end: Math.round((t0 + i * 0.6 + 0.5) * S),
			confidence: 0.8,
			speaker: null,
			breakBefore: 'none' as const,
		})),
	};
}

describe('findReplaceAll', () => {
	const a = transcript(
		'trs_a',
		'med_a',
		'Hoy probamos glimer box, la app. ¿Glimer box funciona? Sí, glimer box! Y glimmer box también.',
	);
	const b = transcript('trs_b', 'med_b', 'En glimer box hay niveles. Glimer box.');

	it('finds the same spelling elsewhere, keeping each spot’s punctuation and sentence-start capital', () => {
		// the user corrected the first occurrence (words 2–3 of trs_a) to "Glimmerbox,"
		const edited = a.words[2]!;
		const plan = findReplaceAll([a, b], {
			oldWords: ['glimer', 'box,'],
			newText: 'Glimmerbox,',
			exclude: { transcriptId: 'trs_a', start: edited.start, end: a.words[3]!.end },
		});
		expect(
			plan.occurrences.map((o) => [o.transcriptId, o.edit.expect, o.edit.words.map((w) => w.text)]),
		).toEqual([
			['trs_a', ['¿Glimer', 'box'], ['¿Glimmerbox']],
			['trs_a', ['glimer', 'box!'], ['Glimmerbox!']],
			['trs_b', ['glimer', 'box'], ['Glimmerbox']],
			['trs_b', ['Glimer', 'box.'], ['Glimmerbox.']],
		]);
		// "glimmer box" is another spelling; "funciona?" stays outside the span
		const first = plan.occurrences[0]!;
		expect(first.edit.start).toBe(a.words[first.fromWord]!.start);
		expect(first.edit.end).toBe(a.words[first.toWord]!.end);
		expect(first.edit.words[0]).toMatchObject({
			start: first.edit.start,
			end: first.edit.end,
			confidence: null,
		});
		expect(first.before).toBe('box, la app.');
		expect(first.after).toBe('funciona? Sí, glimer');
		expect(plan.commands).toEqual([
			{
				type: 'transcript.replaceWords',
				transcriptId: 'trs_a',
				edits: [plan.occurrences[0]!.edit, plan.occurrences[1]!.edit],
			},
			{
				type: 'transcript.replaceWords',
				transcriptId: 'trs_b',
				edits: [plan.occurrences[2]!.edit, plan.occurrences[3]!.edit],
			},
		]);
		expect(plan.truncated).toBe(0);
	});

	it('splits a span among several new words by character count, inside the span', () => {
		const t = transcript('trs_c', 'med_c', 'abrimos novaplei studio ahora');
		const plan = findReplaceAll([t], { oldWords: ['novaplei'], newText: 'NovaPlay Studio' });
		const e = plan.occurrences[0]!.edit;
		expect(e.words.map((w) => w.text)).toEqual(['NovaPlay', 'Studio']);
		expect(e.words[0]!.start).toBe(e.start);
		expect(e.words[1]!.end).toBe(e.end);
		expect(e.words[0]!.end).toBeLessThanOrEqual(e.words[1]!.start);
		// 8 of 14 characters
		expect(e.words[0]!.end - e.start).toBe(Math.round(((e.end - e.start) * 8) / 14));
	});

	it('leaves out occurrences that would not change and refuses empty or oversized queries', () => {
		const t = transcript('trs_d', 'med_d', 'pixelforge Pixelforge pixelforge.');
		// a casing fix: only the lower-case ones change; the capitalised one already reads right
		const plan = findReplaceAll([t], { oldWords: ['pixelforge'], newText: 'Pixelforge' });
		expect(plan.occurrences.map((o) => o.edit.expect[0])).toEqual(['pixelforge', 'pixelforge.']);
		expect(plan.occurrences.map((o) => o.edit.words[0]!.text)).toEqual(['Pixelforge', 'Pixelforge.']);
		expect(findReplaceAll([t], { oldWords: ['pixelforge'], newText: '  ,  ' }).occurrences).toEqual([]);
		expect(findReplaceAll([t], { oldWords: [','], newText: 'x' }).occurrences).toEqual([]);
		expect(findReplaceAll([t], { oldWords: [], newText: 'x' }).occurrences).toEqual([]);
		const long = Array.from({ length: REPLACE_ALL_LIMITS.maxQueryWords + 1 }, () => 'pixelforge');
		expect(findReplaceAll([t], { oldWords: long, newText: 'x' }).occurrences).toEqual([]);
	});

	it('does not overlap matches and stops at the occurrence cap', () => {
		const t = transcript('trs_e', 'med_e', 'la la la');
		expect(
			findReplaceAll([t], { oldWords: ['la', 'la'], newText: 'lala' }).occurrences.map((o) => o.fromWord),
		).toEqual([0]);
		const many = transcript(
			'trs_f',
			'med_f',
			Array.from({ length: REPLACE_ALL_LIMITS.maxOccurrences + 7 }, () => 'glimer').join(' '),
		);
		const plan = findReplaceAll([many], { oldWords: ['glimer'], newText: 'Glimmer' });
		expect(plan.occurrences).toHaveLength(REPLACE_ALL_LIMITS.maxOccurrences);
		expect(plan.truncated).toBe(7);
	});

	it('property: edits are sorted, disjoint, inside their spans and expect the transcript words', () => {
		const vocab = ['glimer', 'box', 'Glimer', 'box,', '¿glimer', 'la', 'app.', '…'];
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom(...vocab), { minLength: 1, maxLength: 60 }),
				fc.array(fc.constantFrom('glimer', 'box', 'la'), { minLength: 1, maxLength: 3 }),
				fc.constantFrom('Glimmerbox', 'Glimmer Box', 'la', '¡Nova Play!'),
				(words, oldWords, newText) => {
					const t = transcript('trs_p', 'med_p', words.join(' '));
					const plan = findReplaceAll([t], { oldWords, newText });
					let prevEnd = -1;
					for (const o of plan.occurrences) {
						const e = o.edit;
						expect(e.start).toBeGreaterThanOrEqual(prevEnd);
						prevEnd = e.end;
						expect(e.expect).toEqual(t.words.slice(o.fromWord, o.toWord + 1).map((w) => w.text));
						let last = e.start;
						for (const w of e.words) {
							expect(w.start).toBeGreaterThanOrEqual(last);
							expect(w.end).toBeGreaterThan(w.start);
							expect(w.end).toBeLessThanOrEqual(e.end);
							last = w.end;
						}
						expect(e.words.map((w) => w.text)).not.toEqual(e.expect);
					}
					expect(findReplaceAll([t], { oldWords, newText })).toEqual(plan);
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe('findReplaceAllInSequence', () => {
	it('searches the transcripts of the sequence’s audio clips, once each, in track order', () => {
		const ta = transcript('trs_a', 'med_a', 'glimer');
		const tb = transcript('trs_b', 'med_b', 'glimer');
		const tOld = transcript('trs_old', 'med_b', 'glimer');
		const tOther = transcript('trs_x', 'med_x', 'glimer');
		const clip = (id: string, trackId: string, mediaId: string, start: number) => ({
			id,
			kind: 'audio',
			trackId,
			mediaId,
			start,
		});
		const doc = {
			// the newest transcript of a media is the one used (trs_b over trs_old)
			transcripts: { trs_old: tOld, trs_a: ta, trs_b: tb, trs_x: tOther },
			sequences: {
				seq_1: {
					audioTracks: [{ id: 'A1' }, { id: 'A2' }],
					clips: {
						c3: clip('c3', 'A2', 'med_a', 0),
						c1: clip('c1', 'A1', 'med_b', 50),
						c2: clip('c2', 'A1', 'med_b', 10),
						v1: { id: 'v1', kind: 'video', trackId: 'V1', mediaId: 'med_x', start: 0 },
					},
				},
			},
		} as unknown as ProjectDocument;
		expect(sequenceMediaTranscripts(doc, 'seq_1').map((t) => t.id)).toEqual(['trs_b', 'trs_a']);
		expect(sequenceMediaTranscripts(doc, 'seq_nope')).toEqual([]);
		const plan = findReplaceAllInSequence(doc, 'seq_1', { oldWords: ['glimer'], newText: 'Glimmer' });
		expect(plan.commands.map((c) => c.transcriptId)).toEqual(['trs_b', 'trs_a']);
	});
});
