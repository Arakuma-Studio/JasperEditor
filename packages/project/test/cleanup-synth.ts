// Synthetic speech recordings for the transcript cleanup tests (spec 14 TC-070): no TTS and no recorded speech —
// every word is a voiced harmonic tone (f0 110–170 Hz, 8 harmonics, 20 ms attack, ≈ 70 ms decay) whose length follows
// its letters, over a white-noise room floor (≈ −64 dBFS); breaths are louder noise bursts; a cough is a short voiced
// blip with no word. The recording comes with Whisper-like word timestamps (start −40…+60 ms, end −50…+80 ms off the
// true sound) and the ground truth of what an editor keeps. Its voice analysis is the real one (`voiceFeatures` +
// `buildVoiceAnalysis`, the engine job's code).
import { voiceFeatures } from '@jasper/audio-dsp';
import { buildVoiceAnalysis, type VoiceAnalysis } from '../src/cleanup/voice-analysis.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';

const SR = 16_000;

export type SynthEvent =
	| { say: string; keep: boolean; gapS?: number }
	| { pauseS: number }
	| { breathS: number }
	| { coughS: number };

export type SynthWord = {
	text: string;
	/** True sound span (s). */
	s: number;
	e: number;
	/** Reported (Whisper-like) timestamps, flicks. */
	start: number;
	end: number;
	keep: boolean;
	confidence: number;
};

export type SynthRecording = {
	words: SynthWord[];
	voice: VoiceAnalysis;
	durationS: number;
	/** Voiced spans with no word (s). */
	coughs: Array<[number, number]>;
};

/** mulberry32 */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function tone(out: Float32Array, at: number, dur: number, f0: number, amp: number) {
	const a0 = Math.round(at * SR);
	const n = Math.round(dur * SR);
	const attack = 0.02 * SR;
	const decay = 0.07 * SR;
	for (let i = 0; i < n + decay * 3 && a0 + i < out.length; i++) {
		const t = i / SR;
		let env: number;
		if (i < attack) env = i / attack;
		else if (i < n) env = 1;
		else env = Math.exp(-(i - n) / decay);
		if (i >= n && env < 1e-4) break;
		const f = f0 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t));
		let x = 0;
		for (let k = 1; k <= 8; k++) x += Math.sin(2 * Math.PI * f * k * t) / k;
		out[a0 + i]! += amp * env * x * 0.5;
	}
}

function noise(out: Float32Array, at: number, dur: number, amp: number, r: () => number) {
	const a0 = Math.round(at * SR);
	const n = Math.round(dur * SR);
	for (let i = 0; i < n && a0 + i < out.length; i++) {
		const env = Math.min(1, i / (0.03 * SR), (n - i) / (0.03 * SR));
		out[a0 + i]! += amp * env * (r() * 2 - 1);
	}
}

/** Builds a recording from events (see the module comment). */
export function synthRecording(events: readonly SynthEvent[], seed = 1): SynthRecording {
	const r = rng(seed);
	// lay out
	type Laid = { text: string; s: number; e: number; keep: boolean; f0: number };
	const laid: Laid[] = [];
	const coughs: Array<[number, number]> = [];
	const breaths: Array<[number, number]> = [];
	let t = 0.6;
	for (const ev of events) {
		if ('pauseS' in ev) t += ev.pauseS;
		else if ('breathS' in ev) {
			breaths.push([t, t + ev.breathS]);
			t += ev.breathS + 0.12;
		} else if ('coughS' in ev) {
			coughs.push([t, t + ev.coughS]);
			t += ev.coughS + 0.3;
		} else {
			const words = ev.say.split(/\s+/).filter(Boolean);
			const f0 = 110 + r() * 60;
			for (const w of words) {
				const letters = w.replace(/[^\p{L}]/gu, '').length;
				const d = Math.min(0.6, Math.max(0.15, 0.06 + 0.055 * letters));
				laid.push({ text: w, s: t, e: t + d, keep: ev.keep, f0 });
				t += d + (ev.gapS ?? 0.03 + r() * 0.04);
			}
			t += 0.25;
		}
	}
	const durationS = t + 1;
	const samples = new Float32Array(Math.round(durationS * SR));
	for (let i = 0; i < samples.length; i++) samples[i] = 0.0011 * (r() * 2 - 1);
	for (const w of laid) tone(samples, w.s, w.e - w.s, w.f0, 0.12);
	for (const [a, b] of breaths) noise(samples, a, b - a, 0.01, r);
	for (const [a, b] of coughs) tone(samples, a, b - a, 180, 0.1);
	const planes = voiceFeatures(samples);
	const voice = buildVoiceAnalysis({ fingerprint: 'q1:synth', stream: 1, samples: samples.length, planes });
	const fl = (x: number) => Math.max(0, Math.round(x * FLICKS_PER_SECOND));
	const words: SynthWord[] = laid.map((w) => ({
		text: w.text,
		s: w.s,
		e: w.e,
		start: fl(w.s + (r() * 0.1 - 0.04)),
		end: fl(w.e + (r() * 0.13 - 0.05)),
		keep: w.keep,
		confidence: 0.6 + r() * 0.4,
	}));
	// reported words never overlap (the speech worker normalises them)
	for (let i = 1; i < words.length; i++)
		if (words[i]!.start < words[i - 1]!.end) words[i]!.start = words[i - 1]!.end;
	for (const w of words) if (w.end <= w.start) w.end = w.start + 1;
	return { words, voice, durationS, coughs };
}

/** Removal quality of kept pieces (s) against the ground truth, like the prototype's `score`. */
export function scoreKept(rec: SynthRecording, kept: ReadonlyArray<readonly [number, number]>) {
	const keptWords = rec.words.filter((w) => w.keep);
	const lo = Math.min(...keptWords.map((w) => w.s));
	const hi = Math.max(...keptWords.map((w) => w.e));
	const truthKept: Array<[number, number]> = [];
	for (const w of keptWords) {
		const l = truthKept[truthKept.length - 1];
		if (l && w.s - l[1] < 0.12) l[1] = w.e;
		else truthKept.push([w.s, w.e]);
	}
	const inside = (a: number, b: number, set: ReadonlyArray<readonly [number, number]>) =>
		set.reduce((acc, [x, y]) => acc + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
	let tp = 0;
	let autoRemoved = 0;
	let truthRemoved = 0;
	for (const w of rec.words) {
		if (w.s < lo - 1e-9 || w.s > hi + 1e-9) continue;
		const removed = inside(w.s, w.e, kept) / (w.e - w.s) < 0.5;
		if (removed) autoRemoved++;
		if (!w.keep) truthRemoved++;
		if (removed && !w.keep) tp++;
	}
	// time, sampled every 10 ms inside [lo, hi]
	let tTp = 0;
	let tAuto = 0;
	let tTruth = 0;
	for (let x = lo; x < hi; x += 0.01) {
		const a = inside(x, x + 0.01, kept) < 0.005;
		const u = inside(x, x + 0.01, truthKept) < 0.005;
		if (a) tAuto++;
		if (u) tTruth++;
		if (a && u) tTp++;
	}
	return {
		wordPrecision: autoRemoved ? tp / autoRemoved : 1,
		wordRecall: truthRemoved ? tp / truthRemoved : 1,
		timePrecision: tAuto ? tTp / tAuto : 1,
		timeRecall: tTruth ? tTp / tTruth : 1,
		removedWords: autoRemoved,
		truthRemovedWords: truthRemoved,
	};
}
