// Spec 12 §2.10 requires a peak line on contact sheets; hostile visual data must stay bounded.
import type { SoundEntry, SoundVisual } from '@jasper/api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeVisual, drawSoundCell, drawSoundDetail } from '../src/sound-sheet.ts';

function entry(over: Partial<SoundEntry['descriptors']> = {}): SoundEntry {
	return {
		id: 'snd_0123456789abcdef',
		fingerprint: 'q1:x',
		title: 'Test hit',
		types: ['hit'],
		tags: [],
		source: { type: 'starter', file: 'x.ogg' },
		license: 'CC0-1.0',
		author: 'Someone',
		attribution: null,
		format: { durationSec: 1, sampleRate: 48000, channels: 1, container: 'wav' },
		descriptors: {
			durationSec: 1,
			peakSec: 0.25,
			onsetSec: 0.24,
			riseMs: 3,
			decayMs: 200,
			decays: true,
			tailSec: 0.8,
			centroidHz: 1500,
			rolloff85Hz: 4000,
			below150Share: 0.1,
			above6kShare: 0.05,
			flatness: 0.2,
			octaveBandsDb: [-30, -25, -20, -18, -20, -25, -30],
			pitchMidi: null,
			pitchConfidence: 0,
			onsetCount: 1,
			integratedLufs: -20,
			maxMomentaryLufs: -15,
			truePeakDb: -1,
			stereoWidth: 0,
			headQuietSec: 0.2,
			loopable: false,
			...over,
		},
		judge: { ok: true, score: 1, reasons: [], type: 'hit' },
		indexedAt: '2026-10-15T00:00:00.000Z',
		analysisVersion: 1001,
	};
}

/** 1 s of visual data: silence, a burst at 0.25 s decaying over 0.2 s; the spectrogram loud in the same frames. */
function visual(): SoundVisual {
	const peaks = new Uint8Array(100);
	for (let i = 25; i < 100; i++) peaks[i] = Math.round(255 * Math.exp(-(i - 25) / 8));
	const bins = 64;
	const spec = new Uint8Array(100 * bins);
	for (let f = 25; f < 60; f++) for (let b = 0; b < bins; b++) spec[f * bins + b] = 200;
	return {
		version: 1,
		soundId: 'snd_0123456789abcdef',
		fingerprint: 'q1:x',
		durationSec: 1,
		coveredSec: 1,
		peakSec: 0.25,
		peaks: { perSecond: 100, count: 100, data: Buffer.from(peaks).toString('base64') },
		spectrogram: {
			bins,
			frames: 100,
			framesPerSecond: 100,
			minHz: 20,
			maxHz: 20000,
			floorDb: -96,
			data: Buffer.from(spec).toString('base64'),
		},
	};
}

describe('sound pictures', () => {
	it('the peak line follows sound time on the contact sheet', () => {
		const columns = [0, 0.25, 1].map((peakSec) => {
			const image = drawSoundCell(entry({ peakSec }), visual(), 1, { width: 360, plotHeight: 120 });
			const redColumns = [];
			for (let x = 0; x < image.width; x++) {
				let red = 0;
				for (let y = 0; y < image.height; y++) {
					const offset = (y * image.width + x) * 4;
					if (image.data[offset]! > 200 && image.data[offset + 1]! < 100 && image.data[offset + 2]! < 100)
						red++;
				}
				if (red > 0) redColumns.push(x);
			}
			expect(redColumns.length).toBeGreaterThan(0);
			return redColumns.reduce((sum, x) => sum + x, 0) / redColumns.length;
		});
		const [start, quarter, end] = columns as [number, number, number];
		expect(end).toBeGreaterThan(start);
		// A time axis is linear; infer its endpoints from the raster, so moving the header or plot gutters is allowed.
		expect(Math.abs(quarter - (start + (end - start) / 4))).toBeLessThanOrEqual(1);
	});

	it('hostile visual data never throws and stays bounded', () => {
		fc.assert(
			fc.property(
				fc.record({
					coveredSec: fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(0)),
					count: fc.oneof(fc.integer({ min: -5, max: 10_000_000 }), fc.constant(Number.NaN)),
					frames: fc.oneof(fc.integer({ min: -5, max: 10_000_000 }), fc.constant(Number.POSITIVE_INFINITY)),
					bins: fc.integer({ min: -5, max: 100_000 }),
					data: fc.oneof(fc.string(), fc.constant('%%%not base64')),
					peakSec: fc.oneof(fc.double(), fc.constant(-1)),
				}),
				(h) => {
					const v = {
						...visual(),
						coveredSec: h.coveredSec,
						peaks: { perSecond: 100, count: h.count, data: h.data },
						spectrogram: { ...visual().spectrogram, bins: h.bins, frames: h.frames, data: h.data },
					} as SoundVisual;
					const dec = decodeVisual(v);
					expect(dec.peaks.length).toBeLessThanOrEqual(60_000);
					expect(dec.spectrogram.length).toBeLessThanOrEqual(6000 * 256);
					expect(Number.isFinite(dec.coveredSec) && dec.coveredSec > 0).toBe(true);
					const e = entry({ peakSec: Number.isFinite(h.peakSec) ? h.peakSec : 0 });
					drawSoundCell(e, v, 1, { width: 120, plotHeight: 40 });
					drawSoundDetail(e, v, { width: 320, height: 134 });
				},
			),
			{ numRuns: 150 },
		);
	});
});
