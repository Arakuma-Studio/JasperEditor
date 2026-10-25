// Spec 16 SG-011/SG-012/SG-013/SG-014 and spec 14 TC-003/TC-004: hallucination guards, word bounds against speech
// frames, the BPE encoder for initial prompts, the optimised decoding hot spots (equal to straightforward
// references) and the streaming log-mel front end (equal to the batch one).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyFilters, logSoftmax, logSoftmaxInto, logSumExp, topK } from '../src/speech/core/decode.ts';
import {
	dropRepeatedTokenRuns,
	isSegmentAnomaly,
	knownPhraseRuns,
	normalizePhrase,
	phraseOverNonSpeech,
	silenceThresholdCut,
	wordAnomalyScore,
} from '../src/speech/core/hallucination.ts';
import { LogMelStream, logMel, windowFromRaw } from '../src/speech/core/mel.ts';
import { type TokenizerJson, WhisperTokenizer } from '../src/speech/core/tokenizer.ts';
import { frameDb, unvoicedWords, vadThreshold, voicedFraction, voicedMask } from '../src/speech/core/vad.ts';
import { InputBuilder, inputFromSamples, MelFrames } from '../src/speech/worker/audio.ts';
import { refineWords } from '../src/speech/worker/run.ts';

const SR = 16_000;
const s = (sec: number) => Math.round(sec * SR);

/** Speech-like bursts (noise, voiced by the energy VAD) where `voiced(t)`, near-silence elsewhere. */
function audio(seconds: number, voiced: (t: number) => boolean): Float32Array {
	const out = new Float32Array(s(seconds));
	let x = 12345;
	for (let i = 0; i < out.length; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		const r = x / 4294967296 - 0.5;
		out[i] = voiced(i / SR) ? r * 0.6 : r * 0.0004;
	}
	return out;
}

const frames = (a: Float32Array) => {
	const db = frameDb(a);
	return { samples: a.length, db, mask: voicedMask(db, vadThreshold(db)) };
};

describe('hallucination guard over a silence gap (SG-011 regression: "Gracias por ver el vídeo")', () => {
	// speech 0–3 s, digital-quiet 3–13 s, speech 13–16 s
	const a = audio(16, (t) => t < 3 || t >= 13);
	const word = (text: string, t0: number, t1: number) => ({ text, start: s(t0), end: s(t1), probability: 0.9 });
	const words = () => [
		word('Hola', 0.1, 0.5),
		word('a', 0.6, 0.9),
		word('todos.', 1.0, 2.8),
		// what Whisper produced over the silence of the measured clip, carried by the previous-text prompt
		word('Gracias', 5.0, 5.4),
		word('por', 5.4, 5.6),
		word('ver', 5.6, 5.8),
		word('el', 5.8, 5.9),
		word('vídeo.', 5.9, 6.4),
		word('Seguimos', 13.1, 13.6),
		word('con', 13.7, 14.0),
		word('el', 14.1, 14.3),
		word('tema.', 14.4, 15.5),
	];

	it('drops the words lying in the gap and keeps every word around it in place', () => {
		const r = refineWords(frames(a), words());
		expect(r.words.map((w) => w.text)).toEqual(['Hola', 'a', 'todos.', 'Seguimos', 'con', 'el', 'tema.']);
		expect(r.dropped).toBe(5);
		for (const w of r.words) {
			const mid = (w.start + w.end) / 2 / SR;
			expect(mid < 3 || mid >= 13).toBe(true);
		}
		// nothing after the gap moved into it, nothing moved onto speech before it
		const after = r.words.filter((w) => w.start >= s(13));
		expect(after).toHaveLength(4);
		expect(after[0]!.start).toBeGreaterThanOrEqual(s(13));
	});

	it('a known phrase over non-speech is removed even when its words touch voice; spoken it is kept', () => {
		// "Thanks for watching!" mostly over silence, its last word grazing speech
		const b = audio(8, (t) => t < 2 || t >= 5.9);
		const r = refineWords(frames(b), [
			{ text: 'Hello.', start: s(0.2), end: s(1.8), probability: 0.9 },
			{ text: 'Thanks', start: s(4.0), end: s(4.8), probability: 0.4 },
			{ text: 'for', start: s(4.8), end: s(5.0), probability: 0.4 },
			{ text: 'watching!', start: s(5.0), end: s(6.4), probability: 0.4 },
		]);
		expect(r.words.map((w) => w.text)).toEqual(['Hello.']);
		expect(r.removed.some((x) => x.reason === 'known-phrase' && /Thanks/.test(x.text))).toBe(true);
		const spoken = refineWords(frames(audio(3, () => true)), [
			{ text: 'Gracias.', start: s(0.5), end: s(1.2), probability: 0.9 },
		]);
		expect(spoken.words.map((w) => w.text)).toEqual(['Gracias.']);
	});

	it('property: a word lying entirely inside a silence of ≥ 2 s is never kept', () => {
		fc.assert(
			fc.property(
				fc.array(fc.record({ t: fc.double({ min: 0, max: 15.5, noNaN: true }), d: fc.double({ min: 0.02, max: 0.5, noNaN: true }) }), {
					maxLength: 25,
				}),
				(ws) => {
					const list = ws
						.map((w) => ({ text: 'x', start: s(w.t), end: s(Math.min(16, w.t + w.d)), probability: 0.5 }))
						.sort((p, q) => p.start - q.start);
					for (let i = 1; i < list.length; i++) list[i]!.start = Math.max(list[i]!.start, list[i - 1]!.end);
					for (const w of list) w.end = Math.max(w.start, w.end);
					const r = refineWords(frames(a), list);
					return r.words.every((w) => !(w.start >= s(3.25) && w.end <= s(12.75)));
				},
			),
			{ numRuns: 200 },
		);
	});

	it('speech fractions: < 20 % voiced frames lie in silence; voice-analysis masks replace the energy mask', () => {
		const mask = new Uint8Array(100);
		mask.fill(1, 0, 10);
		expect(voicedFraction({ start: 0, end: s(0.5) }, mask)).toBeCloseTo(0.2, 6);
		expect(unvoicedWords([{ start: 0, end: s(0.5) }, { start: s(0.5), end: s(1) }, { start: 0, end: s(0.1) }], mask)).toEqual([1]);
		// TC-004: a breath/speech mask from the voice analysis drives the same refinement
		const b = audio(4, () => true);
		const db = frameDb(b);
		const va = new Uint8Array(db.length);
		va.fill(1, 0, 150); // speech 0–1.5 s only
		const r = refineWords({ samples: b.length, db, mask: va }, [
			{ text: 'one', start: s(0.2), end: s(1), probability: 1 },
			{ text: 'two', start: s(2.5), end: s(3), probability: 1 },
		]);
		expect(r.words.map((w) => w.text)).toEqual(['one']);
	});
});

describe('decoder-level guards (TC-003, OpenAI hallucination_silence_threshold)', () => {
	it('drops runs of ≥ 4 identical text tokens, keeps shorter ones and timestamps', () => {
		const r = dropRepeatedTokenRuns([100, 5, 5, 5, 5, 5, 6, 7, 7, 7, 100, 100, 100, 100], 50);
		expect(r.tokens).toEqual([100, 6, 7, 7, 7, 100, 100, 100, 100]);
		expect(r.removed).toEqual([[5, 5, 5, 5, 5]]);
		fc.assert(
			fc.property(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 60 }), (t) => {
				const r = dropRepeatedTokenRuns(t, 10);
				const removed = r.removed.reduce((n, run) => n + run.length, 0);
				return (
					r.tokens.length + removed === t.length &&
					r.removed.every((run) => run.length >= 4 && run.every((x) => x === run[0]))
				);
			}),
		);
	});

	it('anomaly scores follow OpenAI (improbable, too short, too long words)', () => {
		expect(wordAnomalyScore({ word: 'a', start: 0, end: 0.5, probability: 0.9 })).toBe(0);
		expect(wordAnomalyScore({ word: 'a', start: 0, end: 0.5, probability: 0.1 })).toBe(1);
		expect(wordAnomalyScore({ word: 'a', start: 0, end: 3, probability: 0.9 })).toBeCloseTo(1, 6);
		expect(wordAnomalyScore({ word: 'a', start: 0, end: 0.033, probability: 0.9 })).toBeCloseTo(1.5, 6);
		const bad = { start: 10, end: 11, words: [{ word: ' Gracias', start: 10, end: 10.05, probability: 0.1 }] };
		expect(isSegmentAnomaly(bad)).toBe(true);
		expect(isSegmentAnomaly({ start: 0, end: 1, words: [{ word: ' Hola', start: 0, end: 0.5, probability: 0.9 }] })).toBe(false);
	});

	it('cuts an anomalous segment surrounded by silence and resumes at it; skips a long leading silence', () => {
		const good = { start: 0.2, end: 2, words: [{ word: ' Hola', start: 0.2, end: 2, probability: 0.9 }] };
		const hal = { start: 12, end: 12.3, words: [{ word: ' Gracias', start: 12, end: 12.05, probability: 0.05 }] };
		const base = { threshold: 2, windowStart: 0, windowEnd: 30, contentEnd: 60, lastSpeech: 0, singleTimestampEnding: false, seek: 12.3 };
		const cut = silenceThresholdCut([good, hal], base);
		expect(cut.keep).toBe(1);
		expect(cut.seek).toBe(12);
		expect(silenceThresholdCut([good], base).keep).toBe(1);
		const lead = silenceThresholdCut([hal], { ...base, lastSpeech: 0 });
		expect(lead.skipTo).toBe(12);
		// near the end of the audio: seek to the end
		expect(silenceThresholdCut([good, hal], { ...base, contentEnd: 13 }).seek).toBe(13);
	});

	it('known phrases match across punctuation, case and accents', () => {
		expect(normalizePhrase('¡Gracias por ver el VÍDEO!')).toBe('gracias por ver el video');
		const w = (t: string) => ({ text: t });
		expect(
			knownPhraseRuns(['Subtítulos', 'realizados', 'por', 'la', 'comunidad', 'de', 'Amara.org'].map(w)),
		).toEqual([[0, 7]]);
		expect(knownPhraseRuns(['Bien.', 'Gracias', 'por', 'ver', 'el', 'video.', 'Fin'].map(w))).toEqual([[1, 6]]);
		// not a sentence of its own
		expect(knownPhraseRuns(['y', 'Gracias', 'por', 'ver', 'el', 'video.'].map(w))).toEqual([]);
		expect(knownPhraseRuns(['Gracias', 'a', 'todos'].map(w))).toEqual([]);
		expect(knownPhraseRuns(['Hola.', 'Gracias.'].map(w))).toEqual([[1, 2]]);
		expect(knownPhraseRuns(['Thank', 'you.'].map(w))).toEqual([[0, 2]]);
		expect(phraseOverNonSpeech(0.2)).toBe(true);
		expect(phraseOverNonSpeech(0.8)).toBe(false);
	});
});

describe('BPE encoding of initial prompts (SG-012, TC-003)', () => {
	// byte-level stand-ins: 'Ġ' = space; merges build " hola", "eh" and "..."
	// every byte has a stand-in character (GPT-2's bytes_to_unicode), like a real vocabulary
	const vocab: Record<string, number> = {};
	const bs: number[] = [];
	for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
	for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
	for (let b = 0xae; b <= 0xff; b++) bs.push(b);
	const cs = [...bs];
	let extra = 0;
	for (let b = 0; b < 256; b++)
		if (!bs.includes(b)) {
			bs.push(b);
			cs.push(256 + extra++);
		}
	cs.forEach((c, i) => {
		vocab[String.fromCodePoint(c)] = i;
	});
	const merges = ['Ġ h', 'o l', 'Ġh ol', 'Ġhol a', 'e h', '. .', '.. .'];
	for (const m of merges) vocab[m.replace(' ', '')] = Object.keys(vocab).length;
	const specials = ['<|endoftext|>', '<|startoftranscript|>', '<|transcribe|>', '<|notimestamps|>', '<|0.00|>'];
	const json = {
		model: { vocab, merges },
		added_tokens: specials.map((content, i) => ({ id: 1000 + i, content })),
	} as TokenizerJson;
	const tok = new WhisperTokenizer(json, false);

	it('applies merges by rank and round-trips', () => {
		expect(tok.canEncode).toBe(true);
		expect(tok.encode(' hola')).toEqual([vocab['Ġhola']]);
		expect(tok.encode('eh...')).toEqual([vocab.eh, vocab['...']]);
		expect(tok.decode(tok.encode(' hola eh... ¿vale?'))).toBe(' hola eh... ¿vale?');
		expect(tok.decode(tok.encode('año'))).toBe('año');
	});

	it('round-trips any text of its alphabet (property)', () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[ hola.,em¿?vñ]{0,40}$/), (text) => tok.decode(tok.encode(text)) === text),
			{ numRuns: 300 },
		);
	});

	it('refuses to encode without merges', () => {
		const plain = new WhisperTokenizer({ ...json, model: { vocab } } as TokenizerJson, false);
		expect(plain.canEncode).toBe(false);
		expect(() => plain.encode('x')).toThrow(/no BPE merges/);
	});
});

describe('decoding hot spots equal their references (SG-013)', () => {
	const NEG = Number.NEGATIVE_INFINITY;
	const logits = fc.array(fc.oneof(fc.double({ min: -30, max: 30, noNaN: true }), fc.constant(NEG)), {
		minLength: 1,
		maxLength: 300,
	});

	it('logSumExp / logSoftmaxInto / topK', () => {
		fc.assert(
			fc.property(logits, fc.integer({ min: 1, max: 8 }), (xs, k) => {
				const x = Float32Array.from(xs);
				const ref = logSoftmax(x);
				const into = logSoftmaxInto(x, new Float32Array(x.length));
				for (let i = 0; i < x.length; i++) if (!(ref[i] === into[i] || Math.abs(ref[i]! - into[i]!) < 1e-6)) return false;
				const lse = logSumExp(x);
				const m = Math.max(...xs);
				const naive = Number.isFinite(m) ? m + Math.log(xs.reduce((a, v) => a + Math.exp(v - m), 0)) : NEG;
				if (Number.isFinite(naive) ? Math.abs(lse - naive) > 1e-6 : lse !== NEG) return false;
				const want = [...x.keys()]
					.filter((i) => Number.isFinite(x[i]!))
					.sort((p, q) => x[q]! - x[p]! || p - q)
					.slice(0, k);
				const got = topK(x, k);
				return got.length === want.length && got.every((t, i) => x[t] === x[want[i]!]);
			}),
			{ numRuns: 400 },
		);
	});

	it('applyFilters gives the same logits as the original implementation (full log-softmax timestamp rule)', () => {
		const vocab: Record<string, number> = { a: 0, b: 1, c: 2 };
		const specials = ['<|endoftext|>', '<|startoftranscript|>', '<|transcribe|>', '<|notimestamps|>'];
		const added = specials.map((content, i) => ({ id: 3 + i, content }));
		for (let k = 0; k < 12; k++) added.push({ id: 7 + k, content: `<|${(k * 0.02).toFixed(2)}|>` });
		const tok = new WhisperTokenizer({ model: { vocab }, added_tokens: added } as TokenizerJson, false);
		const cfg = { suppress: [4, 5], beginSuppress: [3], maxInitialTimestampIndex: 3, timestamps: true };
		/** The filters as they were before SG-013 (loops instead of fill, the whole row normalised). */
		const reference = (logits: Float32Array, seq: readonly number[], finalRule = true) => {
			const tb = tok.timestampBegin;
			if (seq.length === 0) for (const x of cfg.beginSuppress) if (x < logits.length) logits[x] = NEG;
			for (const x of cfg.suppress) if (x < logits.length) logits[x] = NEG;
			logits[tok.noTimestamps] = NEG;
			const lastTs = seq.length >= 1 && seq[seq.length - 1]! >= tb;
			const penultTs = seq.length < 2 || seq[seq.length - 2]! >= tb;
			if (lastTs) {
				if (penultTs) for (let i = tb; i < logits.length; i++) logits[i] = NEG;
				else for (let i = 0; i < tok.eot; i++) logits[i] = NEG;
			}
			let lastTimestamp = -1;
			for (let k = seq.length - 1; k >= 0; k--)
				if (seq[k]! >= tb) {
					lastTimestamp = seq[k]!;
					break;
				}
			if (lastTimestamp >= 0) {
				const lim = Math.min(logits.length, lastTs && !penultTs ? lastTimestamp : lastTimestamp + 1);
				for (let i = tb; i < lim; i++) logits[i] = NEG;
			}
			if (seq.length === 0) {
				for (let i = 0; i < tb; i++) logits[i] = NEG;
				for (let i = tb + cfg.maxInitialTimestampIndex + 1; i < logits.length; i++) logits[i] = NEG;
			}
			if (!finalRule) return;
			const lp = logSoftmax(logits);
			let m = NEG;
			for (let i = tb; i < lp.length; i++) if (lp[i]! > m) m = lp[i]!;
			if (Number.isFinite(m)) {
				let sum = 0;
				for (let i = tb; i < lp.length; i++) sum += Math.exp(lp[i]! - m);
				const ts = m + Math.log(sum);
				let maxText = NEG;
				for (let i = 0; i < tb; i++) if (lp[i]! > maxText) maxText = lp[i]!;
				if (ts > maxText) for (let i = 0; i < tb; i++) logits[i] = NEG;
			}
		};
		/** Both sides of the timestamp rule in float64: the old code compared float32 log-softmax values. */
		const margin = (xs: number[], seq: readonly number[]) => {
			const l = Float32Array.from(xs);
			reference(l, seq, false);
			const tb = tok.timestampBegin;
			const ts = logSumExp(l, tb, l.length);
			let maxText = NEG;
			for (let i = 0; i < tb; i++) if (l[i]! > maxText) maxText = l[i]!;
			return Number.isFinite(ts) && Number.isFinite(maxText) ? Math.abs(ts - maxText) : Number.POSITIVE_INFINITY;
		};
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: -10, max: 10, noNaN: true }), { minLength: 19, maxLength: 19 }),
				fc.array(fc.integer({ min: 0, max: 18 }), { maxLength: 6 }),
				(xs, seq) => {
					// float32 rounding of the old normalised row may flip an exact-to-1e-5 tie: not a behaviour change
					fc.pre(margin(xs, seq) > 1e-4);
					const a = Float32Array.from(xs);
					const c = Float32Array.from(xs);
					applyFilters(a, seq, tok, cfg);
					reference(c, seq);
					return a.every((v, i) => v === c[i]);
				},
			),
			{ numRuns: 500 },
		);
	});
});

describe('streaming log-mel equals the batch front end (SG-014)', () => {
	it('any chunking gives the batch frames, maximum and windows', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 9000 }),
				fc.array(fc.integer({ min: 1, max: 3000 }), { minLength: 1, maxLength: 8 }),
				// Whisper always pads 30 s; any total of at least one 400-sample window reflects the same way
				fc.integer({ min: 401, max: 1200 }),
				(n, chunks, pad) => {
					const a = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) * 0.3 + ((i * 7919) % 13) / 100);
					const padded = new Float32Array(n + pad);
					padded.set(a);
					const batch = logMel(padded, 80);
					// batch logMel normalises in place; recover raw log10 via the max-free path of the stream
					const rows: Float32Array[] = [];
					const st = new LogMelStream(80, (row) => rows.push(Float32Array.from(row)));
					let o = 0;
					let k = 0;
					while (o < n) {
						const c = chunks[k++ % chunks.length]!;
						st.push(a.subarray(o, Math.min(n, o + c)));
						o += c;
					}
					const end = st.end(pad);
					if (end.frames !== batch.frames || rows.length !== batch.frames) return false;
					const raw = new Float32Array(end.frames * 80);
					rows.forEach((r, f) => raw.set(r, f * 80));
					const win = new Float32Array(80 * Math.max(1, end.frames));
					windowFromRaw(raw, end.frames, 80, end.max, win, Math.max(1, end.frames));
					for (let m = 0; m < 80; m++)
						for (let f = 0; f < end.frames; f++)
							if (Math.abs(win[m * Math.max(1, end.frames) + f]! - batch.data[m * batch.frames + f]!) > 1e-6) return false;
					return true;
				},
			),
			{ numRuns: 60 },
		);
	});

	it('a spectrogram over the memory budget moves to a scratch file and reads back the same windows', () => {
		const a = Float32Array.from({ length: s(40) }, (_, i) => Math.sin(i * 0.05) * (i % 16000 < 8000 ? 0.3 : 0.001));
		const mem = inputFromSamples(a, 80);
		const scratch = mkdtempSync(join(tmpdir(), 'jasper-mel-'));
		const b = new InputBuilder(80, { scratch, memoryBytes: 80 * 4 * 500 });
		for (let i = 0; i < a.length; i += 7777) b.push(a.subarray(i, Math.min(a.length, i + 7777)));
		const disk = b.finish();
		expect(disk.mel.onDisk).toBe(true);
		expect(mem.mel.onDisk).toBe(false);
		expect(disk.mel.frames).toBe(mem.mel.frames);
		expect(disk.mel.max).toBe(mem.mel.max);
		expect(Array.from(disk.db)).toEqual(Array.from(mem.db));
		const w1 = new Float32Array(80 * 3000);
		const w2 = new Float32Array(80 * 3000);
		for (const seek of [0, 1234, 2999]) {
			mem.mel.window(seek, 3000, w1, 3000);
			disk.mel.window(seek, 3000, w2, 3000);
			expect(w2).toEqual(w1);
		}
		disk.dispose();
		mem.dispose();
		expect(new MelFrames(80, () => scratch).frames).toBe(0);
	});
});
