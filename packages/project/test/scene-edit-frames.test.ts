// Shot changes land on the frame the renderers show them (wp-note "Phase 6 → WP6.5b", item 9): Scene Edit
// Detection's `clip.applySceneEdits` and the sound-design scene source (`sceneCutCues`) map a change at media time c
// through the clip's speed / reverse / time remap to the first sequence frame whose SHOWN media frame is the new shot.
// The oracle is the renderers' own frame pick (`frameIndexAt`, timestamps compared with FRAME_TIME_EPS): the change
// is visible where the picked frame index reaches the first frame of the new shot. Scene detection reports frame
// timestamps as ffprobe prints them (rounded to 1 µs), so the exact mapping must tolerate that rounding both ways —
// 1 flick (the old command rule) is too strict when a timestamp rounds up, 1 ms (the old cue rule) too loose in slow
// motion. Rates: 23.976, 29.97, 30; speeds 100 %, 50 %, 150 %, 37 %, 3 %, reverse and
// a 40 % time remap.
import { describe, expect, it } from 'vitest';
import {
	clipMediaTimeFn,
	FLICKS_PER_SECOND,
	type FrameTimes,
	frameIndexAt,
	type Rational,
	SHOT_TIME_EPS,
	sceneCutCues,
	shotIndexAt,
	type VideoClip,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const MEDIA_RATES: Record<string, Rational> = {
	'23.976': { num: 24000, den: 1001 },
	'29.97': { num: 30000, den: 1001 },
	'30': { num: 30, den: 1 },
};

/** Frame timestamps as ffprobe prints them (`pts_time`, 6 decimals). */
function probedTimes(rate: Rational, seconds: number): number[] {
	const n = Math.floor((seconds * rate.num) / rate.den);
	return Array.from({ length: n }, (_, i) => Number(((i * rate.den) / rate.num).toFixed(6)));
}

type Speed = { rate: number; reverse?: boolean; remap?: boolean };

function setup(seqPreset: string, mediaRate: Rational, speed: Speed) {
	const h = new Harness({ preset: seqPreset });
	const mediaId = h.registerVideo({ seconds: 40, fps: mediaRate, audio: false });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId },
			at: 12,
			tracks: { video: 'V1' },
			sourceRange: { in: { seconds: 0.5 }, out: { seconds: 6.5 } },
		},
	]);
	const v = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
	if (speed.rate !== 1 || speed.reverse)
		h.ok([
			{
				type: 'clip.setSpeed',
				clipIds: [v],
				rate: speed.rate,
				reverse: speed.reverse ?? false,
				ripple: false,
			},
		]);
	if (speed.remap) {
		h.ok([{ type: 'timeRemap.enable', clipIds: [v], enabled: true }]);
		h.ok([{ type: 'timeRemap.addKeyframe', clipId: v, at: 40 }]);
		h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 50, speedPercent: 40 }]);
	}
	return { h, v, mediaId };
}

/** Frames where the picture the renderers show changes shot (the oracle). */
function renderedEdits(clip: VideoClip, rate: Rational, times: number[], cutFrames: number[]): number[] {
	const at = clipMediaTimeFn(clip, rate);
	const ft: FrameTimes = { kind: 'list', times };
	const shot = (f: number) => {
		const idx = frameIndexAt(ft, at(f) / FLICKS_PER_SECOND);
		return cutFrames.filter((k) => k <= idx).length;
	};
	const out: number[] = [];
	for (let f = clip.start + 1; f < clip.start + clip.duration; f++) if (shot(f) !== shot(f - 1)) out.push(f);
	return out;
}

// TIME-005: drop-frame only affects timecode input/display, not these integer-frame/flick inputs.
const SEQUENCES: [string, string][] = [
	['23.976', 'hd-1080p-23.976'],
	['29.97', 'hd-1080p-29.97'],
	['30', 'hd-1080p-30'],
];
const SPEEDS: [string, Speed][] = [
	['100 %', { rate: 1 }],
	['50 %', { rate: 0.5 }],
	['150 %', { rate: 1.5 }],
	['37 %', { rate: 0.37 }],
	['3 %', { rate: 0.03 }],
	['reverse', { rate: 1, reverse: true }],
	['40 % time remap', { rate: 1, remap: true }],
];

describe('shot changes land on the frame the renderers show them', () => {
	for (const [mediaLabel, mediaRate] of Object.entries(MEDIA_RATES))
		for (const [seqLabel, preset] of SEQUENCES)
			for (const [speedLabel, speed] of SPEEDS)
				it(`${mediaLabel} media in a ${seqLabel} sequence at ${speedLabel}`, () => {
					const { h, v, mediaId } = setup(preset, mediaRate, speed);
					const times = probedTimes(mediaRate, 40);
					// a change at every 7th media frame from frame 13 (both rounding directions of the µs timestamps)
					const cutFrames = Array.from({ length: 30 }, (_, i) => 13 + 7 * i).filter((k) => k < times.length);
					const cutsSec = cutFrames.map((k) => times[k]!);
					const clip = h.seq.clips[v] as VideoClip;
					const rate = h.seq.settings.frameRate;
					const want = renderedEdits(clip, rate, times, cutFrames);
					expect(want.length).toBeGreaterThan(0);
					// Scene Edit Detection (the web and MCP send flicks rounded from the job's seconds)
					const r = h.tx([
						{
							type: 'clip.applySceneEdits',
							clipId: v,
							cuts: cutsSec.map((s) => Math.round(s * FLICKS_PER_SECOND)),
							applyCuts: false,
							createSubclips: false,
							createMarkers: true,
						},
					]);
					expect(r.ok).toBe(true);
					const edits = (r as { results: { edits: number[] }[] }).results[0]!.edits;
					expect(edits).toEqual(want);
					// the sound-design scene source
					const cues = sceneCutCues(h.doc, h.seq, new Map([[mediaId, { cuts: cutsSec }]]));
					expect(cues.map((c) => c.frame)).toEqual(want);
				});
});

describe('the shared shot rule', () => {
	it('counts a change from the renderers’ frame-time tolerance on', () => {
		expect(SHOT_TIME_EPS).toBe(2e-6);
		const cuts = [1, 2, 3];
		expect(shotIndexAt(cuts, 0.5)).toBe(0);
		expect(shotIndexAt(cuts, 1)).toBe(1);
		// a timestamp printed 0.5 µs late still counts on its frame; 1 ms early does not
		expect(shotIndexAt(cuts, 2 - 0.5e-6)).toBe(2);
		expect(shotIndexAt(cuts, 2 - 0.001)).toBe(1);
		expect(shotIndexAt(cuts, 9)).toBe(3);
		expect(shotIndexAt([], 9)).toBe(0);
		expect(shotIndexAt(cuts, Number.NaN)).toBe(0);
	});
});
