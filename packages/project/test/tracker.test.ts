import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	type Clip,
	type ClipTracker,
	checkInvariants,
	defaultEffectRegistry,
	flicksPerFrame,
	mergeSamples,
	planTrack,
	type Quad,
	reanchorSamples,
	resolveSceneAt,
	samplesFromTrackResult,
	smoothSamples,
	type TrackerSamples,
	trackerGeometryAt,
	type Vec2,
	valuesAt,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = flicksPerFrame({ num: 30, den: 1 });
const REF: Quad = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
];

/** Per-frame ground truth: the reference quad through a small moving perspective warp. */
function truthQuad(i: number): Quad {
	const dst: Quad = REF.map(([x, y], k) => [
		x + 3 * i + (k === 1 ? 0.4 * i : 0),
		y - 1.5 * i + (k === 2 ? 0.3 * i : 0),
	]) as Quad;
	return dst;
}

function samplesFor(n: number, start = 0): TrackerSamples {
	const data: number[] = [];
	for (let i = 0; i < n; i++) for (const p of truthQuad(i)) data.push(p[0], p[1]);
	return { start, step: F, stride: 8, data, confidence: new Array(n).fill(0.9) };
}

function clip(h: Harness, id: string) {
	return h.seq.clips[id] as Clip & { trackers?: ClipTracker[]; trackedBy?: Record<string, unknown> };
}

/** A plate (video on V1, 60 frames) and a solid target on V2 over frames 0–30. */
function setup(opts: { plateMotion?: boolean; targetMotion?: boolean } = {}) {
	const h = new Harness();
	const m = h.registerVideo({ seconds: 4, audio: false });
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			sourceRange: { in: { flicks: 0 }, out: { flicks: 60 * F } },
		},
	]);
	const plate = h.clips('V1')[0]!.id;
	h.ok([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [0, 1, 0, 1], ref: '$t' }]);
	const target = h.clips('V2')[0]!.id;
	if (opts.plateMotion) {
		h.ok([
			{ type: 'param.set', target: ['clip', plate, 'transform', 'scale'], value: 200 },
			{ type: 'param.set', target: ['clip', plate, 'transform', 'rotation'], value: 90 },
			{ type: 'param.set', target: ['clip', plate, 'transform', 'position'], value: [900, 500] },
		]);
	}
	if (opts.targetMotion) {
		h.ok([
			{ type: 'param.set', target: ['clip', target, 'transform', 'scale'], value: 80 },
			{ type: 'param.set', target: ['clip', target, 'transform', 'rotation'], value: -5 },
			{
				type: 'param.setAnimated',
				target: ['clip', target, 'transform', 'position'],
				animated: true,
				at: { sequenceFrame: 0 },
			},
			{
				type: 'param.set',
				target: ['clip', target, 'transform', 'position'],
				value: [1000, 600],
				at: { sequenceFrame: 0 },
			},
			{
				type: 'param.set',
				target: ['clip', target, 'transform', 'position'],
				value: [1100, 500],
				at: { sequenceFrame: 29 },
			},
		]);
	}
	return { h, plate, target, mediaId: m };
}

function addPlanar(h: Harness, plate: string): string {
	const r = h.ok([{ type: 'tracker.add', clipId: plate, kind: 'planar', at: { frames: 0 }, corners: REF }]);
	return (r.results[0] as { trackerId: string }).trackerId;
}

// With plate anchor [960,540], position [900,500], scale 200% and a 90-degree turn,
// media [x,y] lands at [1980-2y, 2x-1420] by the specified clockwise coordinate map.
const plateToSequence = ([x, y]: Vec2): Vec2 => [1980 - 2 * y, 2 * x - 1420];

describe('tracker commands (S09:TRK-001…005)', () => {
	it('adds planar and point trackers on video clips with media-px geometry and content time', () => {
		const { h, plate, target } = setup();
		const r = h.ok([
			{ type: 'tracker.add', clipId: plate, kind: 'planar', at: { frames: 12 }, corners: REF, ref: '$p' },
			{ type: 'tracker.add', clipId: plate, kind: 'point', at: { sequenceFrame: 3 }, point: [400, 300] },
		]);
		const [a, b] = r.results as { trackerId: string }[];
		expect(a!.trackerId).toMatch(/^tkr_/);
		const trackers = clip(h, plate).trackers!;
		expect(trackers[0]!.reference.time).toBe(12 * F);
		expect(trackers[0]!.reference.corners).toEqual(REF);
		expect(trackers[0]!.samples).toBeNull();
		expect(trackers[1]!.reference.point).toEqual([400, 300]);
		expect(trackers[1]!.reference.patch).toBeGreaterThan(0);
		expect(b!.trackerId).not.toBe(a!.trackerId);
		for (const cmd of [
			{ type: 'tracker.add', clipId: target, kind: 'planar', at: { frames: 0 } },
			{
				type: 'tracker.add',
				clipId: plate,
				kind: 'planar',
				at: { frames: 0 },
				corners: [REF[0], REF[2], REF[1], REF[3]],
			},
			{ type: 'tracker.add', clipId: plate, kind: 'point', at: { frames: 0 }, corners: REF },
		]) {
			const res = h.tx([cmd]);
			expect(res.ok, JSON.stringify(cmd)).toBe(false);
			if (!res.ok) expect(res.errors[0]!.code).toBe('E_INVALID_PARAM');
		}
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('updates, stores samples (replace / span merge) and removes trackers', () => {
		const { h, plate } = setup();
		const id = addPlanar(h, plate);
		h.ok([{ type: 'tracker.update', trackerId: id, name: 'Screen', smoothing: 2 }]);
		expect(clip(h, plate).trackers![0]!.name).toBe('Screen');
		expect(clip(h, plate).trackers![0]!.smoothing).toBe(2);
		h.ok([
			{ type: 'tracker.setSamples', trackerId: id, samples: samplesFor(20), method: 'klt-homography@1' },
		]);
		const s0 = clip(h, plate).trackers![0]!.samples!;
		expect(s0.data.length).toBe(160);
		// span: frames 10..24 re-tracked, 0..9 kept.
		const patch = samplesFor(25);
		const sub: TrackerSamples = {
			start: 10 * F,
			step: F,
			stride: 8,
			data: patch.data.slice(80).map((v) => v + 1),
			confidence: new Array(15).fill(0.5),
		};
		h.ok([
			{ type: 'tracker.setSamples', trackerId: id, samples: sub, method: 'klt-homography@1', merge: 'span' },
		]);
		const s1 = clip(h, plate).trackers![0]!.samples!;
		expect(s1.start).toBe(0);
		expect(s1.data.length).toBe(25 * 8);
		expect(s1.data[0]).toBe(700);
		expect(s1.data[10 * 8]).toBe(truthQuad(10)[0][0] + 1);
		expect(s1.confidence[9]).toBe(0.9);
		expect(s1.confidence[24]).toBe(0.5);
		const bad = h.tx([
			{
				type: 'tracker.setSamples',
				trackerId: id,
				samples: { start: 0, step: F, stride: 2, data: [1, 2], confidence: [1] },
				method: 'x',
			},
		]);
		expect(bad.ok).toBe(false);
		const bad2 = h.tx([
			{
				type: 'tracker.setSamples',
				trackerId: id,
				samples: { start: 0, step: F, stride: 8, data: [1, 2, 3, 4, 5, 6, 7, 8], confidence: [1, 1] },
				method: 'x',
			},
		]);
		expect(bad2.ok).toBe(false);
		h.ok([{ type: 'tracker.remove', trackerIds: [id] }]);
		expect(clip(h, plate).trackers).toBeUndefined();
		const missing = h.tx([{ type: 'tracker.remove', trackerIds: [id] }]);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.errors[0]!.code).toBe('E_NOT_FOUND');
	});

	it('moving the reference carries the correction through the remaining perspective motion', () => {
		const { h, plate } = setup();
		const id = addPlanar(h, plate);
		// H(f): [x,y] → [x,y] / (1 + f*x/10000). H(15)·H(5)⁻¹ has denominator 1 + x/1000.
		const quads = Array.from({ length: 20 }, (_, f) =>
			REF.map(([x, y]) => [x / (1 + (f * x) / 10_000), y / (1 + (f * x) / 10_000)]),
		);
		h.ok([
			{
				type: 'tracker.setSamples',
				trackerId: id,
				samples: {
					start: 0,
					step: F,
					stride: 8,
					data: quads.flat(2),
					confidence: new Array(20).fill(1),
				},
				method: 'klt-homography@1',
			},
		]);
		const moved: Quad = [
			[400, 200],
			[600, 200],
			[600, 400],
			[400, 400],
		];
		h.ok([{ type: 'tracker.update', trackerId: id, at: { frames: 5 }, corners: moved }]);
		const tracker = clip(h, plate).trackers![0]!;
		expect(tracker.reference.time).toBe(5 * F);
		for (const [frame, expected] of [
			[5, moved],
			[
				15,
				[
					[2000 / 7, 1000 / 7],
					[375, 125],
					[375, 250],
					[2000 / 7, 2000 / 7],
				],
			],
		] as const) {
			const actual = trackerGeometryAt(tracker, frame * F).corners!;
			for (let k = 0; k < 4; k++) {
				expect(actual[k]![0]).toBeCloseTo(expected[k]![0], 6);
				expect(actual[k]![1]).toBeCloseTo(expected[k]![1], 6);
			}
		}
	});

	it('split copies trackers to both halves with new ids; duplicate too; trackedBy follows the pin copy', () => {
		const { h, plate, target } = setup();
		const id = addPlanar(h, plate);
		h.ok([
			{ type: 'tracker.setSamples', trackerId: id, samples: samplesFor(30), method: 'klt-homography@1' },
		]);
		h.ok([{ type: 'tracker.apply', trackerId: id, targetClipId: target, mode: 'corner-pin' }]);
		h.ok([{ type: 'clip.split', at: 20, clipIds: [plate] }]);
		const halves = h.clips('V1');
		expect(halves.length).toBe(2);
		const [left, right] = halves.map((c) => c as Clip & { trackers?: ClipTracker[] });
		expect(left!.trackers![0]!.id).toBe(id);
		expect(right!.trackers![0]!.id).not.toBe(id);
		expect(right!.trackers![0]!.id).toMatch(/^tkr_/);
		expect(right!.trackers![0]!.samples).toEqual(left!.trackers![0]!.samples);
		const dup = h.ok([{ type: 'clip.duplicate', clipIds: [target], tracks: ['V3'] }]);
		const copyId = (dup.results[0] as { clipIds: string[] }).clipIds[0]!;
		const copy = clip(h, copyId) as Clip & {
			effects: { id: string; effectId: string }[];
			trackedBy: { effectInstanceId: string; trackerId: string };
		};
		const orig = clip(h, target) as Clip & {
			effects: { id: string }[];
			trackedBy: { effectInstanceId: string };
		};
		expect(copy.trackedBy.trackerId).toBe(id);
		expect(copy.trackedBy.effectInstanceId).toBe(copy.effects[0]!.id);
		expect(copy.trackedBy.effectInstanceId).not.toBe(orig.trackedBy.effectInstanceId);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});
});

describe('samples (S09:TRK-002, TRK-020)', () => {
	it('interpolates linearly between samples and holds outside the span', () => {
		const s = samplesFor(10, 5 * F);
		expect(valuesAt(s, 0)!.values[0]).toBe(700);
		expect(valuesAt(s, 5 * F + F / 2)!.values[0]).toBeCloseTo(701.5, 9);
		expect(valuesAt(s, 100 * F)!.values[0]).toBe(truthQuad(9)[0][0]);
	});
	it('smooths jitter by confidence without lagging motion or following lost samples', () => {
		// x moves 10 px per frame with ±1 px jitter; frame 4 is lost (confidence 0) and repeats frame 3's values.
		const xs = [1, 9, 21, 29, 29, 51, 59, 71, 79];
		const samples: TrackerSamples = {
			start: 0,
			step: F,
			stride: 2,
			data: xs.flatMap((x) => [x, 5]),
			confidence: [1, 1, 1, 1, 0, 1, 1, 1, 1],
		};
		const smoothed = smoothSamples(samples, 2);
		for (let i = 0; i < xs.length; i++) {
			expect(Math.abs(smoothed.data[2 * i]! - 10 * i)).toBeLessThan(1);
			expect(smoothed.data[2 * i + 1]).toBeCloseTo(5, 9);
		}
		expect(smoothed.confidence).toEqual(samples.confidence);
		expect(samples.data.slice(0, 4)).toEqual([1, 5, 9, 5]);
	});
	it('merges disjoint spans with lost samples in the gap', () => {
		const a: TrackerSamples = { start: 0, step: F, stride: 2, data: [0, 0, 1, 1], confidence: [1, 1] };
		const b: TrackerSamples = { start: 4 * F, step: F, stride: 2, data: [4, 4], confidence: [1] };
		const m = mergeSamples(a, b, 'span');
		expect(m.data).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 4, 4]);
		expect(m.confidence).toEqual([1, 1, 0, 0, 1]);
		const before: TrackerSamples = { start: 0, step: F, stride: 2, data: [9, 9], confidence: [0.5] };
		const m2 = mergeSamples(b, before, 'span');
		expect(m2.start).toBe(0);
		expect(m2.data.slice(0, 2)).toEqual([9, 9]);
		expect(m2.data.slice(-2)).toEqual([4, 4]);
	});
	it('re-anchors point samples by translation', () => {
		const s: TrackerSamples = { start: 0, step: F, stride: 2, data: [10, 10, 20, 15], confidence: [1, 1] };
		expect(reanchorSamples(s, F, { point: [22, 16] }).data).toEqual([12, 11, 22, 16]);
	});
	it('converts engine results (source frames) to samples (content flicks)', () => {
		const s = samplesFromTrackResult({ startFrame: 7, stride: 2, data: [1, 2], confidence: [1.2] }, F);
		expect(s.start).toBe(7 * F);
		expect(s.confidence).toEqual([1]);
	});
});

describe('tracker.apply (S09:TRK-020…023, §8.1)', () => {
	it('corner pin reproduces the tracked corners through plate Motion (200 %, 90°) and animated target Motion', () => {
		const { h, plate, target } = setup({ plateMotion: true, targetMotion: true });
		const id = addPlanar(h, plate);
		h.ok([
			{ type: 'tracker.setSamples', trackerId: id, samples: samplesFor(30), method: 'klt-homography@1' },
		]);
		const r = h.ok([{ type: 'tracker.apply', trackerId: id, targetClipId: target, mode: 'corner-pin' }]);
		const res = r.results[0] as { frames: number; effectInstanceId: string };
		expect(res.frames).toBe(30);
		const t = clip(h, target) as Clip & {
			effects: { id: string; effectId: string; params: Record<string, { keyframes: unknown[] }> }[];
		};
		expect(t.effects[0]!.effectId).toBe('jasper.corner-pin');
		expect(t.effects[0]!.params.topLeft!.keyframes.length).toBe(30);
		expect((t as { trackedBy?: unknown }).trackedBy).toEqual({
			clipId: plate,
			trackerId: id,
			mode: 'corner-pin',
			effectInstanceId: res.effectInstanceId,
		});
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const toSeq = plateToSequence;
		for (const f of [0, 7, 15, 29]) {
			const layer = resolveSceneAt(snap, f).find((l) => l.clip.clipId === target)!;
			const want = truthQuad(f).map(toSeq);
			for (let k = 0; k < 4; k++) {
				expect(Math.abs(layer.props.quad[k]![0] - want[k]![0])).toBeLessThan(1e-6);
				expect(Math.abs(layer.props.quad[k]![1] - want[k]![1])).toBeLessThan(1e-6);
			}
		}
		h.ok([
			{
				type: 'tracker.apply',
				trackerId: id,
				targetClipId: target,
				mode: 'corner-pin',
				range: { start: 10, end: 20 },
			},
		]);
		const t2 = clip(h, target) as typeof t;
		expect(t2.effects.filter((e) => e.effectId === 'jasper.corner-pin').length).toBe(1);
		expect(t2.effects[0]!.params.topLeft!.keyframes.length).toBe(30);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('transform mode: position follows the quad centre, scale/rotation relative to the reference', () => {
		const { h, plate, target } = setup({ plateMotion: true });
		const reference: Quad = [
			[700, 300],
			[1300, 300],
			[1300, 700],
			[700, 700],
		];
		const added = h.ok([
			{ type: 'tracker.add', clipId: plate, kind: 'planar', at: { frames: 0 }, corners: reference },
		]);
		const id = (added.results[0] as { trackerId: string }).trackerId;
		// Frame i: the quad scaled by (1 + i/100) about its centre and rotated by i degrees.
		const c: Vec2 = [1000, 500];
		const data: number[] = [];
		for (let i = 0; i < 30; i++) {
			const k = 1 + i / 100;
			const a = (i * Math.PI) / 180;
			for (const [x, y] of reference) {
				const dx = (x - c[0]) * k;
				const dy = (y - c[1]) * k;
				data.push(c[0] + dx * Math.cos(a) - dy * Math.sin(a) + i, c[1] + dx * Math.sin(a) + dy * Math.cos(a));
			}
		}
		h.ok([
			{
				type: 'tracker.setSamples',
				trackerId: id,
				samples: { start: 0, step: F, stride: 8, data, confidence: new Array(30).fill(1) },
				method: 'klt-homography@1',
			},
			{ type: 'param.set', target: ['clip', target, 'transform', 'scale'], value: 50 },
		]);
		h.ok([{ type: 'tracker.apply', trackerId: id, targetClipId: target, mode: 'transform' }]);
		const t = clip(h, target) as Clip & {
			transform: {
				position: { keyframes: { time: number; value: Vec2 }[] };
				scale: { keyframes: { value: number }[] };
				rotation: { keyframes: { value: number }[] };
			};
		};
		expect(t.transform.position.keyframes.length).toBe(30);
		const toSeq = plateToSequence;
		const want = toSeq([c[0] + 20, c[1]]);
		expect(t.transform.position.keyframes[20]!.value[0]).toBeCloseTo(want[0], 4);
		expect(t.transform.position.keyframes[20]!.value[1]).toBeCloseTo(want[1], 4);
		expect(t.transform.scale.keyframes[0]!.value).toBeCloseTo(50, 6);
		expect(t.transform.scale.keyframes[20]!.value).toBeCloseTo(50 * 1.2, 4);
		expect(t.transform.rotation.keyframes[20]!.value).toBeCloseTo(20, 4);
		const pr = h.ok([
			{ type: 'tracker.add', clipId: plate, kind: 'point', at: { frames: 0 }, point: [960, 540] },
		]);
		const pid = (pr.results[0] as { trackerId: string }).trackerId;
		const ap = h.ok([{ type: 'tracker.apply', trackerId: pid, targetClipId: target, mode: 'transform' }]);
		expect(ap.warnings.some((w) => w.code === 'W_TRACKING')).toBe(true);
		const cp = h.tx([{ type: 'tracker.apply', trackerId: pid, targetClipId: target, mode: 'corner-pin' }]);
		expect(cp.ok).toBe(false);
	});

	it('tracker.unlink drops the link and keeps the keyframes', () => {
		const { h, plate, target } = setup();
		const id = addPlanar(h, plate);
		h.ok([{ type: 'tracker.apply', trackerId: id, targetClipId: target, mode: 'corner-pin' }]);
		const r = h.ok([{ type: 'tracker.unlink', clipIds: [target] }]);
		expect(r.results[0]).toEqual({ clipIds: [target] });
		const t = clip(h, target) as Clip & { effects: { params: Record<string, { keyframes: unknown[] }> }[] };
		expect((t as { trackedBy?: unknown }).trackedBy).toBeUndefined();
		expect(t.effects[0]!.params.topLeft!.keyframes.length).toBe(30);
	});

	it('removing a tracker keeps the keyframes and drops the link', () => {
		const { h, plate, target } = setup();
		const id = addPlanar(h, plate);
		h.ok([{ type: 'tracker.apply', trackerId: id, targetClipId: target, mode: 'corner-pin' }]);
		h.ok([{ type: 'tracker.remove', trackerIds: [id] }]);
		const t = clip(h, target) as Clip & { effects: { params: Record<string, { keyframes: unknown[] }> }[] };
		expect((t as { trackedBy?: unknown }).trackedBy).toBeUndefined();
		expect(t.effects[0]!.params.topLeft!.keyframes.length).toBe(30);
	});
});

describe('planTrack (S09:TRK-010, TRK-024)', () => {
	it('builds forward / both / from-here requests in source frames', () => {
		const { h, plate } = setup();
		const r = h.ok([
			{ type: 'tracker.add', clipId: plate, kind: 'planar', at: { frames: 10 }, corners: REF },
		]);
		const id = (r.results[0] as { trackerId: string }).trackerId;
		const both = planTrack(h.doc, id, { mode: 'both' });
		expect(both.request.range).toEqual({ startFrame: 0, endFrame: 60 });
		expect(both.request.reference.frame).toBe(10);
		expect(both.request.reference.corners).toEqual(REF);
		expect(both.merge).toBe('replace');
		expect(both.step).toBe(F);
		const fwd = planTrack(h.doc, id, { mode: 'forward', quality: 'fast' });
		expect(fwd.request.range).toEqual({ startFrame: 10, endFrame: 60 });
		expect(fwd.request.direction).toBe('forward');
		h.ok([
			{ type: 'tracker.setSamples', trackerId: id, samples: samplesFor(60), method: 'klt-homography@1' },
		]);
		const here = planTrack(h.doc, id, { mode: 'from-here', at: 40 * F });
		expect(here.merge).toBe('span');
		expect(here.request.reference.frame).toBe(40);
		expect(here.request.reference.corners![0]).toEqual(truthQuad(40)[0]);
		const back = planTrack(h.doc, id, { mode: 'step-back', at: 40 * F });
		expect(back.request.range).toEqual({ startFrame: 39, endFrame: 41 });
	});
});
