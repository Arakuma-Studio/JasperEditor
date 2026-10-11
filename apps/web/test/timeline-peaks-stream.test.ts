// Clips and the engine key waveform peaks by the container stream index.
// A movie's audio is usually container stream 1.
import type { MediaAsset } from '@jasper/project';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { peaksFor } from '../src/panels/timeline/media/media-cache.ts';

const movie = {
	locators: [],
	probe: {
		streams: [
			{ index: 0, type: 'video' },
			{ index: 1, type: 'audio' },
		],
	},
} as unknown as MediaAsset;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('peaksFor stream lookup', () => {
	it("requests the peaks stream with the clip's container stream index (movie audio = stream 1)", async () => {
		const header = {
			peaksPerSecond: 100,
			channels: 1,
			sampleCount: 2,
			durationSec: 0.02,
			streams: [{ index: 1, channels: 1, url: '/media/k/peaks/1.bin?v=h' }],
		};
		const urls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				urls.push(url);
				if (url.includes('peaks.json')) return new Response(JSON.stringify(header));
				return new Response(new Float32Array([0.5, 0.25]).buffer);
			}),
		);
		const runtime = { peaksUrl: '/media/k/peaks.json?v=h' } as never;
		expect(peaksFor(null, movie, runtime, 1)).toBeNull();
		await vi.waitFor(() => expect(peaksFor(null, movie, runtime, 1)).not.toBeNull());
		expect(urls).toEqual(['/media/k/peaks.json?v=h', '/media/k/peaks/1.bin?v=h']);
		expect(Array.from(peaksFor(null, movie, runtime, 1)!.channels[0]!)).toEqual([0.5, 0.25]);
	});
});
