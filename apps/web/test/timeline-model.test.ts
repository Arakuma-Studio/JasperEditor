// Timeline math and model tests (S02:TL-1053 and friends): viewport round trips, zoom anchoring,
// ruler ticks, snapping, filmstrip slots aligned with clip edges, waveform reduction.
import { flicksPerFrame, RATES } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	filmstripSlots,
	nearestTile,
	type SpriteIndexLike,
	tileRect,
} from '../src/panels/timeline/model/filmstrip.ts';
import {
	computeLayout,
	hitY,
	regionIndexAt,
	stepHeight,
	visibleRows,
} from '../src/panels/timeline/model/layout.ts';
import { chooseTicks, majorCandidates, rulerTicks, shortLabel } from '../src/panels/timeline/model/ruler.ts';
import { findSnap, type SnapTarget } from '../src/panels/timeline/model/snapping.ts';
import {
	autoScrollSpeed,
	boundaryFrameAt,
	clampScroll,
	deltaFramesFromPx,
	frameToX,
	minPxPerFrame,
	PX_PER_FRAME_MAX,
	seekFrameAt,
	type Viewport,
	wheelIntent,
	wheelZoomFactor,
	xToFrameExact,
	zoomAround,
	zoomToSequenceViewport,
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

	it('zoom anchoring keeps the anchor frame within 0.5 px (A.2)', () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0.01, max: 48, noNaN: true }),
				fc.double({ min: 0.01, max: 48, noNaN: true }),
				fc.double({ min: 0, max: 1200, noNaN: true }),
				fc.double({ min: 0, max: 1_000_000, noNaN: true }),
				(p0, p1, ax, s) => {
					const v = { scrollFrame: s, pxPerFrame: p0, width: 1200 };
					const anchorFrame = xToFrameExact(v, ax);
					const z = zoomAround(v, p1, ax);
					expect(Math.abs(frameToX(z, anchorFrame) - ax)).toBeLessThan(0.5);
				},
			),
			{ numRuns: 2000, seed: 2 },
		);
	});

	it('AC-3b: 20 Alt+wheel steps over a point keep the frame under the pointer within 1 px', () => {
		let v: Viewport = { scrollFrame: 5000, pxPerFrame: 0.5, width: 1400 };
		const x = 700;
		const f = xToFrameExact(v, x);
		for (let i = 0; i < 20; i++) {
			const factor = wheelZoomFactor(i % 2 ? 120 : -100);
			v = zoomAround(v, Math.min(PX_PER_FRAME_MAX, v.pxPerFrame * factor), x);
			expect(Math.abs(frameToX(v, f) - x)).toBeLessThan(1);
		}
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

	it('minimum zoom fits max(end, 10 s) × 1.1 and zoom-to-sequence starts at the left pad', () => {
		expect(minPxPerFrame(0, 30, 1100)).toBeCloseTo(1100 / (300 * 1.1));
		const z = zoomToSequenceViewport({ scrollFrame: 500, pxPerFrame: 10, width: 1100 }, 3000, 30);
		expect(z.pxPerFrame).toBeCloseTo(1100 / 3300);
		expect(frameToX(z, 0)).toBeCloseTo(16);
		expect(frameToX(z, 3000)).toBeLessThanOrEqual(1100);
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

	it('auto-scroll speed grows quadratically to 30 px per frame at the edge (TL-117)', () => {
		expect(autoScrollSpeed(0)).toBe(0);
		expect(autoScrollSpeed(20)).toBeCloseTo(7.5);
		expect(autoScrollSpeed(40)).toBe(30);
		expect(autoScrollSpeed(400)).toBe(30);
	});
});

describe('ruler (A.9, TL-201/202)', () => {
	it('picks the smallest major interval with ≥ 80 px and a minor division with ≥ 8 px', () => {
		expect(majorCandidates(RATES.r25)).not.toContain(12.5);
		expect(majorCandidates(RATES.r30)).toContain(15);
		expect(chooseTicks(48, RATES.r30)).toEqual({ major: 2, minor: 1, perFrame: true });
		expect(chooseTicks(1, RATES.r30)).toEqual({ major: 90 + 60, minor: 15, perFrame: false });
		expect(chooseTicks(0.01, RATES.r30).major).toBe(5 * 60 * 30);
	});

	it('labels use the short form under one hour and never drift from exact frames', () => {
		expect(shortLabel('00:00:15:00', true)).toBe(':15:00');
		expect(shortLabel('00:01:15:00', true)).toBe('01:15:00');
		expect(shortLabel('01:00:15:00', true)).toBe('01:00:15:00');
		const v = { scrollFrame: 100.25, pxPerFrame: 3, width: 900 };
		const ticks = rulerTicks(v, RATES.r30, { dropFrame: false, startFrames: 0, sequenceEnd: 1000 });
		const majors = ticks.filter((t) => t.kind === 'major');
		expect(majors.length).toBeGreaterThan(3);
		for (const t of ticks) expect(t.x).toBeCloseTo(frameToX(v, t.frame), 9);
	});

	it('drop-frame rulers use drop-frame labels', () => {
		const v = { scrollFrame: 1790, pxPerFrame: 20, width: 800 };
		const ticks = rulerTicks(v, RATES.r29_97, { dropFrame: true, startFrames: 0, sequenceEnd: 100_000 });
		expect(ticks.some((t) => t.label?.includes(';'))).toBe(true);
	});
});

describe('layout (TL-114…116, TL-261…263)', () => {
	const tracks = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}` }));
	it('video is bottom-aligned above the divider, audio top-aligned below it', () => {
		const l = computeLayout({
			height: 404,
			dividerRatio: 0.5,
			videoTracks: tracks('v', 3),
			audioTracks: tracks('a', 2),
			heights: {},
			scrollYVideo: 0,
			scrollYAudio: 0,
		});
		expect(l.dividerTop).toBe(200);
		const v1 = l.video.rows.find((r) => r.trackId === 'v1')!;
		expect(v1.y + v1.height).toBe(200);
		expect(l.video.rows[0]!.trackId).toBe('v3');
		expect(l.audio.rows[0]).toMatchObject({ trackId: 'a1', y: 204 });
		expect(hitY(l, 10)).toMatchObject({ kind: 'above-video' });
		expect(hitY(l, 201)).toEqual({ kind: 'divider' });
		expect(hitY(l, 210)).toMatchObject({ kind: 'track', row: { trackId: 'a1' } });
		expect(regionIndexAt(l, 'video', 10)).toBeGreaterThanOrEqual(3);
		expect(regionIndexAt(l, 'audio', 390)).toBeGreaterThanOrEqual(2);
	});

	it('virtualizes rows to the visible band plus one', () => {
		const l = computeLayout({
			height: 204,
			dividerRatio: 0.5,
			videoTracks: tracks('v', 40),
			audioTracks: tracks('a', 40),
			heights: {},
			scrollYVideo: 0,
			scrollYAudio: 0,
		});
		expect(visibleRows(l.video).length).toBeLessThan(6);
		expect(visibleRows(l.audio).length).toBeLessThan(6);
	});

	it('height steps follow TL-263', () => {
		expect(stepHeight(32, 1)).toBe(48);
		expect(stepHeight(32, -1)).toBe(20);
		expect(stepHeight(240, 1)).toBe(240);
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
		expect(tileRect(index, index.tiles[13]!)).toEqual({ sx: 480, sy: 90, sw: 160, sh: 90 });
	});

	it('slots stay aligned with the clip edge at any scroll and zoom', () => {
		const F = flicksPerFrame(RATES.r30);
		fc.assert(
			fc.property(
				fc.double({ min: 0.2, max: 48, noNaN: true }),
				fc.double({ min: -50, max: 400, noNaN: true }),
				fc.integer({ min: 0, max: 600 }),
				(p, scroll, inFrames) => {
					const base = {
						start: 100,
						duration: 300,
						sourceIn: inFrames * F,
						rate: 1,
						reverse: false,
						pxPerFrame: p,
						visibleX0: 0,
						visibleX1: 1200,
						slotWidth: 71,
						fps: RATES.r30,
					};
					const a = filmstripSlots({ ...base, scrollFrame: scroll });
					const b = filmstripSlots({ ...base, scrollFrame: scroll + 7 });
					// Every slot's offset from the clip start is invariant under scrolling.
					const clipX = (s: number) => (100 - s) * p;
					const offA = new Set(a.map((s) => Math.round((s.x - clipX(scroll)) * 1e6)));
					for (const s of b) {
						const off = Math.round((s.x - clipX(scroll + 7)) * 1e6);
						if (s.x > 0 && s.x + s.w < 1200 && a.length) expect(offA.has(off) || a.length < 2).toBe(true);
					}
					// Slots cover the visible part of the clip without gaps.
					const sorted = [...a].sort((x, y) => x.x - y.x);
					for (let i = 1; i < sorted.length; i++)
						expect(Math.abs(sorted[i]!.x - (sorted[i - 1]!.x + sorted[i - 1]!.w))).toBeLessThan(1e-6);
					for (const s of a) {
						expect(s.w).toBeGreaterThanOrEqual(71 - 1e-9);
						// The time shown is inside the clip's source range (± one slot).
						const t0 = (inFrames - 1) / 30;
						expect(s.timeSec).toBeGreaterThan(t0 - s.w / p / 30 - 1);
					}
				},
			),
			{ numRuns: 300, seed: 3 },
		);
	});

	it('the first slot starts at the clip edge when sourceIn is on the ladder', () => {
		const slots = filmstripSlots({
			start: 10,
			duration: 100,
			sourceIn: 0,
			rate: 1,
			reverse: false,
			scrollFrame: 0,
			pxPerFrame: 10,
			visibleX0: 0,
			visibleX1: 2000,
			slotWidth: 64,
			fps: RATES.r30,
		});
		expect(slots[0]!.x).toBe(100);
		expect(slots[slots.length - 1]!.x + slots[slots.length - 1]!.w).toBeGreaterThanOrEqual(1100);
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
