// The media range view picture and text (spec 18 AF-VIEW-001/003; docs/wp-notes/agent-footage-view.md): slot times,
// silence bands (non-speech runs ≥ 0.4 s), the RMS of 10 ms levels, deterministic row layout and pixels at known
// positions (frames in their slots, the waveform where it is loud and not where it is silent, the band's edge), the
// rows that media without video or audio leave out, the summary's facts, and hostile input that must not throw.
import { RANGE_AUDIO_CLASSES } from '@jasper/api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../src/png.ts';
import {
	drawRangeView,
	formatTime,
	frameBox,
	type RangeViewInput,
	rangeSummary,
	rmsDb,
	silenceBands,
	slotTimes,
	type ViewAudio,
} from '../src/range-view.ts';
import type { RgbaImage } from '../src/sound-sheet.ts';

const { speech: SPEECH, silence: SILENCE } = RANGE_AUDIO_CLASSES;
/** Level byte of a dB value (dB = −120 + q / 2). */
const q = (db: number) => Math.round((db + 120) * 2);

function solid(w: number, h: number, c: [number, number, number]): RgbaImage {
	const data = new Uint8Array(w * h * 4);
	for (let i = 0; i < data.length; i += 4) data.set([c[0], c[1], c[2], 255], i);
	return { width: w, height: h, data };
}

/** 2 s: speech (−6 dB) 0–1 s, silence (−120 dB) 1–2 s. */
function audio(): ViewAudio {
	const level = new Uint8Array(200);
	const classes = new Uint8Array(200);
	for (let i = 0; i < 200; i++) {
		const loud = i < 100;
		level[i] = q(loud ? -6 : -120);
		classes[i] = loud ? SPEECH : SILENCE;
	}
	return { start: 0, frameSec: 0.01, level, classes };
}

const px = (img: RgbaImage, x: number, y: number) => {
	const o = (Math.round(y) * img.width + Math.round(x)) * 4;
	return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

function input(over: Partial<RangeViewInput> = {}): RangeViewInput {
	const a = audio();
	return {
		width: 480,
		start: 0,
		end: 2,
		title: 'clip.mp4',
		frames: [
			{ time: 0.5, image: solid(100, 56, [255, 0, 0]) },
			{ time: 1.5, image: solid(100, 56, [0, 0, 255]) },
		],
		audio: a,
		words: [
			{ text: 'hello', start: 0.1, end: 0.4 },
			{ text: 'world', start: 0.5, end: 0.9 },
		],
		silences: silenceBands(a, 0, 2),
		...over,
	};
}

describe('range view helpers', () => {
	it('samples frames at the centres of equal slots', () => {
		expect(slotTimes(10, 18, 8)).toEqual([10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5]);
		expect(slotTimes(0, 1, 2)).toEqual([0.25, 0.75]);
	});

	it('finds non-speech runs of at least 0.4 s, clipped to the range', () => {
		const classes = new Uint8Array(300).fill(SPEECH);
		classes.fill(SILENCE, 50, 100); // 0.5 s
		classes.fill(SILENCE, 150, 180); // 0.3 s: too short
		classes.fill(RANGE_AUDIO_CLASSES.breath, 200, 245); // breath-like counts as a pause: 0.45 s
		classes.fill(SILENCE, 280, 300); // 0.2 s at the end
		const a: ViewAudio = { start: 10, frameSec: 0.01, level: new Uint8Array(300), classes };
		expect(silenceBands(a, 10, 13)).toEqual([
			{ start: 10.5, end: 11 },
			{ start: 12, end: 12.45 },
		]);
		// clipped by the range: only 0.3 s of the first band is inside
		expect(silenceBands(a, 10.7, 13)).toEqual([{ start: 12, end: 12.45 }]);
	});

	it('averages power (not dB) over the frames of a column', () => {
		const a = audio();
		expect(rmsDb(a, 0, 0.5)).toBeCloseTo(-6, 5);
		expect(rmsDb(a, 1, 2)).toBeCloseTo(-120, 5);
		// one loud and one silent 10 ms frame: half the power, 3 dB down
		expect(rmsDb(a, 0.99, 1.01)).toBeCloseTo(-6 - 10 * Math.log10(2), 1);
		expect(rmsDb(a, 5, 6)).toBeNull();
	});

	it('formats times and asks the engine for frames that fit their slots', () => {
		expect(formatTime(12.346)).toBe('12.35');
		expect(formatTime(62.5, 1)).toBe('1:02.5');
		expect(formatTime(3723.4, 1)).toBe('1:02:03.4');
		expect(frameBox(1280, 8)).toEqual({ width: 154, height: 540 });
		expect(frameBox(1920, 2)).toEqual({ width: 948, height: 540 });
	});
});

describe('drawRangeView', () => {
	it('lays the rows out deterministically and draws frames, waveform, silences and words where they belong', () => {
		const { image, layout } = drawRangeView(input());
		expect([image.width, image.height]).toEqual([480, 268]);
		expect(layout.rows).toEqual({
			header: { y: 0, height: 17 },
			strip: { y: 21, height: 128 },
			wave: { y: 153, height: 48 },
			words: { y: 205, height: 40 },
			ruler: { y: 247, height: 21 },
		});
		expect(layout.slots.map((s) => [s.x, s.width, s.height])).toEqual([
			[10, 228, 128],
			[242, 228, 128],
		]);
		// frames in their slots (below the time label)
		expect(px(image, 10 + 114, 21 + 100)).toEqual([255, 0, 0]);
		expect(px(image, 242 + 114, 21 + 100)).toEqual([0, 0, 255]);
		// t = 0.5 s (x = 8 + 0.25 · 464 = 124) is loud: the waveform reaches well above the midline
		const mid = 153 + 24;
		const loud = px(image, 124, mid - 15);
		expect(loud[2]).toBeGreaterThan(200);
		expect(loud[0]).toBeLessThan(160);
		// t = 1.5 s (x = 356) is silent: no waveform, but the silence band's tint and its top edge
		const quiet = px(image, 356, mid - 15);
		expect(quiet[2]).toBeLessThan(100);
		expect(quiet[0]).toBeGreaterThan(quiet[2]!);
		expect(layout.wordsDrawn).toBe(2);
		expect(layout.ticks[0]).toBe(0);
		expect(layout.ticks.at(-1)).toBe(2);
		// encodes to a PNG of the same size
		const png = decodePng(encodePng(image));
		expect([png.width, png.height]).toEqual([480, 268]);
	});

	it('scales text up from 960 px and keeps frames inside the strip height cap', () => {
		const tall = solid(90, 160, [0, 255, 0]);
		const { image, layout } = drawRangeView(
			input({
				width: 1920,
				frames: [
					{ time: 0.5, image: tall },
					{ time: 1.5, image: tall },
				],
			}),
		);
		expect(layout.scale).toBe(2);
		expect(image.width).toBe(1920);
		expect(layout.rows.strip!.height).toBe(540);
		expect(layout.slots[0]!.height).toBe(540);
		expect(layout.slots[0]!.width).toBe(304);
	});

	it('draws only the audio rows for media without video, and no waveform or silences without audio', () => {
		const audioOnly = drawRangeView(input({ frames: null }));
		expect(Object.keys(audioOnly.layout.rows)).toEqual(['header', 'wave', 'words', 'ruler']);
		expect(audioOnly.image.height).toBe(17 + 52 + 42 + 21);
		const silent = drawRangeView(input({ audio: null, words: null, silences: [] }));
		expect(Object.keys(silent.layout.rows)).toEqual(['header', 'strip', 'ruler']);
		// a missing frame is a marked slot, not a crash
		const missing = drawRangeView(
			input({
				frames: [
					{ time: 0.5, image: null, note: 'NO_FRAME' },
					{ time: 1.5, image: null },
				],
			}),
		);
		expect(missing.layout.slots.every((s) => !s.drawn)).toBe(true);
	});

	it('never throws on hostile input', () => {
		fc.assert(
			fc.property(
				fc.record({
					width: fc.oneof(fc.integer({ min: -10, max: 5000 }), fc.constant(Number.NaN)),
					start: fc.oneof(fc.double({ min: -1e6, max: 1e6 }), fc.constant(Number.POSITIVE_INFINITY)),
					span: fc.double({ min: -10, max: 1000, noNaN: false }),
					levels: fc.uint8Array({ maxLength: 400 }),
					classes: fc.uint8Array({ maxLength: 400 }),
					frameSec: fc.double({ min: -1, max: 1 }),
					frames: fc.integer({ min: 0, max: 20 }),
					word: fc.string({ maxLength: 40 }),
				}),
				(r) => {
					const a: ViewAudio = { start: r.start, frameSec: r.frameSec, level: r.levels, classes: r.classes };
					const end = r.start + r.span;
					const out = drawRangeView({
						width: r.width,
						start: r.start,
						end,
						title: r.word,
						frames: Array.from({ length: r.frames }, (_, i) => ({
							time: i,
							image: i % 2 ? solid(3, 2, [1, 2, 3]) : { width: 5, height: 5, data: new Uint8Array(3) },
						})),
						audio: a,
						words: [{ text: r.word, start: r.start, end }],
						silences: silenceBands(a, r.start, end),
					});
					expect(out.image.data.length).toBe(out.image.width * out.image.height * 4);
				},
			),
			{ numRuns: 60 },
		);
	});
});

describe('rangeSummary', () => {
	it('lists the frame times, silence bands and words', () => {
		const i = input();
		const text = rangeSummary({
			title: 'clip.mp4',
			start: 0,
			end: 2,
			timeline: 'media time',
			frames: [i.frames![0]!, { time: 1.5, image: null, note: 'NO_FRAME' }],
			audio: { source: 'range analysis' },
			silences: i.silences,
			words: i.words,
			wordsDrawn: 2,
			image: { width: 480, height: 268 },
		});
		expect(text).toContain('frames (2, slot centres): 0.50, 1.50 (NO_FRAME)');
		expect(text).toContain('silences >= 0.4 s (1): 1.00-2.00 (1.00 s)');
		expect(text).toContain('words (2): [0.10] hello [0.50] world');
		const none = rangeSummary({
			title: 'x',
			start: 0,
			end: 1,
			timeline: 'media time',
			frames: null,
			audio: null,
			silences: null,
			words: null,
			wordsDrawn: 0,
			image: { width: 480, height: 40 },
		});
		expect(none).toContain('frames: none (no video)');
		expect(none).toContain('audio: none');
		expect(none).toContain('words: no transcript');
	});
});
