// A loud, bright, transient-heavy stereo mix for the delivery tests (wp-note sound-design "Fix: lossy-codec true-peak
// headroom and loudness convergence"): sawtooth chords (bright, sustained), a noise snare every 0.5 s with an
// instantaneous attack, a pitched-down kick every second and noise hats every 125 ms. Normalised to −14 LUFS under a
// −1 dBTP ceiling the limiter works hard on the hits (the one-pass delivery lands ≈ 0.6–0.8 LU under the target) and
// ffmpeg's AAC / libopus decode 1–2.5 dB over the PCM's true peak (measured, wp-note). Deterministic (LCG noise).
import { writeFileSync } from 'node:fs';
import { encodeWav } from '@jasper/audio-dsp';

export function loudMix(seconds = 12, sampleRate = 48_000): [Float32Array, Float32Array] {
	const n = Math.round(seconds * sampleRate);
	const L = new Float32Array(n);
	const R = new Float32Array(n);
	let seed = 1;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) >>> 0;
		return (seed / 2 ** 32) * 2 - 1;
	};
	for (let i = 0; i < n; i++) {
		const t = i / sampleRate;
		let l = 0;
		let r = 0;
		for (const [f, a] of [
			[110, 0.12],
			[165, 0.1],
			[220, 0.08],
			[330, 0.05],
		] as const) {
			l += a * (2 * ((t * f) % 1) - 1);
			r += a * (2 * ((t * f * 1.003) % 1) - 1);
		}
		const tb = t % 0.5;
		const snare = rnd() * 0.8 * Math.exp(-tb / 0.04);
		const tk = t % 1;
		const kick = 0.9 * Math.sin(2 * Math.PI * 55 * tk * (1 + 2 * Math.exp(-tk / 0.03))) * Math.exp(-tk / 0.15);
		const th = t % 0.125;
		const hat = rnd() * 0.3 * Math.exp(-th / 0.008);
		// × 0.4: the file stays under full scale (the normalisation gain brings it up to the target again)
		L[i] = 0.4 * (l + snare + kick + hat);
		R[i] = 0.4 * (r + snare * 0.9 + kick + hat * 1.1);
	}
	return [L, R];
}

/** A quiet, smooth stereo programme (a 440 Hz tone with a slow tremolo at about −30 LUFS): no limiting anywhere. */
export function quietMix(seconds = 6, sampleRate = 48_000): [Float32Array, Float32Array] {
	const n = Math.round(seconds * sampleRate);
	const L = new Float32Array(n);
	const R = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / sampleRate;
		const env = 0.03 * (1 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t));
		L[i] = env * Math.sin(2 * Math.PI * 440 * t);
		R[i] = env * Math.sin(2 * Math.PI * 440 * t + 0.3);
	}
	return [L, R];
}

export function writeMixWav(path: string, planar: Float32Array[], sampleRate = 48_000): string {
	writeFileSync(path, encodeWav(planar, sampleRate, 'f32'));
	return path;
}
