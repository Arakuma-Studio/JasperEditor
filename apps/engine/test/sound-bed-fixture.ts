// Generated audio for the Phase 4 bed / solver tests (wp-note "Phase 4 → WP4.1b"): deterministic, nothing committed.
//   music.wav   10 s stereo pink noise, ≈ −30 dBFS RMS (a music bed, Essential Sound music)
//   speech.wav  10 s: silence, then from 4 s to 8 s a 1.5 kHz tone with a 4 Hz syllable envelope (dialogue, no
//               transcript: the engine's voice activity finds it)
//   hit.wav     0.6 s: 50 ms of silence, then decaying low noise with a 90 Hz body (a hit: dominant 125 Hz)
//   click.wav   0.25 s: 50 ms of silence, then a 3 kHz burst decaying over 30 ms (a click: dominant 2–4 kHz)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from '@jasper/audio-dsp';
import type { LibraryProvenance } from '@jasper/project';

export const SR = 48_000;

function prng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
	};
}

/** Pink noise (Paul Kellet's filter) scaled to `rms`. */
function pink(n: number, seed: number, rms: number): Float32Array {
	const r = prng(seed);
	const out = new Float32Array(n);
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let b3 = 0;
	let b4 = 0;
	let b5 = 0;
	let b6 = 0;
	let e = 0;
	for (let i = 0; i < n; i++) {
		const w = r();
		b0 = 0.99886 * b0 + w * 0.0555179;
		b1 = 0.99332 * b1 + w * 0.0750759;
		b2 = 0.969 * b2 + w * 0.153852;
		b3 = 0.8665 * b3 + w * 0.3104856;
		b4 = 0.55 * b4 + w * 0.5329522;
		b5 = -0.7616 * b5 - w * 0.016898;
		const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
		b6 = w * 0.115926;
		out[i] = v;
		e += v * v;
	}
	const g = rms / Math.sqrt(e / n);
	for (let i = 0; i < n; i++) out[i]! *= g;
	return out;
}

export function musicSamples(seconds = 10): Float32Array[] {
	const n = Math.round(seconds * SR);
	return [pink(n, 11, 0.03), pink(n, 12, 0.03)];
}

export function speechSamples(seconds = 10, from = 4, to = 8): Float32Array[] {
	const n = Math.round(seconds * SR);
	const l = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		if (t < from || t >= to) continue;
		const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * (t - from));
		l[i] = 0.2 * env * Math.sin(2 * Math.PI * 1500 * t);
	}
	return [l, l.slice()];
}

export function hitSamples(): Float32Array[] {
	const n = Math.round(0.6 * SR);
	const r = prng(5);
	const l = new Float32Array(n);
	let lp = 0;
	for (let i = 0; i < n; i++) {
		const t = i / SR - 0.05;
		if (t < 0) continue;
		lp += 0.03 * (r() - lp);
		l[i] = (3 * lp + 0.5 * Math.sin(2 * Math.PI * 90 * t)) * Math.exp(-t / 0.12) * 0.8;
	}
	return [l, l.slice()];
}

export function clickSamples(): Float32Array[] {
	const n = Math.round(0.25 * SR);
	const l = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / SR - 0.05;
		if (t < 0) continue;
		l[i] = 0.5 * Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t / 0.03);
	}
	return [l, l.slice()];
}

/** Writes the four files into `dir`; returns their paths. */
export function writeBedFixture(dir: string): { music: string; speech: string; hit: string; click: string } {
	mkdirSync(dir, { recursive: true });
	const w = (name: string, ch: Float32Array[]) => {
		const p = join(dir, name);
		writeFileSync(p, encodeWav(ch, SR, 's16'));
		return p;
	};
	return {
		music: w('music.wav', musicSamples()),
		speech: w('speech.wav', speechSamples()),
		hit: w('hit.wav', hitSamples()),
		click: w('click.wav', clickSamples()),
	};
}

/** Library provenance of a fixture sound (descriptors close to the files'; `soundId` distinct per sound). */
export function provenance(kind: 'hit' | 'click', n = 0): LibraryProvenance {
	const hit = kind === 'hit';
	return {
		soundId: `snd_${((hit ? 0xb000 : 0xc000) + n).toString(16).padStart(16, '0')}`,
		title: hit ? `Test hit ${n}` : `Test click ${n}`,
		types: [hit ? 'hit' : 'click'],
		source: { type: 'starter' },
		license: 'LicenseRef-JasperEditor',
		author: 'test',
		attribution: null,
		descriptors: {
			peakSec: 0.05,
			onsetSec: 0.05,
			headQuietSec: 0.05,
			durationSec: hit ? 0.6 : 0.25,
			octaveBandsDb: hit ? [-14, -20, -30, -40, -50, -60, -70] : [-80, -80, -70, -40, -14, -18, -40],
			centroidHz: hit ? 120 : 3000,
			maxMomentaryLufs: hit ? -16 : -24,
			truePeakDb: hit ? -2.5 : -6,
		} as LibraryProvenance['descriptors'],
		leadSilenceSec: 0.05,
	};
}
