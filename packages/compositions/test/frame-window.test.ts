import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FRAME_WINDOW_PAGE, framePage, inFrameWindow } from '../src/frame-window.tsx';

describe('FrameWindow', () => {
	it('keeps every item whose span holds the frame (and the next page of frames)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -5000, max: 500_000 }),
				fc.integer({ min: 1, max: 20_000 }),
				fc.integer({ min: 0, max: 600 }),
				fc.integer({ min: 0, max: 600_000 }),
				(from, duration, premount, frame) => {
					const span = [from - premount, from + duration] as const;
					const shows = frame >= span[0] && frame < span[1];
					if (shows) expect(inFrameWindow(span, framePage(frame))).toBe(true);
					// Within the current page, the window never changes: the whole page is covered.
					const page = framePage(frame);
					for (const f of [page * FRAME_WINDOW_PAGE, (page + 1) * FRAME_WINDOW_PAGE - 1])
						if (f >= span[0] && f < span[1]) expect(inFrameWindow(span, page)).toBe(true);
				},
			),
			{ numRuns: 2000 },
		);
	});

	it('leaves out items far from the frame', () => {
		expect(inFrameWindow([0, 30], framePage(10_000))).toBe(false);
		expect(inFrameWindow([10_000, 10_030], framePage(0))).toBe(false);
		expect(inFrameWindow([0, 30], framePage(15))).toBe(true);
	});
});
