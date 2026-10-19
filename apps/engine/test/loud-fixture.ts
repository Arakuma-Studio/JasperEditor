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
		const kick =
			0.9 * Math.sin(2 * Math.PI * 55 * tk * (1 + 2 * Math.exp(-tk / 0.03))) * Math.exp(-tk / 0.15);
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

/**
 * A typical programme mix (wp-note sound-design "Fix: preview loudness parity, codec-aware Sound Check, delivery
 * speed"): a voice-like part (a glottal buzz with a gliding pitch through three formant bands, syllables at ≈ 4 Hz in
 * 2 s phrases with pauses and fricative noise at syllable starts), a soft music bed ≈ 12 dB under it and two hard hits
 * (a noise slam with an instantaneous attack). Normalised to −14 LUFS / −1 dBTP the limiter works only on the hits and
 * the loudest syllables. Deterministic (LCG noise).
 */
export function typicalMix(seconds = 10, sampleRate = 48_000): [Float32Array, Float32Array] {
	const n = Math.round(seconds * sampleRate);
	const L = new Float32Array(n);
	const R = new Float32Array(n);
	let seed = 7;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) >>> 0;
		return (seed / 2 ** 32) * 2 - 1;
	};
	let phase = 0;
	let fric = 0;
	// fixed random harmonic phases: a voice-like crest factor (in-phase harmonics would make a pulse train)
	const phases = Array.from({ length: 31 }, () => Math.PI * (rnd() + 1));
	const formants = [
		[500, 1],
		[1500, 0.5],
		[2500, 0.25],
	] as const;
	for (let i = 0; i < n; i++) {
		const t = i / sampleRate;
		// voice: phrases of 2 s with 0.4 s pauses, syllables of 250 ms (raised cosine)
		const inPhrase = t % 2.4 < 2;
		const syl = (t % 0.25) / 0.25;
		const env = inPhrase ? 0.5 - 0.5 * Math.cos(2 * Math.PI * syl) : 0;
		const f0 = 120 + 30 * Math.sin(2 * Math.PI * 0.3 * t) + 15 * Math.sin(2 * Math.PI * 1.7 * t);
		phase += f0 / sampleRate;
		let v = 0;
		for (let k = 1; k <= 30; k++) {
			const f = k * f0;
			let w = 0;
			for (const [fc, a] of formants) w += a / (1 + ((f - fc) / 150) ** 2);
			v += (w / k ** 0.3) * Math.sin(2 * Math.PI * k * phase + phases[k]!);
		}
		const noise = rnd();
		fric = 0.6 * (noise - fric) + 0.4 * fric;
		const fricEnv = inPhrase && syl < 0.12 && Math.floor(t / 0.25) % 3 === 0 ? 0.25 : 0;
		const voice = 0.05 * env * v + fricEnv * fric * 0.3;
		// music bed: a soft triangle chord, slowly swelling
		let bed = 0;
		for (const f of [220, 277.2, 329.6]) bed += 1 - 4 * Math.abs(((t * f) % 1) - 0.5);
		bed *= 0.012 * (1 + 0.3 * Math.sin(2 * Math.PI * 0.1 * t));
		// two hits with an instantaneous attack
		let hit = 0;
		for (const at of [3.2, 7.5]) if (t >= at) hit += noise * 0.25 * Math.exp(-(t - at) / 0.06);
		L[i] = voice + bed + hit;
		R[i] = voice * 0.95 + bed * 1.05 + hit * 0.9;
	}
	return [L, R];
}

export function writeMixWav(path: string, planar: Float32Array[], sampleRate = 48_000): string {
	writeFileSync(path, encodeWav(planar, sampleRate, 'f32'));
	return path;
}
