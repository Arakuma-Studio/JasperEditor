// The pictures of sounds (sound-sheet.ts) and the label font (pixel-font.ts): sizes, where the peak line lands,
// and hostile visual data (bad base64, wrong counts, NaN) never throwing or over-allocating.
import type { SoundEntry, SoundVisual } from '@jasper/api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { drawText, fitText, foldText, textWidth } from '../src/pixel-font.ts';
import { composeGrid, decodePng, encodePng } from '../src/png.ts';
import { canvas, decodeVisual, drawSoundCell, drawSoundDetail } from '../src/sound-sheet.ts';

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

const px = (img: { width: number; data: Uint8Array }, x: number, y: number) => {
	const o = (y * img.width + x) * 4;
	return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
};

describe('pixel font', () => {
	it('folds text to drawable ASCII and measures it', () => {
		expect(foldText('Café — “quiet” …')).toBe('Cafe - "quiet" ...');
		expect(foldText('音')).toBe('?');
		expect(textWidth('ab')).toBe(11);
		expect(textWidth('ab', 2)).toBe(22);
		expect(fitText('abcdefghij', 6 * 5)).toBe('abc..');
		expect(fitText('abc', 100)).toBe('abc');
	});

	it('draws ink inside the canvas only', () => {
		const img = canvas(20, 10, [0, 0, 0]);
		drawText(img, 'H', 0, 0, [255, 255, 255]);
		expect(px(img, 0, 0)).toEqual([255, 255, 255]); // H's left stem
		expect(px(img, 2, 0)).toEqual([0, 0, 0]);
		drawText(img, 'WWWWWWWW', -5, -3, [255, 0, 0], 3); // clipped, no throw
	});
});

describe('sound pictures', () => {
	it('a cell: size, header, and the red peak line at peakSec', () => {
		const img = drawSoundCell(entry(), visual(), 3, { width: 360, plotHeight: 120 });
		expect(img.width).toBe(360);
		expect(img.height).toBe(58 + 120 + 4);
		// Plot x = 2 + round(0.25 × 356) = 91: red there, mid-height, and not 20 px earlier.
		const y = 58 + 2 + 30;
		expect(px(img, 91, y)).toEqual([255, 70, 70]);
		expect(px(img, 71, y)).not.toEqual([255, 70, 70]);
		// The decay end (0.45 s) is dashed yellow somewhere on its column.
		const col = Array.from({ length: 120 }, (_, i) => px(img, 2 + Math.round(0.45 * 356), 60 + i).join());
		expect(col).toContain('255,210,60');
		// Encodes and decodes as the same raster.
		const back = decodePng(encodePng(img));
		expect([back.width, back.height]).toEqual([img.width, img.height]);
	});

	it('a cell without visual data says so; a sound that does not decay has no decay line', () => {
		const img = drawSoundCell(entry({ decays: false }), null, 1, { width: 200, plotHeight: 60 });
		expect(img.width).toBe(200);
		const withDecay = drawSoundCell(entry({ decays: false }), visual(), 1, { width: 360, plotHeight: 120 });
		const col = Array.from({ length: 120 }, (_, i) =>
			px(withDecay, 2 + Math.round(0.45 * 356), 60 + i).join(),
		);
		expect(col).not.toContain('255,210,60');
	});

	it('the detail picture and a grid of cells', () => {
		const d = drawSoundDetail(entry(), visual(), { width: 960, height: 403 });
		expect([d.width, d.height]).toEqual([960, 403]);
		const cells = [1, 2, 3, 4].map((n) => drawSoundCell(entry(), visual(), n, { width: 360, plotHeight: 120 }));
		const grid = composeGrid(cells, 3, 6);
		expect([grid.width, grid.height]).toEqual([3 * 360 + 4 * 6, 2 * 182 + 3 * 6]);
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
