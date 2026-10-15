// Generated WAV fixtures for the sound library tests (spec 12 WP1.2): deterministic, no network, nothing committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodeWav } from '@jasper/audio-dsp';

export const SR = 48_000;

/** A small deterministic PRNG (LCG) in [-1, 1). */
function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x80000000 - 1;
	};
}

export type Shape = 'hit' | 'whoosh' | 'click' | 'tone';

/** Stereo float samples of a shape: hit = decaying noise + 180 Hz body; whoosh = swelling noise; click = 4 ms tick; tone = sine. */
export function samples(shape: Shape, seconds: number, seed = 1, freq = 440): Float32Array[] {
	const n = Math.max(1, Math.round(seconds * SR));
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	const rand = rng(seed);
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		let v = 0;
		if (shape === 'hit') {
			const lead = 0.02;
			const tt = t - lead;
			v = tt < 0 ? 0 : (0.6 * rand() + 0.4 * Math.sin(2 * Math.PI * 180 * tt)) * Math.exp(-tt / 0.06);
		} else if (shape === 'whoosh') {
			const env = Math.sin((Math.PI * t) / seconds) ** 2;
			v = 0.5 * rand() * env;
		} else if (shape === 'click') {
			v = t < 0.004 ? 0.8 * Math.sin(2 * Math.PI * 3000 * t) * (1 - t / 0.004) : 0;
		} else v = 0.5 * Math.sin(2 * Math.PI * freq * t);
		l[i] = v;
		r[i] = v * 0.9;
	}
	return [l, r];
}

export function writeWav(path: string, shape: Shape, seconds: number, seed = 1, freq = 440): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, encodeWav(samples(shape, seconds, seed, freq), SR, 's16'));
	return path;
}

export const PACK = {
	id: 'test-impacts',
	title: 'Test Impacts',
	url: 'https://example.invalid/test-impacts.zip',
	sha256: 'a'.repeat(64),
	license: 'CC0-1.0',
	licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
	author: 'Test Author',
};

/** A starter kit in `dir`: three CC0 sounds and one CC-BY sound, plus its manifest. */
export function makeStarter(dir: string): string {
	writeWav(join(dir, 'impacts', 'hit_heavy.wav'), 'hit', 0.6, 1);
	writeWav(join(dir, 'impacts', 'hit_light.wav'), 'hit', 0.35, 2);
	writeWav(join(dir, 'movement', 'whoosh_fast.wav'), 'whoosh', 0.8, 3);
	writeWav(join(dir, 'ui', 'click_soft.wav'), 'click', 0.08, 4);
	const sound = (file: string, title: string, types: string[], extra: Record<string, unknown> = {}) => ({
		file,
		title,
		types,
		tags: ['test'],
		author: 'Test Author',
		license: 'CC0-1.0',
		sourceUrl: 'https://example.invalid/sounds',
		packId: PACK.id,
		...extra,
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [PACK],
			sounds: [
				sound('impacts/hit_heavy.wav', 'Heavy hit', ['hit']),
				sound('impacts/hit_light.wav', 'Light hit', ['hit']),
				sound('movement/whoosh_fast.wav', 'Fast whoosh', ['whoosh'], {
					license: 'CC-BY-4.0',
					author: 'Jane Doe',
				}),
				sound('ui/click_soft.wav', 'Soft click', []),
				// skipped: not an audio file, path escapes, unknown pack
				sound('readme.txt', 'Not audio', ['hit']),
				sound('../outside.wav', 'Escape', ['hit']),
				sound('impacts/hit_heavy.wav', 'Duplicate', ['hit'], { packId: 'nope' }),
			],
		}),
	);
	return dir;
}
