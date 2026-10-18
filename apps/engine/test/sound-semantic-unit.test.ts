// Describe-it search building blocks (spec 12 P6-E14, WP-E9): the CLAP log-mel front end against a direct DFT oracle,
// repeat padding, the windows of a sound, the tokenizer (on a test vocabulary; the real one is checked against the
// reference on the build server: scripts/check-clap.ts), the calibrated z against the brute-force definition (property
// test), verdict bands, ranking keys, moment windows and picking, edge levels and trimming, and the embedding cache
// (round trip, invalidation by key, a damaged file set aside, fuzzed bytes never throw). No model, no network.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tinyVocab } from '@jasper/testkit/tiny-clap';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EmbeddingStore, keyOf, MAX_RECORDS } from '../src/sounds/semantic/embeddings.ts';
import {
	CLAP_EMBED_DIM,
	CLAP_FRAMES,
	CLAP_MELS,
	CLAP_RATE,
	CLAP_WINDOW_SAMPLES,
	clapLogMel,
	clapMelFilters,
	meanEmbedding,
	normalize,
	repeatPad,
	wholeSoundWindows,
} from '../src/sounds/semantic/frontend.ts';
import { edgeLevels, trimToSound } from '../src/sounds/semantic/levels.ts';
import {
	audioStats,
	calibrationOf,
	captionOf,
	coarseWindows,
	dot,
	fineWindows,
	matchOf,
	pickMoments,
	queryBias,
	rankKeys,
	referenceOf,
	regionsToRefine,
	semanticScoreOf,
	slidingWindows,
	verdictOf,
} from '../src/sounds/semantic/score.ts';
import { ClapTokenizer, EOS_ID, MAX_TEXT_TOKENS } from '../src/sounds/semantic/tokenizer.ts';
import { SOUND_VOCABULARY } from '../src/sounds/semantic/vocab.ts';
import { tempAppdir } from './helpers.ts';

function sine(freq: number, seconds: number, amp = 0.5): Float32Array {
	const n = Math.round(seconds * CLAP_RATE);
	const x = new Float32Array(n);
	for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / CLAP_RATE);
	return x;
}

function unit(seed: number): Float32Array {
	let s = seed >>> 0 || 1;
	const v = new Float32Array(CLAP_EMBED_DIM);
	for (let i = 0; i < v.length; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		v[i] = s / 0x80000000 - 1;
	}
	return normalize(v);
}

describe('CLAP front end', () => {
	it('repeat-pads a short sound whole as often as it fits, then zeros; cuts a long one to 10 s', () => {
		const x = Float32Array.from({ length: 300_000 }, (_, i) => (i % 7) / 7);
		const p = repeatPad(x);
		expect(p.length).toBe(CLAP_WINDOW_SAMPLES);
		expect([...p.subarray(0, 300_000)]).toEqual([...x]);
		expect(p.subarray(300_000).every((v) => v === 0)).toBe(true);
		const short = Float32Array.from([1, 2, 3]);
		const q = repeatPad(short);
		expect([...q.subarray(0, 6)]).toEqual([1, 2, 3, 1, 2, 3]);
		expect(q[CLAP_WINDOW_SAMPLES - 1]).toBe(3); // 160 000 repeats fill 480 000 exactly
		const long = Float32Array.from({ length: CLAP_WINDOW_SAMPLES + 10 }, (_, i) => i);
		expect(repeatPad(long)[CLAP_WINDOW_SAMPLES - 1]).toBe(CLAP_WINDOW_SAMPLES - 1);
		expect(repeatPad(new Float32Array(0)).every((v) => v === 0)).toBe(true);
		expect(
			repeatPad(Float32Array.from([Number.NaN, Number.POSITIVE_INFINITY, 0.5])).every(Number.isFinite),
		).toBe(true);
	});

	it('matches a direct DFT of the published recipe (oracle) to 1e-4 dB', () => {
		const x = sine(1000, 0.25, 0.3);
		const got = clapLogMel(x);
		expect(got.length).toBe(CLAP_FRAMES * CLAP_MELS);
		// oracle: reflect-padded centred frames, periodic Hann, direct DFT power, Slaney filters, 10·log10(max(·,1e-10))
		const padded = repeatPad(x);
		const at = (i: number) =>
			i < 0 ? padded[-i]! : i >= padded.length ? padded[2 * padded.length - 2 - i]! : padded[i]!;
		const fb = clapMelFilters();
		for (const t of [0, 1, 37, 500, CLAP_FRAMES - 1]) {
			const frame = Array.from(
				{ length: 1024 },
				(_, i) => at(t * 480 - 512 + i) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 1024)),
			);
			for (const m of [0, 9, 31, 63]) {
				let mel = 0;
				for (let b = 0; b <= 512; b++) {
					let re = 0;
					let im = 0;
					for (let i = 0; i < 1024; i++) {
						re += frame[i]! * Math.cos((2 * Math.PI * b * i) / 1024);
						im -= frame[i]! * Math.sin((2 * Math.PI * b * i) / 1024);
					}
					mel += (re * re + im * im) * fb[b * CLAP_MELS + m]!;
				}
				const want = 10 * Math.log10(Math.max(1e-10, mel));
				expect(Math.abs(got[t * CLAP_MELS + m]! - want)).toBeLessThan(1e-4);
			}
		}
	}, 60_000);

	it('puts a tone in the right band and gives silence the floor', () => {
		const lo = clapLogMel(sine(200, 1));
		const hi = clapLogMel(sine(8000, 1));
		const loudest = (f: Float32Array) => {
			let best = 0;
			for (let m = 1; m < CLAP_MELS; m++) if (f[100 * CLAP_MELS + m]! > f[100 * CLAP_MELS + best]!) best = m;
			return best;
		};
		expect(loudest(lo)).toBeLessThan(10);
		expect(loudest(hi)).toBeGreaterThan(40);
		expect(clapLogMel(new Float32Array(100)).every((v) => v === -100)).toBe(true);
	});

	it('windows a sound for its whole-sound embedding', () => {
		expect(wholeSoundWindows(0)).toEqual([]);
		expect(wholeSoundWindows(Number.NaN)).toEqual([]);
		expect(wholeSoundWindows(3.2)).toEqual([{ startSec: 0, endSec: 3.2 }]);
		expect(wholeSoundWindows(10)).toEqual([{ startSec: 0, endSec: 10 }]);
		expect(wholeSoundWindows(25)).toEqual([
			{ startSec: 0, endSec: 10 },
			{ startSec: 7.5, endSec: 17.5 },
			{ startSec: 15, endSec: 25 },
		]);
		const hour = wholeSoundWindows(3600);
		expect(hour).toHaveLength(6);
		expect(hour[5]).toEqual({ startSec: 3590, endSec: 3600 });
		const m = meanEmbedding([unit(1), unit(2)]);
		expect(Math.abs(dot(m, m) - 1)).toBeLessThan(1e-5);
		expect(meanEmbedding([]).every((v) => v === 0)).toBe(true);
	});
});

describe('CLAP tokenizer', () => {
	const { vocab, merges } = tinyVocab();
	const tok = new ClapTokenizer(JSON.stringify(vocab), `#version: 0.2\n${merges.join('\n')}\n`);

	it('splits like GPT-2 byte-level BPE and wraps <s> … </s>', () => {
		expect(tok.encode(captionOf('high'))).toEqual([
			0,
			vocab.this,
			vocab['Ġis'],
			vocab['Ġa'],
			vocab['Ġsound'],
			vocab['Ġof'],
			vocab['Ġhigh'],
			2,
		]);
		expect(tok.encode('')).toEqual([0, 2]);
		// unknown letters fall back to single byte characters, never to nothing
		expect(tok.encode('zq').slice(1, -1)).toEqual([vocab.z, vocab.q]);
	});

	it('never throws and never exceeds 77 tokens on hostile text', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 2000 }), (s) => {
				const ids = tok.encode(s);
				expect(ids.length).toBeLessThanOrEqual(MAX_TEXT_TOKENS);
				expect(ids[0]).toBe(0);
				expect(ids[ids.length - 1]).toBe(EOS_ID);
				expect(ids.every((i) => Number.isInteger(i) && i >= 0)).toBe(true);
			}),
			{ numRuns: 300 },
		);
		expect(tok.encode('a'.repeat(100_000)).length).toBeLessThanOrEqual(MAX_TEXT_TOKENS);
		expect(() => tok.encode('🔊 naïve — \u0000‮')).not.toThrow();
	});

	it('refuses malformed tokenizer files', () => {
		expect(() => new ClapTokenizer('[]', 'a b')).toThrow();
		expect(() => new ClapTokenizer('{"a":1}', 'a b')).toThrow(/special/);
		expect(() => new ClapTokenizer(JSON.stringify(vocab), '#version: 0.2\n')).toThrow(/merges/);
	});
});

describe('calibrated match', () => {
	const vocab = Array.from({ length: 40 }, (_, i) => unit(1000 + i));
	const cal = calibrationOf(vocab);
	const library = Array.from({ length: 50 }, (_, i) => unit(5000 + i));
	const items = library.map((a) => ({ a, stats: audioStats(a, cal) }));
	const ref = referenceOf(items, cal);

	it('equals the brute-force z over the vocabulary (hub damping included)', () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 0, max: 49 }), (qs, ai) => {
				const q = unit(qs);
				const a = library[ai]!;
				const got = matchOf(a, items[ai]!.stats, q, queryBias(q, ref), ref);
				const abar = ref.mean;
				const s = (x: Float32Array) => dot(a, x) - ref.lambda * dot(abar, x);
				const sv = vocab.map(s);
				const mu = sv.reduce((x, y) => x + y, 0) / sv.length;
				const sd = Math.sqrt(sv.reduce((x, y) => x + (y - mu) ** 2, 0) / sv.length);
				expect(got.z).toBeCloseTo((s(q) - mu) / sd, 3);
				expect(got.cosine).toBeCloseTo(dot(a, q), 4);
			}),
			{ numRuns: 60 },
		);
		expect(ref.lambda).toBe(1);
		expect(referenceOf(items.slice(0, 8), cal).lambda).toBe(0.25);
		expect(referenceOf([], cal).lambda).toBe(0);
	});

	it('is deterministic, finite on degenerate input and ranks a matching description first', () => {
		const q = unit(42);
		const a = matchOf(library[3]!, items[3]!.stats, q, queryBias(q, ref), ref);
		expect(matchOf(library[3]!, items[3]!.stats, q, queryBias(q, ref), ref)).toEqual(a);
		const degenerate = calibrationOf([unit(1), unit(1)]);
		const z = matchOf(library[0]!, audioStats(library[0]!, degenerate), q, 0, referenceOf([], degenerate));
		expect(Number.isFinite(z.z)).toBe(true);
		// the description equal to a sound's embedding is that sound's best match
		const target = library[7]!;
		const ms = items.map((it) => matchOf(it.a, it.stats, target, queryBias(target, ref), ref));
		const keys = rankKeys(ms);
		expect(keys.indexOf(Math.max(...keys))).toBe(7);
	});

	it('maps z to verdicts and ranking keys to the 0…1 describe score', () => {
		expect([3.2, 3, 2.7, 2.5, 2.2, 2, 1.9, -1, Number.NaN].map(verdictOf)).toEqual([
			'strong',
			'strong',
			'plausible',
			'plausible',
			'weak',
			'weak',
			'none',
			'none',
			'none',
		]);
		expect([-1, 0, 2, 8, 20, Number.NaN].map(semanticScoreOf)).toEqual([0, 0, 0.25, 1, 1, 0]);
		expect(rankKeys([])).toEqual([]);
		expect(rankKeys([{ z: 1.5, cosine: 0.3 }])).toEqual([1.5]);
		expect(
			rankKeys([
				{ z: 0, cosine: 0.1 },
				{ z: 0, cosine: 0.3 },
			]),
		).toEqual([-1, 1]);
	});

	it('writes every vocabulary phrase once, short and lower-case', () => {
		expect(SOUND_VOCABULARY.length).toBeGreaterThanOrEqual(280);
		expect(SOUND_VOCABULARY.length).toBeLessThanOrEqual(330);
		expect(new Set(SOUND_VOCABULARY).size).toBe(SOUND_VOCABULARY.length);
		for (const p of SOUND_VOCABULARY) {
			expect(p.length).toBeLessThanOrEqual(80);
			expect(p).toBe(p.trim());
		}
	});
});

describe('Find Moment windows', () => {
	it('slides windows over a range, the last one ending at its end', () => {
		expect(slidingWindows(0, 3, 1, 1)).toEqual([
			{ startSec: 0, endSec: 1 },
			{ startSec: 1, endSec: 2 },
			{ startSec: 2, endSec: 3 },
		]);
		expect(slidingWindows(0, 2.5, 1, 1).at(-1)).toEqual({ startSec: 1.5, endSec: 2.5 });
		expect(slidingWindows(0, 0.5, 1, 1)).toEqual([{ startSec: 0, endSec: 0.5 }]);
		expect(slidingWindows(1, 1, 1, 1)).toEqual([]);
		expect(slidingWindows(0, 10, 0, 1)).toEqual([]);
		expect(coarseWindows(0, 8)).toEqual([]);
		expect(coarseWindows(0, 30)).toHaveLength(5);
		// past 30 min the coarse pass does not overlap
		expect(coarseWindows(0, 3600)).toHaveLength(360);
	});

	it('refines the best regions and keeps the best non-overlapping windows', () => {
		const range = { startSec: 0, endSec: 60 };
		const fine = fineWindows(
			[
				{ startSec: 10, endSec: 20 },
				{ startSec: 15, endSec: 25 },
			],
			2,
			range,
		);
		expect(fine[0]).toEqual({ startSec: 9, endSec: 11 });
		expect(fine.at(-1)).toEqual({ startSec: 24, endSec: 26 });
		expect(new Set(fine.map((w) => `${w.startSec}`)).size).toBe(fine.length);
		const scored = fine.map((w) => ({ window: w, key: -Math.abs(w.startSec - 17) }));
		const picked = pickMoments(scored, 3);
		expect(picked[0]!.window.startSec).toBe(17);
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.double({ min: 0, max: 100, noNaN: true }),
						fc.double({ min: 0.1, max: 5, noNaN: true }),
						fc.double({ noNaN: true, min: -10, max: 10 }),
					),
					{ maxLength: 60 },
				),
				fc.integer({ min: 1, max: 10 }),
				(ws, n) => {
					const list = ws.map(([s, l, k]) => ({ window: { startSec: s, endSec: s + l }, key: k }));
					const got = pickMoments(list, n);
					expect(got.length).toBeLessThanOrEqual(n);
					for (let i = 0; i < got.length; i++)
						for (let j = i + 1; j < got.length; j++) {
							const a = got[i]!.window;
							const b = got[j]!.window;
							expect(a.startSec < b.endSec && b.startSec < a.endSec).toBe(false);
						}
					for (let i = 1; i < got.length; i++) expect(got[i - 1]!.key).toBeGreaterThanOrEqual(got[i]!.key);
				},
			),
			{ numRuns: 200 },
		);
		expect(regionsToRefine(scored)).toHaveLength(3);
	});

	it('measures head and tail and trims a window to its sound', () => {
		const x = new Float32Array(CLAP_RATE); // 1 s: silence, a 100 ms tone at 0.4 s, silence
		for (let i = 0.4 * CLAP_RATE; i < 0.5 * CLAP_RATE; i++)
			x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / CLAP_RATE);
		const t = trimToSound(x, CLAP_RATE);
		expect(t.start / CLAP_RATE).toBeCloseTo(0.395, 2);
		expect(t.end / CLAP_RATE).toBeCloseTo(0.52, 2);
		const e = edgeLevels(x.subarray(t.start, t.end), CLAP_RATE);
		expect(e.headDb).toBeLessThan(-40);
		expect(e.tailDb).toBeLessThan(-40);
		// cut inside the tone: the head is loud
		const cut = edgeLevels(x.subarray(0.45 * CLAP_RATE, 0.6 * CLAP_RATE), CLAP_RATE);
		expect(cut.headDb).toBeGreaterThan(-6);
		expect(trimToSound(new Float32Array(100), CLAP_RATE)).toEqual({ start: 0, end: 100 });
		expect(edgeLevels(new Float32Array(0), CLAP_RATE)).toEqual({ headDb: 0, tailDb: 0 });
	});
});

describe('embedding cache', () => {
	it('round-trips, keys by content and range, and drops what the index no longer has', async () => {
		const dir = tempAppdir('jasper-emb-');
		const file = join(dir, 'semantic', 'sounds.emb');
		const s = new EmbeddingStore(file);
		const fp = `q1:${'a'.repeat(64)}`;
		const whole = keyOf(fp, 'whole');
		const take = keyOf(fp, { startSec: 1, endSec: 1.25 });
		expect(whole).not.toBe(take);
		expect(keyOf(`q1:${'b'.repeat(64)}`, 'whole')).not.toBe(whole);
		expect(await s.set(whole, unit(1))).toBe(true);
		expect(await s.set(take, unit(2))).toBe(true);
		expect(await s.set('x', new Float32Array(3))).toBe(false);
		await s.flush();
		const again = new EmbeddingStore(file);
		expect([...((await again.get(whole)) ?? [])]).toEqual([...unit(1)]);
		await again.flush((k) => k === take);
		const third = new EmbeddingStore(file);
		expect(await third.has(whole)).toBe(false);
		expect(await third.has(take)).toBe(true);
		expect(await third.clear()).toBe(1);
		expect(await new EmbeddingStore(file).has(take)).toBe(false);
		expect(MAX_RECORDS).toBeGreaterThan(10_000);
	});

	it('sets a damaged file aside and starts empty; fuzzed bytes never throw', async () => {
		const dir = tempAppdir('jasper-emb-bad-');
		mkdirSync(join(dir, 'c'), { recursive: true });
		const file = join(dir, 'c', 'sounds.emb');
		writeFileSync(file, 'JCLAPEM1 garbage');
		const logs: string[] = [];
		const s = new EmbeddingStore(file, (m) => logs.push(m));
		expect(await s.has('k')).toBe(false);
		expect(logs[0]).toMatch(/unreadable/);
		expect(readdirSync(join(dir, 'c')).some((f) => f.startsWith('sounds.emb.corrupt-'))).toBe(true);
		await fc.assert(
			fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (bytes) => {
				const f = join(dir, 'c', 'fuzz.emb');
				const head = Buffer.alloc(16);
				head.write('JCLAPEM1', 0, 'latin1');
				head.writeUInt32LE(CLAP_EMBED_DIM, 8);
				head.writeUInt32LE(bytes.length % 7, 12);
				writeFileSync(f, Buffer.concat([head, Buffer.from(bytes)]));
				const st = new EmbeddingStore(f);
				await expect(st.load()).resolves.toBeInstanceOf(Map);
			}),
			{ numRuns: 60 },
		);
	});
});
