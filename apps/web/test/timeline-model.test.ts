// Timeline model contracts: frame seeking, zoom, scrolling, snapping, sprite lookup, and waveform reduction.
import { RATES } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nearestTile, type SpriteIndexLike } from '../src/panels/timeline/model/filmstrip.ts';
import { rulerTicks } from '../src/panels/timeline/model/ruler.ts';
import { findSnap, type SnapTarget } from '../src/panels/timeline/model/snapping.ts';
import {
	boundaryFrameAt,
	clampScroll,
	deltaFramesFromPx,
	frameToX,
	minPxPerFrame,
	PX_PER_FRAME_MAX,
	seekFrameAt,
	type Viewport,
	wheelIntent,
	xToFrameExact,
} from '../src/panels/timeline/model/viewport.ts';
import { drawGain, reduceColumns, waveBars } from '../src/panels/timeline/model/waveform.ts';

describe('viewport math (TL-100…113, TL-1053)', () => {
	it('xToFrame(frameToX(f)) = f across zoom levels and scroll positions', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 10_368_000 }), // 24 h at 120 fps
				fc.double({ min: 0.0005, max: PX_PER_FRAME_MAX, noNaN: true }),
				fc.double({ min: -100, max: 10_000_000, noNaN: true }),
				(f, p, s) => {
					const v: Viewport = { scrollFrame: s, pxPerFrame: p, width: 1200 };
					const back = xToFrameExact(v, frameToX(v, f));
					expect(Math.abs(back - f)).toBeLessThan(1e-6);
					expect(boundaryFrameAt(v, frameToX(v, f))).toBe(f);
					// Clicking anywhere inside a frame's cell lands on that frame (floor rule).
					expect(seekFrameAt(v, frameToX(v, f) + p * 0.5, Number.MAX_SAFE_INTEGER)).toBe(f);
				},
			),
			{ numRuns: 2000, seed: 1 },
		);
	});

	it('AC-3a: a 3 h 29.97 sequence zooms to ≥ 40 px per frame anywhere and trims move 1 frame per 40 px', () => {
		const end = Math.round(3 * 3600 * (30000 / 1001));
		const width = 1400;
		expect(minPxPerFrame(end, 29.97, width)).toBeLessThan(0.01);
		const v: Viewport = { scrollFrame: end - 30, pxPerFrame: 40, width };
		const clamped = clampScroll(v, end + (width / 40) * 0.5);
		expect(clamped).toBe(end - 30);
		expect(frameToX(v, end) - frameToX(v, end - 1)).toBeGreaterThanOrEqual(40);
		expect(deltaFramesFromPx(40, 40)).toBe(1);
		expect(deltaFramesFromPx(-40, 40)).toBe(-1);
		expect(deltaFramesFromPx(19, 40)).toBe(0);
		expect(deltaFramesFromPx(20, 40)).toBe(1);
		expect(deltaFramesFromPx(-20, 40)).toBe(-1);
		expect(deltaFramesFromPx(400, 40)).toBe(10);
	});

	it('scroll is clamped to [-leftPad, extent - W/p]', () => {
		const v = { scrollFrame: -1000, pxPerFrame: 2, width: 1000 };
		expect(clampScroll(v, 2000)).toBe(-8);
		expect(clampScroll({ ...v, scrollFrame: 99_999 }, 2000)).toBe(1500);
	});

	it('wheel mapping follows TL-111', () => {
		const base = { dx: 0, dy: 100, ctrlKey: false, altKey: false, shiftKey: false };
		expect(wheelIntent(base, { mac: false }).kind).toBe('hscroll');
		expect(wheelIntent({ ...base, ctrlKey: true }, { mac: false }).kind).toBe('vscroll');
		expect(wheelIntent({ ...base, altKey: true }, { mac: false }).kind).toBe('zoom');
		expect(wheelIntent(base, { mac: true }).kind).toBe('both');
		expect(wheelIntent({ ...base, shiftKey: true }, { mac: true }).kind).toBe('hscroll');
		expect(wheelIntent(base, { mac: true, pinch: true }).kind).toBe('zoom');
		expect(wheelIntent(base, { mac: false, preferHorizontal: false }).kind).toBe('both');
	});
});

describe('ruler (A.9, TL-201/202)', () => {
	it('drop-frame rulers use drop-frame labels', () => {
		const v = { scrollFrame: 1790, pxPerFrame: 20, width: 800 };
		const ticks = rulerTicks(v, RATES.r29_97, { dropFrame: true, startFrames: 0, sequenceEnd: 100_000 });
		expect(ticks.some((t) => t.label?.includes(';'))).toBe(true);
	});
});

describe('snapping (A.3)', () => {
	const t = (frame: number, kind: SnapTarget['kind'], priority: number): SnapTarget => ({
		frame,
		kind,
		priority,
	});
	it('nearest target within the threshold wins, then priority', () => {
		const targets = [t(0, 'zero', 1), t(100, 'clip', 2), t(104, 'playhead', 5)];
		expect(findSnap(targets, [102], 3)?.target.kind).toBe('playhead');
		expect(findSnap(targets, [101], 3)?.target.frame).toBe(100);
		expect(findSnap(targets, [110], 3)).toBeNull();
		expect(findSnap(targets, [50, 98], 3)?.offset).toBe(2);
	});
});

describe('filmstrip from the sprite contract (TH-003, TL-328, AC-7d)', () => {
	const index: SpriteIndexLike = {
		tileWidth: 160,
		tileHeight: 90,
		columns: 10,
		tiles: Array.from({ length: 30 }, (_, i) => ({ sheet: Math.floor(i / 100), index: i, timeSec: i * 2 })),
	};
	it('uses the nearest tile at or before the requested time', () => {
		expect(nearestTile(index, 5.9)?.timeSec).toBe(4);
		expect(nearestTile(index, 6)?.timeSec).toBe(6);
		expect(nearestTile(index, -1)?.timeSec).toBe(0);
		expect(nearestTile(index, 999)?.timeSec).toBe(58);
	});
});

describe('waveform reduction (WF-001/003, TL-331/333)', () => {
	const peaks = new Float32Array(Array.from({ length: 1000 }, (_, i) => (i % 100) / 100));
	it('takes the max over the peaks covered by each column', () => {
		const cols = reduceColumns(peaks, { startSec: 0, secPerColumn: 0.5, columns: 4, peaksPerSecond: 100 });
		expect(Array.from(cols).map((x) => Math.round(x * 100))).toEqual([49, 99, 49, 99]);
	});
	it('upsamples by interpolation beyond 100 px per second', () => {
		const cols = reduceColumns(peaks, {
			startSec: 0.1,
			secPerColumn: 0.001,
			columns: 3,
			peaksPerSecond: 100,
		});
		expect(cols[0]).toBeGreaterThan(0.09);
		expect(cols[2]).toBeLessThan(0.11);
	});
	it('AC-7b: -6 dB halves the drawn amplitude; clipping is flagged', () => {
		const g = drawGain(-6, 0);
		expect(g).toBeCloseTo(0.501, 2);
		const bars = waveBars(new Float32Array([0.8, 1]), { x: 0, top: 0, height: 100 }, g, 'rectified');
		expect(bars[0]!.height).toBeCloseTo(40.1, 0);
		const loud = waveBars(new Float32Array([0.8]), { x: 0, top: 0, height: 100 }, drawGain(6, 0), 'centered');
		expect(loud[0]!.clipped).toBe(true);
		expect(loud[0]!.height).toBe(100);
	});
});
