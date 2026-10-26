// spec 13 AS-074 regression: a kernel stream whose sink fails while frames are being drawn rejects with the sink's
// error; the draws still in flight (rejected when the stream closes its worker pool) are not unhandled rejections,
// which would end the engine process (seen as "taps pool closed" when a pipelined export restarted its composite).
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { singleTap } from '../src/export/stream/lowered.ts';
import { planTapStream, type TapMember } from '../src/export/stream/tap-plan.ts';
import { streamTaps } from '../src/export/stream/taps.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { TEST_FFMPEG, TEST_FFPROBE } from './helpers.ts';

const FPS = { num: 30, den: 1 };
const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });

function member(id: string, f0: number, f1: number, source = 'color=c=red'): TapMember {
	const w = 256;
	return {
		clipId: id,
		f0,
		f1,
		pictures: [
			{ w, h: w, inputs: [['-f', 'lavfi', '-i', `${source}:s=${w}x${w}:r=1`]], filter: '[0:v]format=rgba' },
		],
		frames: Array.from({ length: f1 - f0 }, () => ({
			rect: [0, 0, 512, 512] as [number, number, number, number],
			opacity: 1,
			level: 0,
			// Several taps: each frame's draw takes a while, so many are in flight when the sink fails.
			prog: [
				4,
				4,
				...[0, 1, 2, 3].flatMap((k) => singleTap([0.5, 0, k, 0, 0.5, k], [0, 0, w, w], 1).slice(2)),
			],
		})),
	};
}

describe('kernel stream failure (AS-074)', () => {
	it('a sink that fails mid-stream rejects the stream; draws in flight are not unhandled rejections', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on('unhandledRejection', onUnhandled);
		try {
			const plan = planTapStream([member('a', 0, 60), member('b', 60, 120)], 1920, 1080, FPS);
			let writes = 0;
			const sink = new Writable({
				write(_chunk, _enc, cb) {
					writes++;
					if (writes === 3) cb(new Error('EPIPE (composite exited)'));
					else setTimeout(cb, 5);
				},
			});
			sink.on('error', () => undefined);
			const ac = new AbortController();
			await expect(streamTaps(ff, plan, sink, { workers: 4, signal: ac.signal })).rejects.toThrow(
				/layer stream/,
			);
			// Let the closed pool's rejections settle.
			await new Promise((r) => setTimeout(r, 200));
			expect(unhandled.map(String)).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	}, 60_000);

	it('a member whose picture fails to decode rejects the stream; frames in flight are not unhandled rejections', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on('unhandledRejection', onUnhandled);
		try {
			const plan = planTapStream(
				[member('a', 0, 40), member('b', 40, 80, 'nosuchsource=c=red')],
				1920,
				1080,
				FPS,
			);
			const sink = new Writable({
				write(_chunk, _enc, cb) {
					setTimeout(cb, 20);
				},
			});
			const ac = new AbortController();
			await expect(streamTaps(ff, plan, sink, { workers: 4, signal: ac.signal })).rejects.toThrow(
				/picture decoder/,
			);
			await new Promise((r) => setTimeout(r, 1500));
			expect(unhandled.map(String)).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	}, 60_000);

	it('a sink that fails while the stream waits for the next member’s still: no unhandled rejection', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on('unhandledRejection', onUnhandled);
		try {
			// The second member's still is still baking (pipelined, AS-076) when the first one's frames are written.
			const late = member('b', 3, 60);
			late.ready = new Promise((r) => setTimeout(() => r({ ok: true }), 400));
			const plan = planTapStream([member('a', 0, 3), late], 1920, 1080, FPS);
			const sink = new Writable({
				write(_chunk, _enc, cb) {
					setTimeout(() => cb(new Error('This socket has been ended by the other party')), 20);
				},
			});
			sink.on('error', () => undefined);
			const ac = new AbortController();
			await expect(streamTaps(ff, plan, sink, { workers: 2, signal: ac.signal })).rejects.toThrow(/layer stream/);
			await new Promise((r) => setTimeout(r, 800));
			expect(unhandled.map(String)).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	}, 60_000);
});
