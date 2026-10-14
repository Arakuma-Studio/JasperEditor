// Clip decoding for the offline mixer (audio/decode.ts) against real ffmpeg: the decoded samples must be exactly the
// clip's content span, forwards or reversed (sound-design Phase 0, WP0.2).
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLICKS_PER_SECOND } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { clipDecodeArgs } from '../src/audio/decode.ts';
import { TEST_FFMPEG } from './helpers.ts';

const SR = 48000;
const dir = mkdtempSync(join(tmpdir(), 'jasper-decode-'));
/** 4 s mono ramp: sample value = t / 4 (t in seconds), so every sample says which content time it is. */
const ramp = join(dir, 'ramp.wav');

beforeAll(() => {
	const r = spawnSync(TEST_FFMPEG, [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		`aevalsrc=t/4:s=${SR}:d=4`,
		'-c:a',
		'pcm_f32le',
		ramp,
	]);
	expect(r.status, r.stderr.toString()).toBe(0);
});

/** Content time (s) of every decoded sample, or NaN for silence. */
function decode(o: {
	sourceInSec: number;
	frames: number;
	reverse: boolean;
	tailHandle?: number;
	headHandle?: number;
	/** Decode only `[offset, offset + length)` samples of the clip's Sequence span. */
	window?: { offset: number; length: number };
}): number[] {
	const { args } = clipDecodeArgs({
		clip: {
			start: 30,
			duration: o.frames,
			sourceIn: Math.round(o.sourceInSec * FLICKS_PER_SECOND),
			headHandle: o.headHandle ?? 0,
			tailHandle: o.tailHandle ?? 0,
			speed: { rate: 1, reverse: o.reverse, maintainPitch: true },
			channels: { streamIndex: 0, map: [] },
		} as never,
		path: ramp,
		stream: {
			index: 0,
			type: 'audio',
			codec: 'pcm_f32le',
			sampleRate: SR,
			channels: 1,
			channelLayout: 'mono',
		},
		fps: { num: 30, den: 1 },
		sampleRate: SR,
		offset: o.window?.offset ?? 0,
		length:
			o.window?.length ?? Math.round(((o.frames + (o.headHandle ?? 0) + (o.tailHandle ?? 0)) * SR) / 30),
		soxr: false,
	});
	const r = spawnSync(TEST_FFMPEG, ['-v', 'error', ...args], { maxBuffer: 1 << 26, timeout: 60_000 });
	expect(r.status, r.stderr.toString()).toBe(0);
	const out: number[] = [];
	for (let i = 0; i < r.stdout.length / 4; i++) {
		const v = r.stdout.readFloatLE(i * 4);
		out.push(v === 0 ? Number.NaN : v * 4);
	}
	return out;
}

const close = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThan(3 / SR);

describe('clip decode alignment', () => {
	it('a forward clip decodes its content span sample-exactly', () => {
		const s = decode({ sourceInSec: 1, frames: 30, reverse: false });
		expect(s.length).toBe(SR);
		close(s[0]!, 1);
		close(s[SR / 2]!, 1.5);
		close(s[SR - 1]!, 2 - 1 / SR);
	});

	it('a reversed clip starts at its source out point (not 250 ms past it)', () => {
		const s = decode({ sourceInSec: 1, frames: 30, reverse: true });
		expect(s.length).toBe(SR);
		// Reversed: sample i plays content 2 s − (i + 1) / SR.
		close(s[0]!, 2 - 1 / SR);
		close(s[SR / 2]!, 1.5 - 1 / SR);
		close(s[SR - 1]!, 1);
	});

	it('a reversed clip whose tail handle reaches before the media start ends in silence', () => {
		// sourceIn 0.25 s, 1 s long, 15-frame tail handle: the tail handle plays content 0.25 s → −0.25 s.
		const s = decode({ sourceInSec: 0.25, frames: 30, reverse: true, tailHandle: 15 });
		expect(s.length).toBe(SR * 1.5);
		close(s[0]!, 1.25 - 1 / SR);
		close(s[SR - 1]!, 0.25);
		close(s[SR + SR / 8]!, 0.125 - 1 / SR);
		// content < 0: silence (the last 0.25 s), not a shifted copy of the media
		expect(s.slice(SR * 1.25 + 2).every((x) => Number.isNaN(x))).toBe(true);
	});

	it('a reversed window entirely before the media start is silence (phase 0 verification)', () => {
		// As above, but only the last 0.2 s is decoded: its content (−0.05 … −0.25 s) is all before the media start,
		// so the decoded span is empty. `atrim=duration=0` meant "no limit" (0.25 s of the file came out reversed) and
		// `apad=whole_dur=0` padded forever before `areverse`.
		const s = decode({
			sourceInSec: 0.25,
			frames: 30,
			reverse: true,
			tailHandle: 15,
			window: { offset: SR * 1.3, length: SR * 0.2 },
		});
		expect(s.length).toBe(SR * 0.2);
		expect(s.every((x) => Number.isNaN(x))).toBe(true);
	});

	it('a reversed clip whose head handle reaches past the media end starts in silence', () => {
		// sourceIn 3 s, 1 s long (content 3…4 s = the media end), 15-frame head handle: content 4.5 → 4 s is silence.
		const s = decode({ sourceInSec: 3, frames: 30, reverse: true, headHandle: 15 });
		expect(s.length).toBe(SR * 1.5);
		expect(s.slice(0, SR / 2 - 2).every((x) => Number.isNaN(x))).toBe(true);
		close(s[SR / 2 + 1]!, 4 - 2 / SR);
		close(s[SR * 1.5 - 1]!, 3);
	});
});
