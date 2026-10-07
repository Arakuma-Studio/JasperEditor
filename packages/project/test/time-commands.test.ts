// Time Remapping / Time Interpolation / frame hold / Scene Edit Detection commands (workstream `time`).
import { describe, expect, it } from 'vitest';
import {
	type Clip,
	checkInvariants,
	clipMediaTimeAt,
	clipSpeedAt,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	RATES,
	remapSegmentViews,
	repairDocument,
	type TimeRemap,
	type VideoClip,
} from '../src/index.ts';
import { Harness, makeCtx } from './helpers.ts';

const R = RATES.r30;
const F = flicksPerFrame(R);

function place(h: Harness, at: number, opts: { seconds?: number; inSec?: number; outSec?: number } = {}) {
	const m = h.registerVideo({ seconds: opts.seconds ?? 20 });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at,
			tracks: { video: 'V1', audio: 'A1' },
			sourceRange: { in: { seconds: opts.inSec ?? 0 }, out: { seconds: opts.outSec ?? 4 } },
		},
	]);
	const ids = (r.results[0] as { clipIds: string[] }).clipIds;
	const v = ids.find((id) => h.seq.clips[id]!.kind === 'video')!;
	const a = ids.find((id) => h.seq.clips[id]!.kind === 'audio')!;
	return { v, a, mediaId: m };
}

const vid = (h: Harness, id: string) => h.seq.clips[id] as VideoClip;
const clean = (h: Harness) => expect(checkInvariants(h.doc)).toEqual([]);

describe('timeRemap.enable', () => {
	it('enables with an identity curve and warns that the linked audio stays at 100 %', () => {
		const h = new Harness();
		const { v } = place(h, 0);
		const r = h.ok([{ type: 'timeRemap.enable', clipIds: [v], enabled: true }]);
		expect(vid(h, v).timeRemap).toMatchObject({ enabled: true, keyframes: [] });
		expect(r.warnings.map((w) => w.code)).toContain('W_AUDIO_NOT_REMAPPED');
		expect(clipMediaTimeAt(vid(h, v), 30, R)).toBe(30 * F);
		clean(h);
	});

	it('mutes or unlinks the linked audio on request', () => {
		const h = new Harness();
		const { v, a } = place(h, 0);
		h.ok([{ type: 'timeRemap.enable', clipIds: [v], enabled: true, linkedAudio: 'mute' }]);
		expect(h.seq.clips[a]!.enabled).toBe(false);
		const h2 = new Harness();
		const p = place(h2, 0);
		h2.ok([{ type: 'timeRemap.enable', clipIds: [p.v], enabled: true, linkedAudio: 'unlink' }]);
		expect(h2.seq.clips[p.v]!.linkId).toBeNull();
		expect(h2.seq.clips[p.a]!.linkId).toBeNull();
		clean(h2);
	});

	it('refuses reversed clips and non-video clips', () => {
		const h = new Harness();
		const { v, a } = place(h, 0);
		h.ok([{ type: 'clip.setSpeed', clipIds: [v], reverse: true, ripple: false }]);
		const r = h.tx([{ type: 'timeRemap.enable', clipIds: [v], enabled: true }]);
		expect(r.ok).toBe(false);
		const r2 = new Harness();
		const p = place(r2, 0);
		expect(r2.tx([{ type: 'timeRemap.enable', clipIds: [p.a], enabled: true }]).ok).toBe(false);
		void a;
	});

	it('turning it off deletes the keyframes and trims a slowed clip to its media', () => {
		const h = new Harness();
		const { v } = place(h, 0, { seconds: 4, outSec: 4 });
		h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 10, speedPercent: 50 }]);
		expect(vid(h, v).duration).toBe(240);
		h.ok([{ type: 'timeRemap.enable', clipIds: [v], enabled: false }]);
		expect(vid(h, v).timeRemap).toBeUndefined();
		expect(vid(h, v).duration).toBe(120);
		clean(h);
	});
});

describe('speed segments', () => {
	it('slowing the clip lengthens it until the next clip; ripple pushes instead', () => {
		const h = new Harness();
		const { v } = place(h, 0, { outSec: 2 });
		h.ok([{ type: 'clip.addSolid', at: 90, duration: 30, track: 'V1', color: [1, 0, 0, 1] }]);
		const r = h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 10, speedPercent: 50 }]);
		expect(vid(h, v).duration).toBe(90);
		expect(r.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED');
		// The frames that did not fit stay in the tail: trimming the out point after a gap reveals them.
		expect(clipMediaTimeAt(vid(h, v), 89, R)).toBeCloseTo(44.5 * F, 3);
		const h2 = new Harness();
		const p = place(h2, 0, { outSec: 2 });
		const s = h2.ok([{ type: 'clip.addSolid', at: 60, duration: 30, track: 'V1', color: [1, 0, 0, 1] }]);
		const solid = (s.results[0] as { clipId: string }).clipId;
		h2.ok([{ type: 'timeRemap.setSpeed', clipId: p.v, at: 10, speedPercent: 50, ripple: true }]);
		expect(vid(h2, p.v).duration).toBe(120);
		expect(h2.seq.clips[solid]!.start).toBe(120);
		clean(h2);
	});

	it('a ramp of keyframes: 100 % → 25 % → 400 % with a transition', () => {
		const h = new Harness();
		const { v } = place(h, 0, { seconds: 20, outSec: 6 });
		const k1 = h.ok([{ type: 'timeRemap.addKeyframe', clipId: v, at: 30 }]).results[0] as {
			keyframeId: string;
		};
		const k2 = h.ok([{ type: 'timeRemap.addKeyframe', clipId: v, at: 60 }]).results[0] as {
			keyframeId: string;
		};
		h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 40, speedPercent: 25 }]);
		const c = vid(h, v);
		// 30 frames of media at 25 % take 120 frames.
		const k2frame = remapSegmentViews(c, R).find((s) => s.leftKeyId === k2.keyframeId)!.fromFrame;
		expect(k2frame).toBeCloseTo(150, 3);
		h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 200, speedPercent: 400 }]);
		h.ok([{ type: 'timeRemap.setTransition', clipId: v, keyframeId: k1.keyframeId, frames: 10 }]);
		const after = vid(h, v);
		expect(clipSpeedAt(after, 10, R)).toBeCloseTo(1);
		expect(clipSpeedAt(after, 30, R)).toBeCloseTo(0.625, 2);
		expect(clipSpeedAt(after, 100, R)).toBeCloseTo(0.25);
		expect(clipSpeedAt(after, 160, R)).toBeCloseTo(4);
		// The out point still shows the last frame of the 6 s range: 150 + (180 − 60)/4 = 180 frames.
		expect(after.duration).toBe(180);
		expect(clipMediaTimeAt(after, 179, R) / F).toBeCloseTo(176, 0);
		clean(h);
	});

	it('motion keyframes stay at their timeline frames when the speed changes', () => {
		const h = new Harness();
		const { v } = place(h, 0);
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', v, 'opacity'],
				animated: true,
			},
			{ type: 'param.set', target: ['clip', v, 'opacity'], value: 20, at: { frames: 50 } },
		]);
		const before = (vid(h, v).opacity.keyframes as { time: number }[]).map((k) => k.time);
		h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 5, speedPercent: 200 }]);
		expect((vid(h, v).opacity.keyframes as { time: number }[]).map((k) => k.time)).toEqual(before);
	});
});

describe('freeze and reverse segments', () => {
	it('freeze frame: holds and moves the rest later', () => {
		const h = new Harness();
		const { v } = place(h, 0, { outSec: 2 });
		const r = h.ok([{ type: 'timeRemap.addFreeze', clipId: v, at: 20, duration: 15, ripple: true }]);
		expect((r.results[0] as { keyframeIds: string[] }).keyframeIds).toHaveLength(2);
		const c = vid(h, v);
		expect(c.duration).toBe(75);
		// Frame 20 now shows 16 times (15 frames more), then the clip plays on.
		for (const f of [20, 27, 35]) expect(clipMediaTimeAt(c, f, R)).toBeCloseTo(20 * F, 3);
		expect(clipMediaTimeAt(c, 36, R)).toBeCloseTo(21 * F, 3);
		expect(remapSegmentViews(c, R).map((s) => s.kind)).toEqual(['forward', 'hold', 'forward']);
		clean(h);
	});

	it('palindrome reverse plays back and forward again', () => {
		const h = new Harness();
		const { v } = place(h, 0, { outSec: 2 });
		h.ok([{ type: 'timeRemap.addReverse', clipId: v, at: 30, duration: 10, ripple: true }]);
		const c = vid(h, v);
		expect(c.duration).toBe(80);
		const frames = [28, 30, 35, 40, 45, 50, 51].map((f) => Math.round(clipMediaTimeAt(c, f, R) / F));
		expect(frames).toEqual([28, 30, 25, 20, 25, 30, 31]);
		expect(remapSegmentViews(c, R).map((s) => [s.kind, Math.round(s.speed * 100)])).toEqual([
			['forward', 100],
			['reverse', -100],
			['forward', 100],
			['forward', 100],
		]);
		clean(h);
	});

	it('moving a hold keyframe slips the held frame', () => {
		const h = new Harness();
		const { v } = place(h, 0, { outSec: 2 });
		const ids = (
			h.ok([{ type: 'timeRemap.addFreeze', clipId: v, at: 20, duration: 10, ripple: true }]).results[0] as {
				keyframeIds: string[];
			}
		).keyframeIds;
		h.ok([{ type: 'timeRemap.moveKeyframe', clipId: v, keyframeId: ids[0], to: 26, ripple: true }]);
		const c = vid(h, v);
		expect(clipMediaTimeAt(c, 30, R)).toBeCloseTo(26 * F, 3);
		expect(clipMediaTimeAt(c, 36, R)).toBeCloseTo(26 * F, 3);
		expect(clipMediaTimeAt(c, 37, R)).toBeCloseTo(27 * F, 3);
		clean(h);
	});
});

describe('edits of remapped clips', () => {
	it('split, trim and undo keep the curve consistent; handles come from the remap', () => {
		const h = new Harness();
		const { v } = place(h, 0, { seconds: 4, outSec: 2 });
		h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 0, speedPercent: 50 }]);
		expect(vid(h, v).duration).toBe(120);
		const r = h.ok([{ type: 'clip.split', clipIds: [v], at: 60, linked: false }]);
		const right = (r.results[0] as { right: string[] }).right[0]!;
		const rc = vid(h, right);
		expect(rc.timeRemap!.keyframes[0]!.id).not.toBe(vid(h, v).timeRemap!.keyframes[0]!.id);
		expect(clipMediaTimeAt(rc, 60, R)).toBeCloseTo(30 * F, 3);
		// The media is 4 s = 120 frames; at 50 % the right part can extend its out point to frame 240.
		const t = h.tx([{ type: 'clip.trim', clipId: right, edge: 'out', deltaFrames: 500 }]);
		expect(t.ok).toBe(true);
		expect(vid(h, right).start + vid(h, right).duration).toBe(240);
		clean(h);
	});

	it('Reverse Speed is refused on a remapped clip', () => {
		const h = new Harness();
		const { v } = place(h, 0);
		h.ok([{ type: 'timeRemap.enable', clipIds: [v], enabled: true }]);
		expect(h.tx([{ type: 'clip.setSpeed', clipIds: [v], reverse: true, ripple: false }]).ok).toBe(false);
	});

	it('repair fixes malformed remaps', () => {
		const h = new Harness();
		const { v } = place(h, 0, { seconds: 4, outSec: 2 });
		const doc = structuredClone(h.doc);
		const c = Object.values(doc.sequences)[0]!.clips[v] as VideoClip & { timeRemap: TimeRemap };
		c.timeRemap = {
			enabled: true,
			keyframes: [
				{ id: 'kf_0000000000000001', time: 30 * F, source: 30 * F },
				{ id: 'kf_0000000000000002', time: 10 * F, source: Number.NaN },
			],
			speedAfter: 0.01,
		};
		expect(checkInvariants(doc).length).toBeGreaterThan(0);
		const fixed = repairDocument(doc, makeCtx().ids);
		expect(checkInvariants(fixed.document)).toEqual([]);
		expect(fixed.report.some((e) => e.action === 'repair-time-remap')).toBe(true);
	});
});

describe('time interpolation', () => {
	it('sets the interpolation mode on video clips only', () => {
		const h = new Harness();
		const { v, a } = place(h, 0);
		const r = h.ok([{ type: 'clip.setTimeInterpolation', clipIds: [v, a], mode: 'optical-flow' }]);
		expect(vid(h, v).timeInterpolation).toBe('optical-flow');
		expect(r.warnings).toHaveLength(1);
		h.ok([{ type: 'clip.setTimeInterpolation', clipIds: [v], mode: 'frame-sampling' }]);
		expect(vid(h, v).timeInterpolation).toBeUndefined();
	});
});

describe('clip.applySceneEdits', () => {
	it('cuts the clip and its audio, adds markers and a bin of scene items in one step', () => {
		const h = new Harness();
		const { v } = place(h, 10, { seconds: 10, inSec: 1, outSec: 5 });
		const cuts = [2, 3.5, 7].map((s) => Math.round(s * FLICKS_PER_SECOND));
		const r = h.ok([
			{
				type: 'clip.applySceneEdits',
				clipId: v,
				cuts,
				applyCuts: true,
				createSubclips: true,
				createMarkers: true,
			},
		]);
		const res = r.results[0] as { cuts: number[]; subclips: string[]; markers: number; binId: string };
		// Media 2 s and 3.5 s fall inside the clip (1 s … 5 s), at frames 10 + 30 and 10 + 75.
		expect(res.cuts).toEqual([40, 85]);
		expect(res.markers).toBe(2);
		expect(h.spans('V1')).toEqual([
			[10, 40],
			[40, 85],
			[85, 130],
		]);
		expect(h.spans('A1')).toEqual([
			[10, 40],
			[40, 85],
			[85, 130],
		]);
		const names = res.subclips.map((id) => h.doc.items[id]!.name);
		expect(names).toHaveLength(3);
		expect(h.doc.items[res.binId]!.kind).toBe('bin');
		clean(h);
	});
});

describe('interplay with trackers and media versions', () => {
	it('refuses trackers on remapped clips and remapping tracked clips', () => {
		const h = new Harness();
		const { v } = place(h, 0);
		h.ok([{ type: 'timeRemap.enable', clipIds: [v], enabled: true }]);
		expect(h.tx([{ type: 'tracker.add', clipId: v, kind: 'point', at: { frames: 0 }, point: [100, 100] }]).ok).toBe(
			false,
		);
		const h2 = new Harness();
		const p = place(h2, 0);
		h2.ok([{ type: 'tracker.add', clipId: p.v, kind: 'point', at: { frames: 0 }, point: [100, 100] }]);
		expect(h2.tx([{ type: 'timeRemap.enable', clipIds: [p.v], enabled: true }]).ok).toBe(false);
	});

	it('a content shift moves speed keyframes in content and media time', async () => {
		const { shiftClipContentTime } = await import('../src/index.ts');
		const h = new Harness();
		const { v } = place(h, 0);
		h.ok([{ type: 'timeRemap.setSpeed', clipId: v, at: 10, speedPercent: 50 }]);
		const c = structuredClone(h.seq.clips[v]) as VideoClip;
		const before = c.timeRemap!.keyframes.map((k) => [k.time, k.source]);
		shiftClipContentTime(c as never, 1000);
		expect(c.timeRemap!.keyframes.map((k) => [k.time, k.source])).toEqual(
			before.map(([a, b]) => [a! + 1000, b! + 1000]),
		);
	});
});

describe('Paste / Remove Attributes ▸ Time Remapping', () => {
	it('pastes the speed profile onto another clip from its own first frame, and removes it', async () => {
		const { buildClipsPayload } = await import('../src/index.ts');
		const h = new Harness();
		const a = place(h, 0, { seconds: 20, inSec: 0, outSec: 2 });
		const b = place(h, 200, { seconds: 20, inSec: 5, outSec: 7 });
		h.ok([{ type: 'timeRemap.addKeyframe', clipId: a.v, at: 20 }]);
		h.ok([{ type: 'timeRemap.setSpeed', clipId: a.v, at: 30, speedPercent: 50, ripple: true }]);
		const payload = JSON.parse(JSON.stringify(buildClipsPayload(h.doc, h.seqId, [a.v])));
		const r = h.ok([
			{ type: 'clip.pasteAttributes', payload, clipIds: [b.v], attributes: { timeRemapping: true } },
		]);
		expect((r.results[0] as { applied: Record<string, string[]> }).applied[b.v]).toEqual(['timeRemapping']);
		const A = vid(h, a.v);
		const B = vid(h, b.v);
		expect(B.duration).toBe(A.duration);
		for (const f of [0, 10, 25, 40, 70]) {
			const ma = clipMediaTimeAt(A, A.start + f, R) - clipMediaTimeAt(A, A.start, R);
			const mb = clipMediaTimeAt(B, B.start + f, R) - clipMediaTimeAt(B, B.start, R);
			expect(mb).toBeCloseTo(ma, -1);
		}
		expect(clipMediaTimeAt(B, B.start, R)).toBeCloseTo(5 * FLICKS_PER_SECOND, -1);
		h.ok([{ type: 'clip.removeAttributes', clipIds: [b.v], attributes: { timeRemapping: true } }]);
		expect(vid(h, b.v).timeRemap).toBeUndefined();
		clean(h);
	});
});
