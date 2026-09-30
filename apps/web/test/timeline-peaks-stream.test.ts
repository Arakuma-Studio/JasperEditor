// Waveform stream lookup: clips carry the container stream index of their audio, the engine writes one
// peaks file per audio ordinal (`0:a:k`). A movie's audio is usually container stream 1 → peaks 0.
import type { MediaAsset } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { audioOrdinal } from '../src/panels/timeline/media/media-cache.ts';

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
