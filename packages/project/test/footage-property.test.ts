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
	footageMedia,
	footagePhrases,
	normaliseTakeTokens,
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

const LINES = [
	'welcome to the show everybody',
	'today we cook fresh pasta',
	'the quick brown fox jumps over',
	'thanks for being here with us tonight',
];
/** Takes: lines said again with words dropped, fillers and repeats, 0.6…2 s apart. */
const takes = fc
	.array(
		fc.record({
			line: fc.constantFrom(...LINES),
			drop: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
			filler: fc.boolean(),
			end: fc.constantFrom('', '.', '?'),
			pause: fc.integer({ min: 600, max: 2000 }),
		}),
		{ maxLength: 12 },
	)
	.map((xs) => {
		let t = 0;
		const out: Array<Record<string, unknown>> = [];
		for (const x of xs) {
			const ws = x.line.split(' ').filter((_, k) => !(x.drop[k] && k % 3 === 1));
			if (x.filler) ws.splice(1, 0, 'um');
			t += Math.round((x.pause / 1000) * S);
			ws.forEach((w, k) => {
				const start = t;
				t += Math.round(0.3 * S);
				out.push({
					text: k === ws.length - 1 ? `${w}${x.end}` : w,
					start,
					end: t,
					confidence: 0.9,
					speaker: null,
					breakBefore: 'none',
				});
				t += Math.round(0.1 * S);
			});
		}
		return out;
	});

const media = fc.array(
	fc.record({
		seconds: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 60 })),
		audio: fc.boolean(),
		words: fc.oneof(fc.array(word, { maxLength: 40 }), speech, takes),
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

	it('holds maxChars on long footage and cuts only between media (or a first media at a phrase line)', () => {
		const long = fc.array(
			fc.record({
				seconds: fc.constant(600),
				audio: fc.constant(true),
				words: fc
					.array(fc.record({ w: fc.constantFrom(...VOCAB), gap: fc.integer({ min: 0, max: 900 }) }), {
						minLength: 50,
						maxLength: 400,
					})
					.map((xs) => {
						let t = 0;
						return xs.map(({ w, gap }) => {
							const start = t + Math.round((gap / 1000) * S);
							t = start + Math.round(0.3 * S);
							return {
								text: `${w}x`,
								start,
								end: t,
								confidence: 0.9,
								speaker: null,
								breakBefore: 'none' as const,
							};
						});
					}),
				transcribed: fc.constant(true),
				language: fc.constant('en'),
			}),
			{ minLength: 1, maxLength: 6 },
		);
		fc.assert(
			fc.property(long, fc.integer({ min: 1000, max: 6000 }), (spec, maxChars) => {
				const { doc } = build(spec);
				const full = packFootageDigest(doc, { maxChars: DIGEST_MAX_CHARS_LIMIT });
				const r = packFootageDigest(doc, { maxChars });
				if (!r.ok || !full.ok) throw new Error('refused');
				expect(r.text.length).toBeLessThanOrEqual(maxChars);
				expect(r.shown.length + r.notShown.length).toBe(spec.length);
				// every shown media but a cut first one has exactly the phrases of the full digest
				r.sections.forEach((sec, i) => {
					const whole = full.sections.find((x) => x.id === sec.id)!;
					if (i === 0 && r.cutPhrases) expect(sec.phrases.length + r.cutPhrases).toBe(whole.phrases.length);
					else expect(sec.phrases).toEqual(whole.phrases);
				});
				if (r.notShown.length)
					expect(
						r.text.trimEnd().endsWith(`… ${r.notShown.length} more media not shown: pass mediaIds`),
					).toBe(true);
			}),
			{ numRuns: 150 },
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

	it('is complete: any two comparable phrases at least minSimilarity alike share a group (brute force)', () => {
		fc.assert(
			fc.property(media, fc.double({ min: 0.3, max: 1, noNaN: true }), (spec, minSimilarity) => {
				const { doc } = build(spec);
				const r = findTakes(doc, { minSimilarity });
				if (!r.ok) throw new Error(r.message);
				const groupOf = new Map<string, string>();
				for (const g of r.groups) for (const m of g.members) groupOf.set(`${m.mediaId}@${m.start}`, g.id);
				const all: Array<{ key: string; toks: string[] }> = [];
				for (const m of footageMedia(doc, null, 'transcribed').media) {
					const end = m.asset.probe.durationFlicks;
					for (const p of footagePhrases(m.transcript!.words, { end })) {
						const toks = normaliseTakeTokens(
							p.words.map((w) => w.text),
							m.transcript!.language,
						).slice(0, 200);
						if (toks.length >= 2) all.push({ key: `${m.id}@${p.start}`, toks });
					}
				}
				expect(r.phrasesCompared).toBe(all.length);
				for (let i = 0; i < all.length; i++)
					for (let j = i + 1; j < all.length; j++)
						if (takeSimilarity(all[i]!.toks, all[j]!.toks) >= minSimilarity) {
							expect(groupOf.get(all[i]!.key)).toBeDefined();
							expect(groupOf.get(all[i]!.key)).toBe(groupOf.get(all[j]!.key));
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
