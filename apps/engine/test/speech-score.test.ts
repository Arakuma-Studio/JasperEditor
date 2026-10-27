// Spec 17 SC-032 / SC-035 / SC-036 / SC-040 / SC-074 / SC-075 / SC-103 (fake ONNX Runtime): teacher-forced scoring
// in the worker (math incl. end of text, per-word tokens, batching, encoder reuse, refusals, cancellation, GPU →
// CPU retry, forced word times) and glossary prompting of transcription (prompt composition and cap, guard).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	composePrompt,
	glossaryText,
	glossaryTokens,
	normalizeGlossary,
	repeatedGlossaryTerm,
} from '../src/speech/core/glossary.ts';
import { runScoreJob } from '../src/speech/worker/score.ts';
import { SpeechRefusal, WhisperModel } from '../src/speech/worker/whisper.ts';
import { EOT, fakeModelDir, fakeOrt, noiseAudio, SPACE, TS_BEGIN, VOCAB } from './speech-fake-ort.ts';

const SOT = 27;
const SOT_PREV = 29;
const NO_TS = 31;
const SR = 16_000;
/** Letters → token ids of the fake vocabulary ('a' = 0 …). */
const ids = (w: string) => [SPACE, ...[...w].map((c) => c.charCodeAt(0) - 97)];
/** log Σ exp of the fake decoder's default row (−5 everywhere, eot 2, <|0.00|> 5): the full vocabulary. */
const LSE = 5 + Math.log((VOCAB - 2) * Math.exp(-10) + Math.exp(-3) + 1);

function spec(
	dir: string,
	windows: Array<{ id: string; start: number; end: number; readings: Array<{ id: string; words: string[] }> }>,
	extra: Record<string, unknown> = {},
) {
	return { modelDir: dir, modelId: 'fake', input: { f32: '' }, language: 'en', windows, ...extra };
}

const audio = noiseAudio(40);

describe('scoring readings (SC-032)', () => {
	it('LL = Σ full-vocabulary log-softmax of every text token and eot; [sot, notimestamps] + words + [eot], no prompt', async () => {
		const dir = fakeModelDir({ encodable: true });
		const seen: number[][] = [];
		const f = fakeOrt({ logits: (h) => (h.length && h[0] === SOT ? seen.push([...h]) : undefined) });
		const out = await runScoreJob(
			spec(dir, [{ id: 'w', start: 0, end: 5 * SR, readings: [{ id: 'r0', words: ['ab'] }] }]),
			{ ort: f.ort, audio },
		);
		const r = out.windows[0]!.readings[0]!;
		// 3 text tokens at the default logit −5, eot at 2: the timestamps count in the normaliser (full vocabulary)
		expect(r.tokens).toBe(4);
		expect(r.logprob).toBeCloseTo(3 * (-5 - LSE) + (2 - LSE), 4);
		expect(r.words).toHaveLength(1);
		expect(r.words[0]).toMatchObject({ text: 'ab', tokens: 3 });
		expect(r.words[0]!.logprob).toBeCloseTo(3 * (-5 - LSE), 4);
		expect(r.words[0]!.probability).toBeCloseTo(Math.exp(-5 - LSE), 6);
		// the decoder input of the one uncached pass (English-only model: no language/task tokens)
		const longest = seen.reduce((a, b) => (b.length > a.length ? b : a), [] as number[]);
		expect(longest).toEqual([SOT, NO_TS, ...ids('ab'), EOT]);
		expect(seen.some((h) => h.includes(SOT_PREV))).toBe(false);
		// one encoder pass, one decoder pass
		const runs = f.sessions.map((s) => s.runs.length);
		expect(runs).toEqual([1, 1]);
		expect(f.sessions[1]!.runs[0]!.cached).toBe(false);
	});

	it('row p − 1 predicts token p: context-dependent logits give per-word tokens and log-probabilities', async () => {
		const dir = fakeModelDir({ encodable: true });
		// the token after x is likely x + 1 (and eot after 'e')
		const logits = (h: readonly number[], row: Float32Array) => {
			const last = h[h.length - 1]!;
			if (last < 25) row[last + 1] = 4;
			if (last === 4) row[EOT] = 6;
		};
		const out = await runScoreJob(
			spec(dir, [{ id: 'w', start: 0, end: 5 * SR, readings: [{ id: 'r', words: ['ab', 'cde'] }] }]),
			{ ort: fakeOrt({ logits }).ort, audio },
		);
		const r = out.windows[0]!.readings[0]!;
		// expected, computed from the same rule independently of the worker
		const row = (prev: number) => {
			const x = new Float32Array(VOCAB).fill(-5);
			x[EOT] = 2;
			x[TS_BEGIN] = 5;
			logits([prev], x);
			let m = -Infinity;
			for (const v of x) m = Math.max(m, v);
			let s = 0;
			for (const v of x) s += Math.exp(v - m);
			return { x, lse: m + Math.log(s) };
		};
		const seq = [SOT, NO_TS, ...ids('ab'), ...ids('cde'), EOT];
		const lp: number[] = [];
		for (let p = 2; p < seq.length; p++) {
			const { x, lse } = row(seq[p - 1]!);
			lp.push(x[seq[p]!]! - lse);
		}
		expect(r.words.map((w) => w.tokens)).toEqual([3, 4]);
		expect(r.words[0]!.logprob).toBeCloseTo(lp[0]! + lp[1]! + lp[2]!, 4);
		expect(r.words[1]!.logprob).toBeCloseTo(lp[3]! + lp[4]! + lp[5]! + lp[6]!, 4);
		expect(r.logprob).toBeCloseTo(
			lp.reduce((a, b) => a + b, 0),
			4,
		);
		// eot after 'e' is likely: its term is in the sum, not in any word
		expect(lp[7]).toBeGreaterThan(-1);
		expect(r.logprob - r.words[0]!.logprob - r.words[1]!.logprob).toBeCloseTo(lp[7]!, 4);
	});

	it('batching gives the same scores as one reading per pass (right padding with eot)', async () => {
		const dir = fakeModelDir({ encodable: true });
		const logits = (h: readonly number[], row: Float32Array) => {
			const last = h[h.length - 1]!;
			row[(last * 7 + h.length) % 26] = 3;
		};
		const readings = [
			{ id: 'a', words: ['hello', 'there'] },
			{ id: 'b', words: ['hallo'] },
			{ id: 'c', words: ['he', 'lot', 'there', 'now'] },
		];
		const w = [{ id: 'w', start: SR, end: 9 * SR, readings }];
		const f1 = fakeOrt({ logits });
		const one = await runScoreJob(spec(dir, w, { batch: 1 }), { ort: f1.ort, audio });
		const f8 = fakeOrt({ logits });
		const all = await runScoreJob(spec(dir, w, { batch: 8 }), { ort: f8.ort, audio });
		expect(f1.sessions[1]!.runs).toHaveLength(3);
		expect(f8.sessions[1]!.runs).toHaveLength(1);
		expect(all.profile.decoderRuns).toBe(1);
		for (let i = 0; i < 3; i++) {
			const a = one.windows[0]!.readings[i]!;
			const b = all.windows[0]!.readings[i]!;
			expect(b.id).toBe(readings[i]!.id);
			expect(b.tokens).toBe(a.tokens);
			expect(b.logprob).toBeCloseTo(a.logprob, 5);
			expect(b.words.map((x) => x.logprob)).toEqual(a.words.map((x) => expect.closeTo(x.logprob, 5)));
			expect(b.words.map((x) => [x.start, x.end])).toEqual(a.words.map((x) => [x.start, x.end]));
		}
	});

	it('one encoder pass per distinct window; results keep the request order', async () => {
		const dir = fakeModelDir({ encodable: true });
		const f = fakeOrt();
		const out = await runScoreJob(
			spec(dir, [
				{ id: 'late', start: 20 * SR, end: 25 * SR, readings: [{ id: 'x', words: ['ab'] }] },
				{ id: 'early-1', start: 2 * SR, end: 8 * SR, readings: [{ id: 'y', words: ['cd'] }] },
				{ id: 'early-2', start: 2 * SR, end: 8 * SR, readings: [{ id: 'z', words: ['ef'] }] },
			]),
			{ ort: f.ort, audio },
		);
		expect(out.windows.map((w) => w.id)).toEqual(['late', 'early-1', 'early-2']);
		expect(out.profile.encoderPasses).toBe(2);
		const enc = f.sessions.find((s) => s.path.includes('encoder'))!;
		expect(enc.runs).toHaveLength(2);
		expect(out.profile.readings).toBe(3);
		expect(out.windows[0]!.readings[0]!.words[0]!.start).toBeGreaterThanOrEqual(20 * SR);
	});

	it('forced word times come from the same pass (cross-attention DTW), in samples of the media', async () => {
		const dir = fakeModelDir({ encodable: true });
		// the row at history length L attends to frames [50 (L − 2), 50 (L − 1)): 1 s per token from the
		// <|notimestamps|> row on
		const cross = (h: readonly number[], row: Float32Array) => {
			row.fill(1e-6);
			const a = 50 * (h.length - 2);
			for (let j = Math.max(0, a); j < Math.min(1500, a + 50); j++) row[j] = 1;
		};
		const out = await runScoreJob(
			spec(dir, [{ id: 'w', start: 2 * SR, end: 12 * SR, readings: [{ id: 'r', words: ['ab', 'cde'] }] }]),
			// voice exactly where the words are, so the refinement (growth into voice, tightening) keeps the DTW bounds
			{ ort: fakeOrt({ cross }).ort, audio: noiseAudio(40, (t) => t >= 2 && t < 9) },
		);
		const [w0, w1] = out.windows[0]!.readings[0]!.words;
		// word 0 = tokens 0..2 → rows 0..2 → 0–3 s of the window; word 1 = tokens 3..6 → 3–7 s
		const near = (samples: number, sec: number) => expect(Math.abs(samples / SR - sec)).toBeLessThanOrEqual(0.05);
		near(w0!.start, 2);
		near(w0!.end, 5);
		near(w1!.start, 5);
		near(w1!.end, 9);
	});
});

describe('refusals, cancellation and devices (SC-032, SC-035, SC-036)', () => {
	const one = [{ id: 'w', start: 0, end: 5 * SR, readings: [{ id: 'r', words: ['ab'] }] }];

	it('refuses with codes: tokenizer cannot encode, reading too long, window outside the audio, language, bad spec', async () => {
		const refusal = async (p: Promise<unknown>, code: string) => {
			const e = await p.then(
				() => null,
				(x: unknown) => x,
			);
			expect(e).toBeInstanceOf(SpeechRefusal);
			expect((e as SpeechRefusal).code).toBe(code);
		};
		const plain = fakeModelDir();
		await refusal(runScoreJob(spec(plain, one), { ort: fakeOrt().ort, audio }), 'SPEECH_TOKENIZER_CANNOT_ENCODE');
		const dir = fakeModelDir({ encodable: true });
		const long = Array.from({ length: 60 }, () => 'abcdefgh');
		await refusal(
			runScoreJob(spec(dir, [{ ...one[0]!, readings: [{ id: 'r', words: long }] }]), { ort: fakeOrt().ort, audio }),
			'SPEECH_READING_TOO_LONG',
		);
		await refusal(
			runScoreJob(spec(dir, [{ ...one[0]!, start: 50 * SR, end: 55 * SR }]), { ort: fakeOrt().ort, audio }),
			'SPEECH_WINDOW_OUT_OF_RANGE',
		);
		await refusal(
			runScoreJob(spec(dir, one, { language: 'es' }), { ort: fakeOrt().ort, audio }),
			'SPEECH_LANGUAGE_UNSUPPORTED',
		);
		await refusal(
			runScoreJob(spec(dir, [{ ...one[0]!, end: 31 * SR }]), { ort: fakeOrt().ort, audio }),
			'INVALID_SPEC',
		);
		await refusal(runScoreJob(spec(dir, []), { ort: fakeOrt().ort, audio }), 'INVALID_SPEC');
		// a refusal on the GPU is not retried on the CPU
		const f = fakeOrt();
		await refusal(
			runScoreJob(spec(dir, [{ ...one[0]!, readings: [{ id: 'r', words: long }] }], {
				device: { encoder: 'cuda', decoder: 'cpu' },
			}), { ort: f.ort, audio }),
			'SPEECH_READING_TOO_LONG',
		);
		expect(f.sessions.filter((s) => s.path.includes('encoder'))).toHaveLength(1);
	});

	it('cancellation between windows stops the job', async () => {
		const dir = fakeModelDir({ encodable: true });
		const ac = new AbortController();
		const f = fakeOrt();
		const windows = Array.from({ length: 6 }, (_, i) => ({
			id: `w${i}`,
			start: i * 5 * SR,
			end: (i + 1) * 5 * SR,
			readings: [{ id: 'r', words: ['ab'] }],
		}));
		const p = runScoreJob(spec(dir, windows), {
			ort: f.ort,
			audio,
			signal: ac.signal,
			onProgress: (_, stage) => {
				if (stage.startsWith('Scoring 2/')) ac.abort();
			},
		});
		await expect(p).rejects.toMatchObject({ name: 'CancelledError' });
		expect(f.sessions.find((s) => s.path.includes('encoder'))!.runs.length).toBeLessThan(4);
	});

	it('a GPU error mid-job scores once more on the CPU and says so; a failed GPU session falls back per session', async () => {
		const dir = fakeModelDir({ encodable: true });
		const f = fakeOrt({ runError: (part, p) => (part === 'decoder' && p === 'cuda' ? 'device lost' : null) });
		const devices: string[] = [];
		const out = await runScoreJob(spec(dir, one, { device: { encoder: 'cuda', decoder: 'cuda' } }), {
			ort: f.ort,
			audio,
			onDevice: (d) => devices.push(`${d.encoder}/${d.decoder}#${d.attempt}`),
		});
		expect(devices).toEqual(['cuda/cuda#1', 'cpu/cpu#2']);
		expect(out.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu' });
		expect(out.device.fallbacks).toEqual([
			{ stage: 'job', part: 'both', from: 'cuda', to: 'cpu', reason: 'device lost' },
		]);
		expect(out.windows[0]!.readings[0]!.tokens).toBe(4);
		const g = fakeOrt({ createError: (part, p) => (part === 'encoder' && p === 'webgpu' ? 'no adapter' : null) });
		const out2 = await runScoreJob(spec(dir, one, { device: { encoder: 'webgpu', decoder: 'cpu' } }), {
			ort: g.ort,
			audio,
		});
		expect(out2.device.fallbacks).toEqual([
			{ stage: 'session', part: 'encoder', from: 'webgpu', to: 'cpu', reason: 'no adapter' },
		]);
		// scoring never calibrates: no greedy steps run
		const h = fakeOrt();
		await runScoreJob(spec(dir, one, { device: { encoder: 'cpu', decoder: 'cpu', calibrate: 'cuda' } }), {
			ort: h.ort,
			audio,
		});
		expect(h.sessions.filter((s) => s.provider === 'cuda')).toHaveLength(0);
	});

	it('a CPU failure fails the job with its message (no retry)', async () => {
		const dir = fakeModelDir({ encodable: true });
		const f = fakeOrt({ runError: (part) => (part === 'decoder' ? 'broken decoder' : null) });
		await expect(runScoreJob(spec(dir, one), { ort: f.ort, audio })).rejects.toThrow('broken decoder');
		expect(f.sessions.filter((s) => s.path.includes('encoder'))).toHaveLength(1);
	});
});

describe('glossary prompts (SC-074) and the prompt guard (SC-075)', () => {
	it('normalises, caps and composes: glossary after the initial prompt, oldest previous text dropped first', () => {
		expect(normalizeGlossary([' NovaPlay  Studio ', 'novaplay studio', '', 'Glimmerbox', 'x'.repeat(80)])).toEqual([
			'NovaPlay Studio',
			'Glimmerbox',
			'x'.repeat(64),
		]);
		expect(normalizeGlossary(Array.from({ length: 50 }, (_, i) => `Term${i}`))).toHaveLength(40);
		expect(glossaryText(['NovaPlay Studio', 'Glimmerbox'])).toBe('NovaPlay Studio, Glimmerbox.');
		// running = [initial 1 2 3 | previous 10 11 12 13], glossary [90 91]
		const running = [1, 2, 3, 10, 11, 12, 13];
		expect(composePrompt(running, 3, [90, 91], 223)).toEqual([1, 2, 3, 90, 91, 10, 11, 12, 13]);
		expect(composePrompt(running, 3, [90, 91], 7)).toEqual([3, 90, 91, 10, 11, 12, 13]);
		expect(composePrompt(running, 3, [90, 91], 5)).toEqual([90, 91, 11, 12, 13]);
		expect(composePrompt(running, 0, [90, 91], 4)).toEqual([90, 91, 12, 13]);
		expect(composePrompt(running, 3, [], 4)).toEqual([10, 11, 12, 13]);
		expect(composePrompt([], 0, [90], 223)).toEqual([90]);
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 99 }), { maxLength: 300 }),
				fc.nat(300),
				fc.array(fc.integer({ min: 100, max: 199 }), { maxLength: 250 }),
				fc.integer({ min: 0, max: 223 }),
				(run, k, g, max) => {
					const p = composePrompt(run, k, g, max);
					if (p.length > max) return false;
					// the glossary (capped) is always whole and contiguous
					const gg = g.slice(0, max);
					const at = p.findIndex((t) => t >= 100);
					return gg.length === 0 || (at >= 0 && p.slice(at, at + gg.length).join() === gg.join());
				},
			),
		);
	});

	it('keeps whole terms within the token budget', () => {
		const enc = (t: string) => [...t].map((c) => c.charCodeAt(0));
		const r = glossaryTokens(['aaaa', 'bbbbbbbbbbbb', 'cc'], enc, 12);
		expect(r.terms).toEqual(['aaaa', 'cc']);
		expect(r.tokens).toEqual(enc(' aaaa, cc.'));
		expect(glossaryTokens(['aaaa'], enc, 0)).toEqual({ terms: [], tokens: [] });
	});

	it('the guard finds a term repeated 3 times within 10 s (split or glued spellings too)', () => {
		const w = (word: string, start: number) => ({ word, start });
		expect(
			repeatedGlossaryTerm([w(' Nova', 1), w(' Play', 1.3), w(' NovaPlay', 4), w(',', 4.2), w(' nova-play', 9)], [
				'NovaPlay',
			]),
		).toBe('NovaPlay');
		expect(repeatedGlossaryTerm([w(' NovaPlay', 1), w(' NovaPlay', 4), w(' NovaPlay', 12)], ['NovaPlay'])).toBeNull();
		expect(repeatedGlossaryTerm([w(' NovaPlay', 1), w(' NovaPlay', 4)], ['NovaPlay'])).toBeNull();
		expect(repeatedGlossaryTerm([w(' Nova', 1), w(' Nova', 2), w(' Nova', 3)], ['NovaPlay'])).toBeNull();
	});

	/** A scripted decoder: after `<|startoftranscript|>` it writes `prompted` when the prompt holds `gloss`, else `plain`. */
	function scripted(gloss: number[], prompted: string, plain: string) {
		const prompts: number[][] = [];
		const logits = (h: readonly number[], row: Float32Array) => {
			const sot = h.lastIndexOf(SOT);
			if (sot < 0 || h[sot + 1] === NO_TS) return;
			const prompt = h[0] === SOT_PREV ? h.slice(1, sot) : [];
			const gen = h.slice(sot + 1);
			if (!gen.length) prompts.push(prompt);
			const has = gloss.length > 0 && prompt.join(',').includes(gloss.join(','));
			const words = (has ? prompted : plain).split(' ');
			const target = [TS_BEGIN, ...words.flatMap((x) => ids(x)), TS_BEGIN + 100];
			row.fill(-20);
			row[gen.length < target.length ? target[gen.length]! : EOT] = 20;
		};
		return { logits, prompts };
	}

	async function transcribe(logits: (h: readonly number[], r: Float32Array) => void, glossary?: string[]) {
		const dir = fakeModelDir({ encodable: true });
		const model = await WhisperModel.load(dir, { ort: fakeOrt({ logits }).ort });
		try {
			return await model.transcribe(noiseAudio(8), { language: 'en', ...(glossary ? { glossary } : {}) });
		} finally {
			await model.release();
		}
	}

	it('carries the glossary into the window prompt and reports it', async () => {
		const s = scripted(ids('nova').slice(1), 'hello there', 'hello');
		const r = await transcribe(s.logits, ['nova']);
		expect(s.prompts[0]).toEqual([...ids('nova')]);
		expect(r.words.map((w) => w.text)).toEqual(['hello', 'there']);
		expect(r.guard.glossary).toEqual({ terms: 1, tokens: 5, events: 0, replaced: 0 });
		const none = await transcribe(scripted([], 'x', 'hello').logits);
		expect(none.guard.glossary).toBeNull();
	});

	it('a term repeated 3× within 10 s → the window is decoded without the glossary; the unprompted text is kept when it differs', async () => {
		const term = ids('nova').slice(1);
		const s = scripted(term, 'nova nova nova', 'hello');
		const r = await transcribe(s.logits, ['nova']);
		expect(r.guard.glossary).toEqual({ terms: 1, tokens: 5, events: 1, replaced: 1 });
		expect(r.words.map((w) => w.text)).toEqual(['hello']);
		// the re-decode had no glossary in its prompt
		expect(s.prompts).toEqual([[...ids('nova')], []]);
		// the same text without the glossary: kept as decoded, counted as an event only
		const same = await transcribe(scripted(term, 'nova nova nova', 'nova nova nova').logits, ['nova']);
		expect(same.guard.glossary).toEqual({ terms: 1, tokens: 5, events: 1, replaced: 0 });
		expect(same.words.map((w) => w.text)).toEqual(['nova', 'nova', 'nova']);
	});
});
