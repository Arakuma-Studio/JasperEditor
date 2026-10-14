// WP0.1 (spec 12 Phase 0): reverse audio scrubbing near the start of a sequence played content after the playhead
// (the window was clamped to sample 0 but kept its length, then reversed).
import { describe, expect, it } from 'vitest';
import { scrubWindow } from '../src/audio/scrub.ts';

const FPS = { num: 30, den: 1 };

describe('audio scrub window', () => {
	it('forwards: from the playhead', () => {
		expect(scrubWindow(10, FPS, 48000, 0.04, false)).toEqual({ start: 16000, length: 1920 });
	});

	it('reverse: the snippet ends at the playhead, shorter near frame 0, none at frame 0', () => {
		expect(scrubWindow(10, FPS, 48000, 0.04, true)).toEqual({ start: 14080, length: 1920 });
		expect(scrubWindow(1, FPS, 48000, 0.04, true)).toEqual({ start: 0, length: 1600 });
		expect(scrubWindow(0, FPS, 48000, 0.04, true)).toBeNull();
	});

	it('hostile input gives no snippet', () => {
		expect(scrubWindow(Number.NaN, FPS, 48000, 0.04, false)).toBeNull();
		expect(scrubWindow(-5, FPS, 48000, 0.04, false)).toBeNull();
		expect(scrubWindow(10, FPS, 48000, 0, false)).toBeNull();
		expect(scrubWindow(10, FPS, 48000, Number.POSITIVE_INFINITY, false)).toBeNull();
	});
});
