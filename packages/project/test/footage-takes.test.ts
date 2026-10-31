// Spec 18 AF-TAK-001: takes of the same line across files (docs/wp-notes/agent-footage-digest.md).
import { describe, expect, it } from 'vitest';
import {
	findTakes,
	normaliseTakeTokens,
	type ProjectDocument,
	TAKES_MAX_PHRASES,
	type Transcript,
	takeSimilarity,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const S = 705_600_000;

/** Words of a line said from `at` seconds, 0.3 s per word, 0.1 s apart (one phrase). */
function say(line: string, at: number, conf = 0.9) {
	return line.split(' ').map((text, k) => ({
		text,
		start: Math.round((at + k * 0.4) * S),
		end: Math.round((at + k * 0.4 + 0.3) * S),
		confidence: conf,
		speaker: null,
		breakBefore: 'none' as const,
	}));
}

function tr(id: string, mediaId: string, words: Transcript['words'], language = 'en'): Transcript {
	return { id, mediaId, language, origin: 'whisper-local', words, speakers: {} };
}

function setup(lines: Record<string, Array<[string, number] | [string, number, number]>>, language = 'en') {
	const h = new Harness();
	const ids: Record<string, string> = {};
	for (const key of Object.keys(lines)) ids[key] = h.registerVideo({ seconds: 600 });
	const transcripts: Record<string, Transcript> = {};
	for (const [key, ls] of Object.entries(lines))
		transcripts[`t_${key}`] = tr(
			`t_${key}`,
			ids[key]!,
			ls.flatMap(([line, at, conf]) => say(line, at, conf)),
			language,
		);
	const doc: ProjectDocument = { ...h.doc, transcripts };
	return { doc, ids };
}

describe('take normalisation and similarity', () => {
	it('drops case, punctuation and the cleanup fillers of the language', () => {
		expect(normaliseTakeTokens(['Um,', 'The', 'BEST', 'uh', 'part!'], 'en')).toEqual(['the', 'best', 'part']);
		expect(normaliseTakeTokens(['Eh', 'vamos', 'a', 'jugar.'], 'es')).toEqual(['vamos', 'a', 'jugar']);
	});

	it('is an LCS ratio over word tokens, symmetric', () => {
		const a = ['this', 'is', 'the', 'best', 'part'];
		const b = ['this', 'is', 'really', 'the', 'best', 'part'];
		expect(takeSimilarity(a, b)).toBeCloseTo((2 * 5) / 11, 10);
		expect(takeSimilarity(b, a)).toBe(takeSimilarity(a, b));
		expect(takeSimilarity([], b)).toBe(0);
	});
});

describe('findTakes', () => {
	it('groups takes of the same line across files and suggests the last complete one', () => {
		const { doc, ids } = setup({
			a: [
				['Welcome to the show everybody.', 1],
				['Something unrelated about cooking pasta.', 10],
			],
			b: [
				['Um welcome to the show.', 2],
				['Welcome to the the show everybody', 20],
			],
		});
		const r = findTakes(doc, {});
		if (!r.ok) throw new Error(r.message);
		expect(r.groups).toHaveLength(1);
		const g = r.groups[0]!;
		expect(g.members.map((m) => [m.mediaId, m.start])).toEqual([
			[ids.a, 1 * S],
			[ids.b, 2 * S],
			[ids.b, 20 * S],
		]);
		expect(g.members.map((m) => m.complete)).toEqual([true, true, false]);
		// the last complete take (the third has a stutter and no sentence end)
		expect(g.suggested).toBe(1);
		expect(g.members[0]).toMatchObject({ text: 'Welcome to the show everybody.', meanConfidence: 0.9 });
		expect(g.members[0]!.end).toBe(Math.round((1 + 4 * 0.4 + 0.3) * S));
	});

	it('marks a take with a restart as incomplete; falls back to the last take when none is complete', () => {
		const { doc } = setup({
			a: [
				['we went to the we went to the market', 1],
				['we went to the market', 10],
			],
		});
		const r = findTakes(doc, {});
		if (!r.ok) throw new Error(r.message);
		expect(r.groups).toHaveLength(1);
		expect(r.groups[0]!.members.map((m) => m.complete)).toEqual([false, false]);
		expect(r.groups[0]!.suggested).toBe(1);
	});

	it('honours minSimilarity and mediaIds; single-word phrases are not takes', () => {
		const { doc, ids } = setup({
			a: [
				['the quick brown fox jumps', 1],
				['Yes.', 5],
			],
			b: [
				['the slow brown fox sleeps', 1],
				['Yes.', 5],
			],
			c: [['the quick brown fox jumps', 1]],
		});
		const strict = findTakes(doc, { minSimilarity: 0.9 });
		if (!strict.ok) throw new Error(strict.message);
		expect(strict.groups.map((g) => g.members.map((m) => m.mediaId))).toEqual([[ids.a, ids.c]]);
		const loose = findTakes(doc, { minSimilarity: 0.6 });
		if (!loose.ok) throw new Error(loose.message);
		expect(loose.groups.map((g) => g.members.map((m) => m.mediaId))).toEqual([[ids.a, ids.b, ids.c]]);
		const narrowed = findTakes(doc, { mediaIds: [ids.b, ids.a], minSimilarity: 0.9 });
		if (!narrowed.ok) throw new Error(narrowed.message);
		expect(narrowed.groups).toEqual([]);
		expect(findTakes(doc, { mediaIds: ['med_nope'] })).toMatchObject({ ok: false, code: 'E_NOT_FOUND' });
	});

	it(`refuses more than ${TAKES_MAX_PHRASES} phrases with E_TOO_LARGE naming the media`, () => {
		const h = new Harness();
		const id = h.registerVideo({ seconds: 20_000 });
		const words = Array.from({ length: TAKES_MAX_PHRASES + 1 }, (_, k) =>
			say(`line number ${k}`, k * 2),
		).flat();
		const doc = { ...h.doc, transcripts: { t: tr('t', id, words) } };
		const r = findTakes(doc, {});
		expect(r).toMatchObject({ ok: false, code: 'E_TOO_LARGE' });
		if (r.ok) return;
		expect(r.message).toContain('mediaIds');
		expect(r.details).toEqual({
			phrases: TAKES_MAX_PHRASES + 1,
			media: [{ mediaId: id, phrases: TAKES_MAX_PHRASES + 1 }],
		});
	});
});
