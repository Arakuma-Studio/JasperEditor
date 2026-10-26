// Frame-rate conform (docs/wp-notes/time.md §15): which source frame a sequence frame shows when the media rate
// differs from the sequence's (S01:CLP-004 nearest-earlier sampling through `frameIndexAt`), and which clips the
// render snapshot hands to the frame-exact retime pipeline because linear playback cannot show those frames.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	frameIndexAt,
	isLinearFrameSampling,
	type MediaAsset,
	type MediaHandle,
	needsRetime,
	RATES,
	type Rational,
	samplesOnFrameGrid,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

/** The source frame shown at sequence frame `f` of a clip starting at frame 0 with in-point `inFrames` media frames. */
function shown(media: Rational, seq: Rational, f: number, inFrames = 0, speed = 1): number {
	const sourceIn = (inFrames * FLICKS_PER_SECOND * media.den) / media.num;
	const content = sourceIn + f * flicksPerFrame(seq) * speed;
	return frameIndexAt({ kind: 'cfr', rate: media, count: 1 << 30 }, content / FLICKS_PER_SECOND);
}
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

describe('the frame each sequence frame shows (S01:CLP-004, frameIndexAt)', () => {
	it('29.97 → 30: frame 0 twice, then f − 1 until source frame 1000 repeats at sequence frame 1002', () => {
		const m = (f: number) => shown(RATES.r29_97, RATES.r30, f);
		expect(range(0, 6).map(m)).toEqual([0, 0, 1, 2, 3, 4]);
		expect(range(998, 1004).map(m)).toEqual([997, 998, 999, 1000, 1000, 1001]);
	});
	it('23.976 → 24 has the same shape', () => {
		const m = (f: number) => shown(RATES.r23_976, RATES.r24, f);
		expect(range(0, 4).map(m)).toEqual([0, 0, 1, 2]);
		expect(range(999, 1003).map(m)).toEqual([998, 999, 1000, 1000]);
	});
	it('30 → 29.97 skips one source frame in 1000 (frame 1000), not the nearest frame from frame 500', () => {
		const m = (f: number) => shown(RATES.r30, RATES.r29_97, f);
		expect(range(498, 503).map(m)).toEqual([498, 499, 500, 501, 502]);
		expect(range(998, 1002).map(m)).toEqual([998, 999, 1001, 1002]);
	});
	it('25 → 30 repeats every fifth source frame at the containing (not the nearest) frame', () => {
		expect(range(0, 13).map((f) => shown(RATES.r25, RATES.r30, f))).toEqual([
			0, 0, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 10,
		]);
	});
	it('60 → 30 shows every second frame; 30 → 30 frame for frame from the in-point', () => {
		expect(range(0, 5).map((f) => shown(RATES.r60, RATES.r30, f))).toEqual([0, 2, 4, 6, 8]);
		expect(range(0, 5).map((f) => shown(RATES.r30, RATES.r30, f, 11))).toEqual([11, 12, 13, 14, 15]);
	});
	it('equals exact rational floor for every pair of allowed rates, in-point and frame (fast-check)', () => {
		const rates = Object.values(RATES);
		fc.assert(
			fc.property(
				fc.constantFrom(...rates),
				fc.constantFrom(...rates),
				fc.integer({ min: 0, max: 5000 }),
				fc.integer({ min: 0, max: 20_000 }),
				(media, seq, inFrames, f) => {
					// source frame = floor((in/mr + f/sr)·mr) = floor(in + f·mr/sr), exactly in integers
					const num = BigInt(inFrames) * BigInt(seq.num) * BigInt(media.den) + BigInt(f) * BigInt(media.num) * BigInt(seq.den);
					const den = BigInt(seq.num) * BigInt(media.den);
					expect(shown(media, seq, f, inFrames)).toBe(Number(num / den));
				},
			),
			{ numRuns: 400 },
		);
	});
});

describe('samplesOnFrameGrid / needsRetime: Frame Sampling goes frame-exact where linear playback cannot', () => {
	const clip = (over: Partial<{ sourceIn: number; rate: number; hold: number }> = {}) => ({
		start: 0,
		duration: 100,
		sourceIn: over.sourceIn ?? 0,
		speed: { rate: over.rate ?? 1, reverse: false },
		kind: 'video',
		frameHold: over.hold === undefined ? null : { flicks: over.hold },
	});
	const F30 = flicksPerFrame(RATES.r30);
	it('same rate at 100 % from a frame boundary, and whole-frame steps, stay linear', () => {
		const o = { sequenceRate: RATES.r30, mediaRate: RATES.r30 };
		expect(samplesOnFrameGrid(clip({ sourceIn: 37 * F30 }), o)).toBe(true);
		expect(needsRetime(clip({ sourceIn: 37 * F30 }), o)).toBe(false);
		expect(samplesOnFrameGrid(clip({ rate: 2 }), o)).toBe(true);
		expect(samplesOnFrameGrid(clip(), { sequenceRate: RATES.r30, mediaRate: RATES.r60 })).toBe(true);
		expect(samplesOnFrameGrid(clip({ hold: 12 * F30 }), o)).toBe(true);
	});
	it('rate conform, fractional speeds, in-points and holds between frames go frame-exact', () => {
		for (const [m, s] of [
			[RATES.r29_97, RATES.r30],
			[RATES.r30, RATES.r29_97],
			[RATES.r23_976, RATES.r24],
			[RATES.r25, RATES.r30],
			[RATES.r30, RATES.r60],
		] as const)
			expect(needsRetime(clip(), { sequenceRate: s, mediaRate: m }), `${m.num}/${m.den} → ${s.num}`).toBe(true);
		const o = { sequenceRate: RATES.r30, mediaRate: RATES.r30 };
		expect(needsRetime(clip({ rate: 0.7 }), o)).toBe(true);
		expect(needsRetime(clip({ sourceIn: F30 / 2 }), o)).toBe(true);
		expect(needsRetime(clip({ hold: F30 * 3.5 }), o)).toBe(true);
		// within FRAME_TIME_EPS (2 µs) of a frame counts as on it
		expect(needsRetime(clip({ sourceIn: 37 * F30 + 1000 }), o)).toBe(false);
		// no media rate known: unchanged (linear)
		expect(needsRetime(clip({ sourceIn: F30 / 2 }), { sequenceRate: RATES.r30 })).toBe(false);
	});
	it('isLinearFrameSampling: the builder draws plain Frame Sampling; reverse, remaps, VFR, blending and time maps are the stage’s', () => {
		const base = { retime: { interpolation: 'frame-sampling' as const, vfr: false }, speed: { reverse: false } };
		expect(isLinearFrameSampling(base)).toBe(true);
		expect(isLinearFrameSampling({ ...base, retime: undefined })).toBe(false);
		expect(isLinearFrameSampling({ ...base, speed: { reverse: true } })).toBe(false);
		expect(isLinearFrameSampling({ ...base, retime: { interpolation: 'frame-blending', vfr: false } })).toBe(false);
		expect(isLinearFrameSampling({ ...base, retime: { interpolation: 'frame-sampling', vfr: true } })).toBe(false);
		expect(isLinearFrameSampling({ ...base, mediaTime: { scale: 0.5 } })).toBe(false);
		expect(
			isLinearFrameSampling({ ...base, timeRemap: { enabled: true, keyframes: [] } as never }),
		).toBe(false);
	});
	it('the render snapshot marks a 29.97 fps clip in a 30 fps sequence retimed (Frame Sampling), a 30 fps one not', () => {
		const h = new Harness();
		const ids = (fps: Rational) =>
			(h.ok([{ type: 'media.register', asset: videoAsset({ fps, audio: false }) }]).results[0] as { mediaId: string })
				.mediaId;
		const ntsc = ids(RATES.r29_97);
		const plain = ids(RATES.r30);
		h.ok([
			{ type: 'clip.place', source: { mediaId: ntsc }, at: 0, matchSequence: 'keep', audio: false },
			{ type: 'clip.place', source: { mediaId: plain }, at: 400, matchSequence: 'keep', audio: false },
		]);
		const resolve = (a: MediaAsset): MediaHandle => ({
			url: `/media/${a.id}`,
			proxyUrl: null,
			kind: a.kind,
			width: 1920,
			height: 1080,
			durationFlicks: a.probe.durationFlicks,
			hasAudio: false,
			rotation: 0,
		});
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: resolve, resolveFont: () => null });
		const clips = snap.videoTracks[0]!.clips;
		const byMedia = (id: string) => clips.find((c) => 'mediaId' in c.source && c.source.mediaId === id)!;
		expect(byMedia(ntsc).retime).toEqual({ interpolation: 'frame-sampling', mediaRate: RATES.r29_97, vfr: false });
		expect(isLinearFrameSampling(byMedia(ntsc))).toBe(true);
		expect(byMedia(plain).retime).toBeUndefined();
	});
});
