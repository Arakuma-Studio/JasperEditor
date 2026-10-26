// Whisper front-end and post-processing tests include cases ported from FilmCraft.
import { describe, expect, it } from 'vitest';
import { addWordTimestamps, alignTokens, mergePunctuations, wordTimings } from '../src/speech/core/align.ts';
import {
	applyFilters,
	compressionRatio,
	mulberry32,
	parseSegments,
	pickToken,
	repeating,
} from '../src/speech/core/decode.ts';
import { DEFAULT_DIARIZE, diarize, diarizeChunks } from '../src/speech/core/diarize.ts';
import { hzToMel, logMel, melFilters, melToHz, powerSpectrumFrame } from '../src/speech/core/mel.ts';
import { type TokenizerJson, WhisperTokenizer } from '../src/speech/core/tokenizer.ts';
import {
	endOfVoice,
	extendWordsIntoSpeech,
	frameDb,
	splitAtPauses,
	tightenWords,
	vadThreshold,
} from '../src/speech/core/vad.ts';

const SR = 16_000;
const s = (sec: number) => Math.round(sec * SR);

describe('mel front end (FilmCraft mel.rs tests)', () => {
	it('filterbank shape and coverage; Slaney scale', () => {
		const w = melFilters(80);
		expect(w.length).toBe(80 * 201);
		for (let m = 0; m < 80; m++) {
			const row = w.subarray(m * 201, (m + 1) * 201);
			expect(row.every((v) => v >= 0)).toBe(true);
			expect(row.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
		}
		expect(Math.abs(hzToMel(500) - 7.5)).toBeLessThan(1e-9);
		expect(hzToMel(6400)).toBeCloseTo(42, 9);
		expect(melToHz(15)).toBeCloseTo(1000, 9);
		expect(melToHz(42)).toBeCloseTo(6400, 6);
	});

	it('a tone lands in its band', () => {
		const audio = Float32Array.from({ length: SR }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / SR));
		const { frames, data } = logMel(audio, 80);
		expect(frames).toBe(100);
		let peak = 0;
		for (let b = 0; b < 80; b++) if (data[b * frames + 50] > data[peak * frames + 50]) peak = b;
		// Slaney 80-band bank over 0–8 kHz: the centre nearest 1 kHz is band 26.
		expect(peak).toBe(26);
	});

	it('the 400-point Whisper FFT equals a direct DFT over 201 bins', () => {
		const rand = mulberry32(7);
		const x = Float64Array.from({ length: 400 }, () => rand() * 2 - 1);
		const got = new Float64Array(201);
		powerSpectrumFrame(x, got);
		for (let k = 0; k < 201; k += 13) {
			let re = 0;
			let im = 0;
			for (let i = 0; i < 400; i++) {
				re += x[i] * Math.cos((2 * Math.PI * k * i) / 400);
				im -= x[i] * Math.sin((2 * Math.PI * k * i) / 400);
			}
			expect(got[k]).toBeCloseTo(re * re + im * im, 6);
		}
	});
});

describe('VAD word bounds (FilmCraft vad.rs test + additions)', () => {
	/** 0.0–0.5 silence, 0.5–1.0 tone, 1.0–2.0 silence, 2.0–2.5 tone (FilmCraft's fixture). */
	function fixture(): Float32Array {
		const a = Float32Array.from({ length: 40_000 }, (_, i) => (i % 2 === 0 ? 0.0001 : 0));
		for (let i = 8_000; i < 16_000; i++) a[i] = 0.3 * Math.sin(i * 0.2);
		for (let i = 32_000; i < 40_000; i++) a[i] = 0.3 * Math.sin(i * 0.2);
		return a;
	}

	it('silence is trimmed from words', () => {
		const w = [
			{ start: s(0), end: s(2) },
			{ start: s(2), end: s(2.5) },
		];
		tightenWords(fixture(), w);
		expect(w[0]).toEqual({ start: s(0.5), end: s(1) });
		expect(w[1]).toEqual({ start: s(2), end: s(2.5) });
	});

	it('threshold: 30 % from floor to speech, at least 6 dB above the floor; digital silence ignored', () => {
		const db = [...Array(90).fill(-60), ...Array(10).fill(-20), ...Array(50).fill(-150)];
		expect(vadThreshold(db)).toBeCloseTo(-60 + 0.3 * 40, 6);
		expect(vadThreshold([...Array(95).fill(-50), ...Array(5).fill(-47)])).toBeCloseTo(-44, 6);
		expect(vadThreshold([])).toBe(-60);
	});

	it('a word keeps at least 60 ms and unvoiced words are left alone', () => {
		const a = fixture();
		const short = [{ start: s(0.1), end: s(0.15) }];
		tightenWords(a, short);
		expect(short[0]).toEqual({ start: s(0.1), end: s(0.15) });
		const silent = [{ start: s(1.1), end: s(1.9) }];
		tightenWords(a, silent);
		expect(silent[0]).toEqual({ start: s(1.1), end: s(1.9) });
		const voiced = [{ start: s(0.3), end: s(0.62) }];
		tightenWords(a, voiced);
		expect(voiced[0].end - voiced[0].start).toBeGreaterThanOrEqual(s(0.06));
	});

	it('extends early-ending / late-starting words into the voice beside a pause, never into a neighbour', () => {
		const a = fixture();
		const w = [
			{ start: s(0.6), end: s(0.85) },
			{ start: s(2.1), end: s(2.5) },
		];
		extendWordsIntoSpeech(a, w);
		expect(w[0]).toEqual({ start: s(0.5), end: s(1) });
		expect(w[1].start).toBe(s(2));
		const tight = [
			{ start: s(0.6), end: s(0.7) },
			{ start: s(0.75), end: s(0.9) },
		];
		extendWordsIntoSpeech(a, tight);
		expect(tight[0].end).toBeLessThanOrEqual(tight[1].start);
	});

	it('repairs a word straddling a pause; a word in silence snaps onto voice only closer than a pause (SG-011)', () => {
		const a = fixture();
		const w = [
			{ start: s(0.5), end: s(0.9) },
			{ start: s(0.9), end: s(2.3) },
		];
		splitAtPauses(a, w);
		expect(w[1].start).toBe(s(2));
		expect(w[0].end).toBeGreaterThanOrEqual(s(0.98));
		// 400 ms into the pause: never moved across the silence onto speech — reported for dropping
		const orphan = [
			{ start: s(0.5), end: s(0.7) },
			{ start: s(1.4), end: s(1.4) },
			{ start: s(2.0), end: s(2.5) },
		];
		expect(splitAtPauses(a, orphan)).toEqual([1]);
		expect(orphan[1]).toEqual({ start: s(1.4), end: s(1.4) });
		expect(orphan[0]).toEqual({ start: s(0.5), end: s(0.7) });
		// 100 ms after the voice that no word covers: alignment jitter, snapped onto it
		const jitter = [
			{ start: s(0.5), end: s(0.7) },
			{ start: s(1.1), end: s(1.15) },
			{ start: s(2.0), end: s(2.5) },
		];
		expect(splitAtPauses(a, jitter)).toEqual([]);
		expect(jitter[1].start).toBeGreaterThanOrEqual(s(0.7));
		expect(jitter[1].end).toBe(s(1.0));
	});

	it('endOfVoice stops at the first silent frame or the limit', () => {
		const db = frameDb(fixture());
		const th = vadThreshold(db);
		expect(endOfVoice(db, th, 60, 300)).toBe(100);
		expect(endOfVoice(db, th, 60, 80)).toBe(80);
		expect(endOfVoice(db, th, 120, 300)).toBe(120);
	});
});

describe('speaker labelling (FilmCraft diarize.rs tests + count hint)', () => {
	/** A synthetic "voice": a pulse train at f0 through two formants, with a syllable envelope. */
	function voice(f0: number, formants: [number, number][], secs: number, seed: number): Float32Array {
		const n = Math.floor(secs * SR);
		const out = new Float32Array(n);
		let phase = 0;
		const st = [
			[0, 0],
			[0, 0],
		];
		let rng = seed >>> 0;
		for (let i = 0; i < n; i++) {
			const t = i / SR;
			const jitter = 1 + 0.03 * Math.sin(2 * Math.PI * 5 * t);
			phase += (f0 * jitter) / SR;
			let x = 0;
			if (phase >= 1) {
				phase -= 1;
				x = 1;
			}
			rng = (Math.imul(rng, 1_664_525) + 1_013_904_223) >>> 0;
			x += ((rng >>> 8) / (1 << 24) - 0.5) * 0.02;
			let y = 0;
			formants.forEach(([fc, bw], k) => {
				const r = Math.exp((-Math.PI * bw) / SR);
				const a1 = 2 * r * Math.cos((2 * Math.PI * fc) / SR);
				const a2 = -r * r;
				const v = x + a1 * st[k][0] + a2 * st[k][1];
				st[k][1] = st[k][0];
				st[k][0] = v;
				y += v;
			});
			const env = Math.max(0, Math.sin(Math.PI * ((t * 4) % 1)));
			out[i] = y * env * 0.05;
		}
		return out;
	}

	function dialogue(turns: boolean[]) {
		const parts: Float32Array[] = [];
		const words: { start: number; end: number }[] = [];
		let len = 0;
		turns.forEach((isA, k) => {
			const t0 = len;
			const v = isA
				? voice(
						110,
						[
							[600, 90],
							[1100, 120],
						],
						2,
						k,
					)
				: voice(
						230,
						[
							[400, 80],
							[2600, 150],
						],
						2,
						k,
					);
			parts.push(v);
			len += v.length;
			for (let w = 0; w < 4; w++) words.push({ start: t0 + s(w * 0.5), end: t0 + s(w * 0.5 + 0.45) });
			parts.push(new Float32Array(8000));
			len += 8000;
		});
		const audio = new Float32Array(len);
		let o = 0;
		for (const p of parts) {
			audio.set(p, o);
			o += p.length;
		}
		return { audio, words };
	}

	it('two synthetic voices are told apart', () => {
		const turns = [true, false, true, true, false, false, true, false];
		const { audio, words } = dialogue(turns);
		const r = diarize(audio, words, DEFAULT_DIARIZE);
		expect(r.speakers).toBe(2);
		turns.forEach((isA, k) => {
			for (let i = k * 4; i < k * 4 + 4; i++) expect(r.labels[i]).toBe(isA ? 0 : 1);
		});
	});

	it('one voice is one speaker', () => {
		const audio = voice(
			140,
			[
				[500, 90],
				[1500, 120],
			],
			12,
			1,
		);
		const words = Array.from({ length: 20 }, (_, i) => ({ start: s(i * 0.6), end: s(i * 0.6 + 0.4) }));
		const r = diarize(audio, words, DEFAULT_DIARIZE);
		expect(r.speakers).toBe(1);
		expect(r.labels.every((l) => l === 0)).toBe(true);
	});

	it('chunks split at pauses and join short ones', () => {
		const w = (a: number, b: number) => ({ start: s(a), end: s(b) });
		const words = [w(0, 0.5), w(0.5, 1), w(2, 2.2), w(3, 3.6), w(3.6, 4.4)];
		expect(diarizeChunks(words, DEFAULT_DIARIZE)).toEqual([
			{ start: 0, end: 3 },
			{ start: 3, end: 5 },
		]);
	});

	it('a speaker-count hint forces exactly that many speakers', () => {
		const turns = [true, false, true, false, true, false];
		const { audio, words } = dialogue(turns);
		expect(diarize(audio, words, { ...DEFAULT_DIARIZE, speakerCount: 1 }).speakers).toBe(1);
		expect(diarize(audio, words, { ...DEFAULT_DIARIZE, speakerCount: 3 }).speakers).toBe(3);
		const two = diarize(audio, words, { ...DEFAULT_DIARIZE, speakerCount: 2, threshold: 1e9 });
		expect(two.speakers).toBe(2);
		turns.forEach((isA, k) => {
			for (let i = k * 4; i < k * 4 + 4; i++) expect(two.labels[i]).toBe(isA ? 0 : 1);
		});
	});
});

describe('alignment (FilmCraft align.rs tests + OpenAI heuristics)', () => {
	it('alignTokens finds where each token attends', () => {
		// 2 prompt rows + 3 text tokens + eot, 30 frames; token i attends frames [i·8, i·8+8)
		const T = 6;
		const F = 30;
		const head = new Float32Array(T * F).fill(0.01);
		for (let i = 0; i < 4; i++)
			for (let j = i * 8; j < Math.min(F, i * 8 + 8); j++) head[(2 + i) * F + j] = 1;
		const jump = alignTokens([head], T, F, F, 2, 3, 1);
		expect(jump.slice(0, 4)).toEqual([0, 8, 16, 24]);
	});

	it('word timings, punctuation merging and segment distribution', () => {
		const words = [
			{ word: ' Hello', tokens: [1] },
			{ word: ',', tokens: [2] },
			{ word: ' world', tokens: [3] },
			{ word: '.', tokens: [4] },
		];
		const timing = wordTimings(words, [0, 25, 26, 50, 51], [0.9, 0.8, 0.7, 0.6]);
		expect(timing.map((t) => [t.start, t.end])).toEqual([
			[0, 0.5],
			[0.5, 0.52],
			[0.52, 1],
			[1, 1.02],
		]);
		mergePunctuations(timing);
		expect(timing.map((t) => t.word)).toEqual([' Hello,', '', ' world.', '']);
		const seg = [{ start: 3, end: 4, textTokens: [1, 2, 3, 4], words: [] }];
		addWordTimestamps(seg, wordTimings(words, [0, 25, 26, 50, 51], [1, 1, 1, 1]), 3, 0);
		expect(seg[0].words.map((w: { word: string }) => w.word)).toEqual([' Hello,', ' world.']);
		expect((seg[0].words[0] as { start: number }).start).toBeGreaterThanOrEqual(3);
	});
});

describe('decoding rules', () => {
	const vocab: Record<string, number> = { a: 0, b: 1, Ġc: 2 };
	const specials = [
		'<|endoftext|>',
		'<|startoftranscript|>',
		'<|en|>',
		'<|de|>',
		'<|translate|>',
		'<|transcribe|>',
		'<|startoflm|>',
		'<|startofprev|>',
		'<|nospeech|>',
		'<|notimestamps|>',
	];
	const added = specials.map((content, i) => ({ id: 3 + i, content }));
	for (let k = 0; k < 20; k++) added.push({ id: 13 + k, content: `<|${(k * 0.02).toFixed(2)}|>` });
	const json = { model: { vocab }, added_tokens: added } as TokenizerJson;
	const tok = new WhisperTokenizer(json);
	const tb = tok.timestampBegin;

	it('reads specials, languages and bytes', () => {
		expect(tok.eot).toBe(3);
		expect(tb).toBe(13);
		expect(tok.languages.map((l) => l[0])).toEqual(['en', 'de']);
		expect(tok.decode([0, 1, 2])).toBe('ab c');
		expect(new WhisperTokenizer(json, false).multilingual).toBe(false);
		expect(tok.splitToWordTokens([0, 1, 2], 'en').map((w) => w.word)).toEqual(['ab', ' c']);
	});

	it('timestamp rules: first token a timestamp ≤ max initial, monotonic, pairs', () => {
		const cfg = {
			suppress: tok.nonTextSpecials(),
			beginSuppress: [tok.eot],
			maxInitialTimestampIndex: 5,
			timestamps: true,
		};
		const l0 = new Float32Array(33).fill(0);
		l0[0] = 10;
		applyFilters(l0, [], tok, cfg);
		for (let i = 0; i < tb; i++) expect(l0[i]).toBe(Number.NEGATIVE_INFINITY);
		expect(l0[tb + 6]).toBe(Number.NEGATIVE_INFINITY);
		expect(l0[tb + 5]).toBe(0);
		const l1 = new Float32Array(33).fill(0);
		applyFilters(l1, [tb + 2, 0], tok, cfg);
		expect(l1[tb + 1]).toBe(Number.NEGATIVE_INFINITY);
		const l2 = new Float32Array(33).fill(0);
		applyFilters(l2, [tb + 2, 0, tb + 4], tok, cfg);
		for (let i = 0; i < tok.eot; i++) expect(l2[i]).toBe(Number.NEGATIVE_INFINITY);
	});

	it('segments and seek', () => {
		const p = parseSegments([tb + 0, 0, 1, tb + 5, tb + 5, 2, tb + 9], tok, 3000);
		expect(p.segments.map((x) => [x.start, x.end])).toEqual([
			[0, 0.1],
			[0.1, 0.18],
		]);
		expect(p.singleTimestampEnding).toBe(true);
		expect(p.seekFrames).toBe(3000);
		const q = parseSegments([tb + 0, 0, tb + 5, tb + 5, 1], tok, 3000);
		expect(q.seekFrames).toBe(10);
	});

	it('repetition guard, compression ratio, seeded sampling', () => {
		expect(repeating(Array(12).fill(5), 1000)).toBe(true);
		expect(repeating([5, 5, 5, 6, 7, 8], 1000)).toBe(false);
		expect(repeating([1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3], 1000)).toBe(true);
		expect(compressionRatio('the cat '.repeat(40))).toBeGreaterThan(2.4);
		expect(compressionRatio('The quick brown fox jumps over the lazy dog.')).toBeLessThan(2.4);
		const l = Float32Array.from([0, 1, 2, 0.5]);
		expect(pickToken(l, 0, mulberry32(1))).toBe(2);
		const a = Array.from({ length: 20 }, (_, i) => pickToken(l, 1, mulberry32(i)));
		const b = Array.from({ length: 20 }, (_, i) => pickToken(l, 1, mulberry32(i)));
		expect(a).toEqual(b);
		expect(new Set(a).size).toBeGreaterThan(1);
	});
});
