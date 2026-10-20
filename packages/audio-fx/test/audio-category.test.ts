// Essential Sound Auto Tag classifier (spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): generated music, ambience and
// sound effects (the synth kit and long effects) are classified right; determinism; every input size, rate and
// layout gives a defined result; malformed arguments are refused with AudioCategoryError. The labelled accuracy table
// with real speech (LJ Speech) and the starter kit is the engine test `audio-classify-accuracy.test.ts`.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	AUDIO_CATEGORIES,
	AudioCategoryError,
	audioCategoryFeatures,
	classifyAudio,
	LOW_CATEGORY_CONFIDENCE,
	MAX_CATEGORY_WINDOWS,
} from '../src/analysis/audio-category.ts';
import { renderSynth, SYNTH_RECIPES } from '../src/synth/render.ts';
import { ambienceSet, longSfxSet, musicSet } from './category-fixtures.ts';

const classify = (channels: Float32Array[], sr: number, dur?: number) =>
	classifyAudio(audioCategoryFeatures({ channels, sampleRate: sr }, dur));

describe('classifyAudio on generated material', () => {
	it('music: band, pads, arpeggios, melody, drums, piano (12 s, 44.1 kHz)', { timeout: 300_000 }, () => {
		for (const x of musicSet(44_100, 12)) {
			const r = classify(x.channels, x.sr);
			expect(r.category, `${x.name} ${JSON.stringify(r.scores)}`).toBe('music');
			expect(r.confidence, x.name).toBeGreaterThan(0);
		}
	});

	it('ambience: beds, traffic, rain, wind, room tone, AC, forest, office (12 s)', {
		timeout: 300_000,
	}, () => {
		for (const x of ambienceSet(48_000, 12)) {
			const r = classify(x.channels, x.sr);
			expect(r.category, `${x.name} ${JSON.stringify(r.scores)}`).toBe('ambience');
		}
	});

	it('sfx: every synth recipe (two seeds) and long effects (2–7 s)', { timeout: 300_000 }, () => {
		for (const rec of SYNTH_RECIPES)
			for (const seed of [2, 3]) {
				const s = renderSynth(rec.id, seed);
				const r = classify(s.channels, s.sampleRate);
				expect(r.category, `${rec.id}#${seed} ${JSON.stringify(r.scores)}`).toBe('sfx');
			}
		for (const x of longSfxSet(48_000)) {
			const r = classify(x.channels, x.sr);
			expect(r.category, `${x.name} ${JSON.stringify(r.scores)}`).toBe('sfx');
		}
	});

	it('is deterministic (same features and result twice)', () => {
		const x = musicSet(22_050, 8)[1]!;
		const a = audioCategoryFeatures({ channels: x.channels, sampleRate: x.sr });
		const b = audioCategoryFeatures({ channels: x.channels.map((c) => c.slice()), sampleRate: x.sr });
		expect(b).toEqual(a);
		expect(classifyAudio(b)).toEqual(classifyAudio(a));
	});

	it('pools windows of a long clip: four 10 s windows of a 4-minute bed are ambience, durationSec is the clip', () => {
		const bed = ambienceSet(16_000, 10)[0]!;
		const windows = [0, 1, 2, 3].map(() => ({ channels: bed.channels, sampleRate: bed.sr }));
		const f = audioCategoryFeatures(windows, 240);
		expect(f.durationSec).toBe(240);
		expect(f.analysedSec).toBe(40);
		expect(classifyAudio(f).category).toBe('ambience');
	});
});

describe('edge inputs', () => {
	it('silence, empty and one-sample inputs are silent (confidence 0) and never throw', () => {
		for (const ch of [[], [new Float32Array(0)], [new Float32Array(1)], [new Float32Array(48_000)]]) {
			const r = classify(ch, 48_000);
			expect(r.silent).toBe(true);
			expect(r.confidence).toBe(0);
			expect(r.reasons).toEqual(['silent']);
		}
		// −80 dBFS noise is silent too (under the −70 dBFS peak floor)
		const quiet = new Float32Array(48_000).map((_, i) => 1e-4 * Math.sin(i));
		expect(classify([quiet], 48_000).silent).toBe(true);
	});

	it('a short click (< 1 s) is sfx; NaN and ±Infinity count as silence', () => {
		const n = 4_800;
		const click = new Float32Array(n);
		for (let i = 0; i < 480; i++) click[i + 100] = Math.exp(-i / 50) * Math.sin(i * 0.7);
		const dirty = click.slice();
		dirty[0] = Number.NaN;
		dirty[1] = Number.POSITIVE_INFINITY;
		dirty[2] = Number.NEGATIVE_INFINITY;
		expect(classify([click], 48_000).category).toBe('sfx');
		expect(classify([dirty], 48_000)).toEqual(classify([click], 48_000));
	});

	it('8 kHz mono, 96 kHz stereo and 5.1 give the same kind of answer', () => {
		const m8 = musicSet(8_000, 10)[0]!;
		expect(classify([m8.channels[0]!], 8_000).category).toBe('music');
		const a96 = ambienceSet(96_000, 6)[2]!;
		expect(classify(a96.channels, 96_000).category).toBe('ambience');
		const s = renderSynth('synth.hit', 1);
		const six = [
			s.channels[0]!,
			s.channels[1]!,
			s.channels[0]!,
			new Float32Array(10),
			s.channels[1]!,
			s.channels[0]!,
		];
		expect(classify(six, s.sampleRate).category).toBe('sfx');
	});

	it('refuses malformed arguments with AudioCategoryError (E_INVALID_PARAM)', () => {
		const ok = { channels: [new Float32Array(100)], sampleRate: 48_000 };
		expect(() => audioCategoryFeatures([])).toThrow(AudioCategoryError);
		expect(() => audioCategoryFeatures(Array(MAX_CATEGORY_WINDOWS + 1).fill(ok))).toThrow(AudioCategoryError);
		for (const sampleRate of [0, 999, 1e6, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => audioCategoryFeatures({ channels: [new Float32Array(10)], sampleRate })).toThrow(
				AudioCategoryError,
			);
		expect(() => audioCategoryFeatures({ channels: 'x' as never, sampleRate: 48_000 })).toThrow(
			AudioCategoryError,
		);
		try {
			audioCategoryFeatures([]);
		} catch (e) {
			expect((e as AudioCategoryError).code).toBe('E_INVALID_PARAM');
		}
		// classifyAudio never throws, even on garbage features
		expect(classifyAudio(null as never).silent).toBe(true);
		expect(classifyAudio({} as never).silent).toBe(true);
	});

	it('property: arbitrary audio never throws; features finite; scores and confidence in 0…1', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 3 }),
				fc.integer({ min: 0, max: 30_000 }),
				fc.constantFrom(8_000, 16_000, 22_050, 44_100, 48_000),
				fc.constantFrom(0, 1e-3, 0.3, 1, 1e4),
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				(chans, len, sr, amp, seed) => {
					let s = seed;
					const rnd = () => {
						s = (Math.imul(s, 1103515245) + 12345) >>> 0;
						return s / 2 ** 31 - 1;
					};
					const channels = Array.from({ length: chans }, () => {
						const c = new Float32Array(len);
						const mode = Math.abs(Math.floor(rnd() * 4));
						for (let i = 0; i < len; i++)
							c[i] =
								mode === 0
									? amp * rnd()
									: mode === 1
										? amp * Math.sin(i * 0.05 * (1 + mode))
										: mode === 2 && i % 997 === 0
											? amp
											: rnd() > 0.999
												? Number.NaN
												: amp * rnd() * Math.exp(-i / 4000);
						return c;
					});
					const f = audioCategoryFeatures({ channels, sampleRate: sr });
					for (const [k, v] of Object.entries(f))
						if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
					const r = classifyAudio(f);
					expect(AUDIO_CATEGORIES).toContain(r.category);
					expect(r.confidence).toBeGreaterThanOrEqual(0);
					expect(r.confidence).toBeLessThanOrEqual(1);
					for (const c of AUDIO_CATEGORIES) {
						expect(r.scores[c]).toBeGreaterThanOrEqual(0);
						expect(r.scores[c]).toBeLessThanOrEqual(1);
					}
					expect(r.reasons.length).toBeGreaterThan(0);
				},
			),
			{ numRuns: 60, seed: 2026 },
		);
	});

	it('LOW_CATEGORY_CONFIDENCE is the documented 0.6', () => {
		expect(LOW_CATEGORY_CONFIDENCE).toBe(0.6);
	});
});
