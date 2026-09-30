// Waveform stream lookup: clips carry the container stream index of their audio, the engine writes one
// peaks file per audio ordinal (`0:a:k`). A movie's audio is usually container stream 1 → peaks 0.
import type { MediaAsset } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { audioOrdinal } from '../src/panels/timeline/media/media-cache.ts';
import { waveHeight } from '../src/panels/timeline/model/waveform.ts';

const asset = (types: ('video' | 'audio')[]) =>
	({ probe: { streams: types.map((type, index) => ({ index, type })) } }) as unknown as MediaAsset;

describe('audioOrdinal', () => {
	it('maps a movie audio stream (container index 1) to peaks stream 0', () => {
		expect(audioOrdinal(asset(['video', 'audio']), 1)).toBe(0);
	});
	it('counts only audio streams', () => {
		expect(audioOrdinal(asset(['video', 'audio', 'video', 'audio']), 3)).toBe(1);
	});
	it('keeps audio-only files at 0 and falls back to the index when the stream is unknown', () => {
		expect(audioOrdinal(asset(['audio']), 0)).toBe(0);
		expect(audioOrdinal(undefined, 2)).toBe(2);
	});
});

describe('waveHeight (logarithmic waveform display)', () => {
	it('keeps linear amplitudes unchanged', () => {
		expect(waveHeight(0.25, 'linear')).toBe(0.25);
	});
	it('maps dBFS between the floor and full scale', () => {
		expect(waveHeight(1, 'log')).toBe(1);
		expect(waveHeight(0, 'log')).toBe(0);
		// −18 dBFS on a −48 dB floor → 1 − 18/48
		expect(waveHeight(10 ** (-18 / 20), 'log')).toBeCloseTo(1 - 18 / 48, 6);
		expect(waveHeight(10 ** (-60 / 20), 'log')).toBe(0);
	});
});
