// Synthetic multi-hit recordings with known attacks (spec 12 P6-E9 "Done when"), for the takes tests.
import { Prng } from '../src/core/util.ts';

export const TAKE_SR = 48_000;

/**
 * Adds a click at sample `at`: noise and a 3 kHz partial under an exponential decay (τ = `tauMs`), `lenMs` long, peak
 * amplitude `amp`. Deterministic (seeded).
 */
export function addClick(
	x: Float32Array,
	at: number,
	o: { amp?: number; tauMs?: number; lenMs?: number; seed?: number; sr?: number } = {},
): void {
	const sr = o.sr ?? TAKE_SR;
	const amp = o.amp ?? 0.6;
	const tau = ((o.tauMs ?? 4) / 1000) * sr;
	const len = Math.round(((o.lenMs ?? 60) / 1000) * sr);
	const r = new Prng(o.seed ?? at + 1);
	for (let i = 0; i < len && at + i < x.length; i++) {
		if (at + i < 0) continue;
		const env = Math.exp(-i / tau);
		const v = 0.6 * r.uniform() + 0.4 * Math.sin((2 * Math.PI * 3000 * i) / sr);
		x[at + i] = x[at + i]! + amp * env * v;
	}
}

/** `n` samples of uniform noise at `amp` (seeded); `amp` 0 = digital silence. */
export function floorNoise(n: number, amp: number, seed = 7): Float32Array {
	const out = new Float32Array(n);
	if (amp === 0) return out;
	const r = new Prng(seed);
	for (let i = 0; i < n; i++) out[i] = amp * r.uniform();
	return out;
}

/** Ten clicks separated by digital silence (a pack of takes): attacks at 0.2 s + k · 0.36 s. */
export function tenClicksInSilence(sr = TAKE_SR): { x: Float32Array; attacks: number[] } {
	const x = new Float32Array(Math.round(4 * sr));
	const attacks: number[] = [];
	for (let k = 0; k < 10; k++) {
		const at = Math.round((0.2 + k * 0.36) * sr);
		attacks.push(at);
		addClick(x, at, { sr, seed: 100 + k });
	}
	return { x, attacks };
}

/**
 * Typing: eight key presses 0.5 s apart, each a down-stroke and an up-stroke 80 ms later (6 dB weaker), over a −70 dBFS
 * noise floor (no digital silence between them).
 */
export function typingPairs(sr = TAKE_SR): { x: Float32Array; downs: number[]; ups: number[] } {
	const x = floorNoise(Math.round(4.6 * sr), 3e-4, 11);
	const downs: number[] = [];
	const ups: number[] = [];
	for (let k = 0; k < 8; k++) {
		const down = Math.round((0.25 + k * 0.5) * sr);
		const up = down + Math.round(0.08 * sr);
		downs.push(down);
		ups.push(up);
		addClick(x, down, { amp: 0.6, tauMs: 5, sr, seed: 200 + k });
		addClick(x, up, { amp: 0.3, tauMs: 4, sr, seed: 300 + k });
	}
	return { x, downs, ups };
}
