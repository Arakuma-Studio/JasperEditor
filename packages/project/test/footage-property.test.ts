// Spec 18 AF-DIG-004: properties of the footage digest and take grouping (fast-check):
// - neither throws on arbitrary transcripts (nonfinite, reversed, overlapping, unsorted words, odd text);
// - output phrase times are ordered and inside the media bounds, in the structure and in the text;
// - the digest never exceeds maxChars;
// - take grouping is symmetric (independent of the order media and transcripts are given in) and deterministic.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	DIGEST_MAX_CHARS_LIMIT,
	DIGEST_MIN_MAX_CHARS,
	findTakes,
	type ProjectDocument,
	packFootageDigest,
	type Transcript,
	takeSimilarity,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const S = 705_600_000;
const VOCAB = [
	'the',
	'show',
	'Welcome',
	'to',
	'um',
	'everybody.',
	'fox',
	'jumps',
	'eh',
	'¿Sí?',
	'x\ny',
	'',
	' ',
	'—',
];

const time = fc.oneof(
	{ weight: 8, arbitrary: fc.integer({ min: 0, max: 40 * S }) },
	{
		weight: 1,
		arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -1, -S, Number.MAX_SAFE_INTEGER),
	},
	{ weight: 1, arbitrary: fc.double() },
);

const word = fc.record({
	text: fc.oneof(fc.constantFrom(...VOCAB), fc.string({ maxLength: 12 })),
	start: time,
	end: time,
	confidence: fc.oneof(fc.constant(null), fc.double({ min: -1, max: 2 }), fc.constant(Number.NaN)),
	speaker: fc.oneof(fc.constant(null), fc.constantFrom('S1', 'S2', 'spk', '')),
	breakBefore: fc.constantFrom('none', 'line', 'segment'),
});

/** Speech-like words: increasing times, so phrases and takes actually form. */
const speech = fc
	.array(
		fc.record({
			w: fc.constantFrom(...VOCAB),
			gap: fc.integer({ min: 0, max: 900 }),
			dur: fc.integer({ min: 0, max: 600 }),
		}),
		{ maxLength: 60 },
	)
	.map((xs) => {
		let t = 0;
		return xs.map(({ w, gap, dur }) => {
			const start = t + Math.round((gap / 1000) * S);
			t = start + Math.round((dur / 1000) * S);
			return { text: w, start, end: t, confidence: 0.8, speaker: null, breakBefore: 'none' as const };
		});
	});

const media = fc.array(
	fc.record({
		seconds: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 60 })),
		audio: fc.boolean(),
		words: fc.oneof(fc.array(word, { maxLength: 40 }), speech),
		transcribed: fc.boolean(),
		language: fc.constantFrom('en', 'es', 'und', ''),
	}),
	{ minLength: 1, maxLength: 4 },
);

function build(
	spec: Array<{ seconds: number; audio: boolean; words: unknown[]; transcribed: boolean; language: string }>,
) {
	const h = new Harness();
	const ids = spec.map((m) => h.registerVideo({ seconds: Math.max(1, m.seconds), audio: m.audio }));
	const transcripts: Record<string, Transcript> = {};
	spec.forEach((m, k) => {
		if (!m.transcribed) return;
		transcripts[`t${k}`] = {
			id: `t${k}`,
			mediaId: ids[k]!,
			language: m.language,
			origin: 'whisper-local',
			words: m.words as Transcript['words'],
			speakers: {},
		};
	});
	const doc: ProjectDocument = { ...h.doc, transcripts };
	// some media of unknown duration
	spec.forEach((m, k) => {
		if (m.seconds === 0) {
			const a = doc.media[ids[k]!]!;
			doc.media = { ...doc.media, [a.id]: { ...a, probe: { ...a.probe, durationFlicks: null } } };
		}
	});
	return { doc, ids };
}

const TIME_RE = /^ {2}\[(\d+\.\d\d)-(\d+\.\d\d)\]/;

describe('footage digest properties', () => {
	it('never throws; phrases are ordered and inside the bounds; maxChars holds', () => {
		fc.assert(
			fc.property(media, fc.integer({ min: -10, max: 300_000 }), (spec, maxChars) => {
				const { doc } = build(spec);
				const r = packFootageDigest(doc, { maxChars });
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				const limit = Math.min(DIGEST_MAX_CHARS_LIMIT, Math.max(DIGEST_MIN_MAX_CHARS, maxChars));
				expect(r.text.length).toBeLessThanOrEqual(limit);
				for (const sec of r.sections) {
					let prev = -1;
					for (const p of sec.phrases) {
						expect(Number.isFinite(p.start) && Number.isFinite(p.end)).toBe(true);
						expect(p.start).toBeGreaterThanOrEqual(0);
						expect(p.end).toBeGreaterThanOrEqual(p.start);
						expect(p.start).toBeGreaterThanOrEqual(prev);
						if (sec.end !== null) expect(p.end).toBeLessThanOrEqual(sec.end);
						prev = p.start;
					}
				}
				// the text: every time line is ordered within its media and inside its bounds
				let last = -1;
				let bound = Number.POSITIVE_INFINITY;
				for (const line of r.text.split('\n')) {
					if (line.startsWith('## ')) {
						last = -1;
						const id = line.slice(3).split(' ')[0]!;
						const sec = r.sections.find((s) => s.id === id);
						bound = sec?.end != null ? Math.round((sec.end * 100) / S) / 100 : Number.POSITIVE_INFINITY;
						continue;
					}
					const m = TIME_RE.exec(line);
					if (!m) continue;
					const a = Number(m[1]);
					const b = Number(m[2]);
					expect(a).toBeLessThanOrEqual(b);
					expect(a).toBeGreaterThanOrEqual(last);
					expect(b).toBeLessThanOrEqual(bound + 1e-9);
					last = a;
				}
			}),
			{ numRuns: 300 },
		);
	});

	it('the sequence digest never throws on arbitrary transcripts', () => {
		fc.assert(
			fc.property(media, (spec) => {
				const { doc, ids } = build(spec);
				const h = new Harness();
				h.doc = doc;
				const seqId = Object.keys(doc.sequences)[0]!;
				const placed = h.tx([{ type: 'clip.place', source: { mediaId: ids[0]! }, at: 0 }]);
				const r = packFootageDigest(placed.ok ? h.doc : doc, { sequenceId: seqId });
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				for (const p of r.sections[0]!.phrases) {
					expect(p.end).toBeGreaterThanOrEqual(p.start);
					expect(p.start).toBeGreaterThanOrEqual(0);
				}
			}),
			{ numRuns: 100 },
		);
	});
});

describe('take properties', () => {
	it('never throws; grouping is symmetric and deterministic', () => {
		fc.assert(
			fc.property(media, fc.double({ min: 0.3, max: 1, noNaN: true }), (spec, minSimilarity) => {
				const { doc, ids } = build(spec);
				const r = findTakes(doc, { minSimilarity });
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				// deterministic
				expect(findTakes(doc, { minSimilarity })).toEqual(r);
				// symmetric: the order media and transcripts are given in does not matter
				const reversed: ProjectDocument = {
					...doc,
					transcripts: Object.fromEntries(Object.entries(doc.transcripts).reverse()),
				};
				expect(findTakes(reversed, { minSimilarity, mediaIds: [...ids].reverse() })).toEqual(r);
				// a partition into groups of ≥ 2 whose members are each similar to another member
				const seen = new Set<string>();
				for (const g of r.groups) {
					expect(g.members.length).toBeGreaterThanOrEqual(2);
					expect(g.suggested).toBeGreaterThanOrEqual(0);
					expect(g.suggested).toBeLessThan(g.members.length);
					const toks = g.members.map((m) => m.normalized.split(' '));
					g.members.forEach((m, i) => {
						const key = `${m.mediaId}@${m.start}`;
						expect(seen.has(key)).toBe(false);
						seen.add(key);
						expect(m.end).toBeGreaterThanOrEqual(m.start);
						const near = toks.some((t, j) => j !== i && takeSimilarity(toks[i]!, t) >= minSimilarity - 1e-9);
						expect(near).toBe(true);
					});
				}
			}),
			{ numRuns: 200 },
		);
	});

	it('similarity is symmetric and within [0, 1]', () => {
		const toks = fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 12 });
		fc.assert(
			fc.property(toks, toks, (a, b) => {
				const s = takeSimilarity(a, b);
				expect(s).toBe(takeSimilarity(b, a));
				expect(s).toBeGreaterThanOrEqual(0);
				expect(s).toBeLessThanOrEqual(1);
			}),
		);
	});
});
