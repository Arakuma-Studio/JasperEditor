import { describe, expect, it } from 'vitest';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import {
	revealRowScroll,
	revealScroll,
	visibleFrames,
	visiblePart,
	visibleRowBand,
} from '../src/panels/timeline/model/locate.ts';

const v = { scrollFrame: 100, pxPerFrame: 10, width: 1000 }; // frames 100..200 on screen

describe('visible part of a clip', () => {
	it('is the clip itself when it fits on screen', () => {
		expect(visibleFrames(v)).toEqual([100, 200]);
		expect(visiblePart(v, 120, 150)).toEqual([120, 150]);
	});
	it('is clipped to the visible range when the clip runs off either side', () => {
		// The whole clip's centre (frame 250) is off screen; the visible part's centre (175) is not.
		expect(visiblePart(v, 150, 350)).toEqual([150, 200]);
		expect(visiblePart(v, 0, 130)).toEqual([100, 130]);
		expect(visiblePart(v, 0, 1000)).toEqual([100, 200]);
	});
	it('is null when nothing (or under a pixel) shows', () => {
		expect(visiblePart(v, 300, 400)).toBeNull();
		expect(visiblePart(v, 0, 100)).toBeNull();
		expect(visiblePart(v, 199.95, 260)).toBeNull();
	});
});

describe('scrolling a target into view', () => {
	it('does nothing when part of it shows', () => {
		expect(revealScroll(v, 150, 350)).toBeNull();
	});
	it('centres a target that fits', () => {
		const s = revealScroll(v, 500, 540)!;
		expect(s).toBe(470);
		expect(visiblePart({ ...v, scrollFrame: s }, 500, 540)).toEqual([500, 540]);
	});
	it('shows the start of a target wider than the view', () => {
		const s = revealScroll(v, 1000, 5000)!;
		expect(s).toBe(990);
		expect(visiblePart({ ...v, scrollFrame: s }, 1000, 5000)).toEqual([1000, 1090]);
	});
});

describe('track rows', () => {
	const tracks = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}` }));
	const layout = (scrollYVideo: number, scrollYAudio: number) =>
		computeLayout({
			height: 300,
			dividerRatio: 0.5,
			videoTracks: tracks(8, 'v'),
			audioTracks: tracks(8, 'a'),
			heights: {},
			scrollYVideo,
			scrollYAudio,
			showMaster: false,
		});
	it('a row scrolled out of its region has no visible band; revealing it brings it fully into view', () => {
		for (const kind of ['video', 'audio'] as const) {
			let l = layout(0, 0);
			const region = () => l[kind];
			const id = kind === 'video' ? 'v8' : 'a8'; // the far end of each region
			const row = () => region().rows.find((r) => r.trackId === id)!;
			expect(visibleRowBand(region(), row())).toBeNull();
			const next = revealRowScroll(region(), row(), 0)!;
			expect(next).toBeGreaterThan(0);
			l = kind === 'video' ? layout(next, 0) : layout(0, next);
			const band = visibleRowBand(region(), row())!;
			expect(band[1] - band[0]).toBe(row().height);
			expect(revealRowScroll(region(), row(), next)).toBeNull();
		}
	});
	it('a partly visible row is aimed at its visible band', () => {
		let checked = 0;
		for (let s = 0; s <= layout(0, 0).video.maxScroll; s += 7) {
			const l = layout(s, 0);
			const r = l.video.rows.find((x) => x.y < l.video.top && x.y + x.height > l.video.top + 1);
			if (!r) continue;
			expect(visibleRowBand(l.video, r)).toEqual([l.video.top, r.y + r.height]);
			checked++;
		}
		expect(checked).toBeGreaterThan(0);
	});
});
