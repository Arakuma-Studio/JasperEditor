// Batch commands (spec 15 EA-031): `clip.addAdjustmentBatch` and `keyframe.addBatch` — what they create (clips, effects,
// keys relative to each item's start), one undoable unit (undo is the document before; redo is deterministic),
// refusals naming the offending item / target and key, invariants, and 1 000-item batches.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { threadCpuMs } from '../../../scripts/perf/cpu.ts';
import {
	type AdjustmentClip,
	type Animatable,
	type Clip,
	checkInvariants,
	type EffectInstance,
	evaluate,
	flicksPerFrame,
	type TransactionResult,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F30 = flicksPerFrame({ num: 30, den: 1 });

const errorsOf = (r: TransactionResult) => (r.ok ? [] : r.errors);
const fxOf = (c: Clip) => (c as { effects: EffectInstance[] }).effects;
const valid = (h: Harness) => expect(checkInvariants(h.doc)).toEqual([]);

/** A kit: blur 0 → 40 eased into the cut and back, Transform scale 100 → 180 over the first half. */
const kit = (start: number, length = 20, name?: string) => ({
	start,
	length,
	...(name ? { name } : {}),
	effects: [
		{
			effectId: 'jasper.gaussian-blur',
			params: { repeatEdge: true },
			keyframes: {
				radius: [
					{ frame: 0, value: 0, interpolation: 'bezier', easeOut: { influence: 0.8, slope: 0 } },
					{ frame: Math.floor(length / 2), value: 40 },
					{ frame: length, value: 0 },
				],
			},
		},
		{
			effectId: 'jasper.transform',
			keyframes: {
				scaleHeight: [
					{ frame: 0, value: 100 },
					{ frame: Math.floor(length / 2), value: 180 },
				],
			},
		},
	],
});

function adjustments(h: Harness, track = 'V2') {
	return h.clips(track).filter((c): c is AdjustmentClip => c.kind === 'adjustment');
}

describe('clip.addAdjustmentBatch', () => {
	it('places adjustment clips with effects and keys relative to each item, in one command', () => {
		const h = new Harness();
		const before = h.doc;
		const r = h.ok([
			{ type: 'clip.addAdjustmentBatch', trackId: 'V2', items: [kit(10), kit(100, 20, 'Jolt')] },
		]);
		valid(h);
		const res = r.results[0] as { clipIds: string[]; effectInstanceIds: string[][]; trackId: string };
		expect(res.clipIds).toHaveLength(2);
		const clips = adjustments(h);
		expect(clips.map((c) => [c.start, c.duration, c.name])).toEqual([
			[10, 20, 'Adjustment Layer'],
			[100, 20, 'Jolt'],
		]);
		expect(res.trackId).toBe(clips[0]!.trackId);
		for (const c of clips) {
			const [blur, tf] = c.effects as EffectInstance[];
			expect(blur!.effectId).toBe('jasper.gaussian-blur');
			expect(tf!.effectId).toBe('jasper.transform');
			const radius = blur!.params.radius as Animatable<number>;
			// keys in the clip's content time: frame k of the item = k frames of an adjustment clip (In 0, speed 1)
			expect(radius.keyframes.map((k) => k.time / F30)).toEqual([0, 10, 20]);
			expect(radius.keyframes.map((k) => k.value)).toEqual([0, 40, 0]);
			expect(radius.keyframes[0]!.interpolation).toBe('bezier');
			expect(radius.keyframes[0]!.easeOut).toEqual({ influence: 0.8, slope: 0 });
			expect(blur!.params.repeatEdge!.value).toBe(true);
			expect(evaluate(tf!.params.scaleHeight as Animatable<number>, 5 * F30)).toBeCloseTo(140, 6);
		}
		expect(before.sequences[h.seqId]!.clips).not.toBe(h.doc.sequences[h.seqId]!.clips);
		// undo = the document before (untouched); redo applies the same again
		const after = h.doc;
		h.doc = before;
		expect(adjustments(h)).toHaveLength(0);
		h.ok([{ type: 'clip.addAdjustmentBatch', trackId: 'V2', items: [kit(10), kit(100, 20, 'Jolt')] }]);
		expect(adjustments(h).map((c) => [c.start, c.duration])).toEqual(
			Object.values(after.sequences[h.seqId]!.clips)
				.filter((c) => c.kind === 'adjustment')
				.sort((a, b) => a.start - b.start)
				.map((c) => [c.start, c.duration]),
		);
	});

	it('binds refs and creates the track named by its label', () => {
		const h = new Harness();
		const r = h.ok([
			{
				type: 'clip.addAdjustmentBatch',
				trackId: `V${h.seq.videoTracks.length + 1}`,
				items: [
					{ ...kit(0), ref: '$k0' },
					{ ...kit(40), ref: '$k1' },
				],
			},
			{ type: 'clip.update', clipId: '$k1', patch: { name: 'Second' } },
		]);
		valid(h);
		expect(r.refs.$k0).toBeDefined();
		expect(h.seq.clips[r.refs.$k1!]!.name).toBe('Second');
		const tracks = new Set(adjustments(h, `V${h.seq.videoTracks.length}`).map((c) => c.trackId));
		expect(tracks.size).toBe(1);
	});

	it('refuses with the offending item named, and applies nothing', () => {
		const h = new Harness();
		h.ok([{ type: 'clip.addSolid', at: 50, duration: 30, track: 'V2', color: [1, 0, 0, 1] }]);
		const solid = h.clips('V2')[0]!;
		const doc = h.doc;
		const refuse = (items: unknown[], extra: Record<string, unknown> = {}) => {
			const r = h.tx([{ type: 'clip.addAdjustmentBatch', trackId: 'V2', items, ...extra }]);
			expect(r.ok).toBe(false);
			expect(h.doc).toBe(doc);
			return errorsOf(r)[0]!;
		};
		// items overlap each other
		let e = refuse([kit(0), kit(10)]);
		expect(e.code).toBe('E_OVERLAP');
		expect(e.message).toContain('items[1]');
		expect(e.message).toContain('items[0]');
		// over an existing clip: named, with its id among the blocking entities
		e = refuse([kit(0), kit(60)]);
		expect(e.code).toBe('E_OVERLAP');
		expect(e.message).toContain('items[1]');
		expect(e.message).toContain(solid.id);
		expect(e.blocking).toEqual([solid.id]);
		// unknown effect, unknown parameter, key after the end, bad value, zero length
		e = refuse([kit(0), { start: 200, length: 10, effects: [{ effectId: 'jasper.nope' }] }]);
		expect(e.code).toBe('E_UNKNOWN_EFFECT');
		expect(e.message).toMatch(/^items\[1\]: effects\[0\] \(jasper\.nope\)/);
		e = refuse([
			{ start: 200, length: 10, effects: [{ effectId: 'jasper.gaussian-blur', params: { radiuss: 3 } }] },
		]);
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(e.message).toContain('items[0]: effects[0]');
		e = refuse([
			{
				start: 200,
				length: 10,
				effects: [{ effectId: 'jasper.gaussian-blur', keyframes: { radius: [{ frame: 11, value: 3 }] } }],
			},
		]);
		expect(e.message).toContain('items[0]: effects[0] (jasper.gaussian-blur): keyframes.radius[0]');
		e = refuse([
			{
				start: 200,
				length: 10,
				effects: [{ effectId: 'jasper.gaussian-blur', keyframes: { radius: [{ frame: 1, value: 'x' }] } }],
			},
		]);
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(e.path?.slice(0, 2)).toEqual(['items', '0']);
		e = refuse([{ start: 200, length: 0 }]);
		expect(e.message).toContain('items[0]');
		// a locked track
		h.ok([{ type: 'track.update', trackId: h.seq.videoTracks[1]!.id, patch: { locked: true } }]);
		const locked = h.doc;
		const r = h.tx([{ type: 'clip.addAdjustmentBatch', trackId: 'V2', items: [kit(200)] }]);
		expect(errorsOf(r)[0]!.code).toBe('E_TRACK_LOCKED');
		expect(h.doc).toBe(locked);
	});

	it('overwrite: true overwrites what is under each item, like clip.addAdjustment', () => {
		const h = new Harness();
		h.ok([{ type: 'clip.addSolid', at: 50, duration: 30, track: 'V2', color: [1, 0, 0, 1] }]);
		h.ok([{ type: 'clip.addAdjustmentBatch', trackId: 'V2', items: [kit(60)], overwrite: true }]);
		valid(h);
		expect(h.spans('V2')).toEqual([
			[50, 60],
			[60, 80],
		]);
	});

	it('refuses an unknown key inside an item (strict schema)', () => {
		const h = new Harness();
		const r = h.tx([{ type: 'clip.addAdjustmentBatch', trackId: 'V2', items: [{ ...kit(0), lenght: 3 }] }]);
		expect(errorsOf(r)[0]!.code).toBe('E_SCHEMA');
	});

	it('property: any non-overlapping set of items lands exactly and invariants hold', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 12 }),
				fc.integer({ min: 2, max: 20 }),
				(slots, len) => {
					const h = new Harness();
					const items = slots.map((s) => kit(s * 21, len));
					h.ok([{ type: 'clip.addAdjustmentBatch', trackId: 'V3', items }]);
					valid(h);
					const got = adjustments(h, 'V3').map((c) => [c.start, c.duration]);
					expect(got).toEqual([...slots].sort((a, b) => a - b).map((s) => [s * 21, len]));
				},
			),
			{ numRuns: 40, seed: 15 },
		);
	});

	it('1 000 items in one command (a whole-video pass): one command, all placed, invariants hold', () => {
		const h = new Harness();
		const items = Array.from({ length: 1000 }, (_, i) => kit(i * 30));
		const t0 = threadCpuMs();
		const r = h.ok([{ type: 'clip.addAdjustmentBatch', trackId: 'V2', items }]);
		const ms = threadCpuMs() - t0;
		expect((r.results[0] as { clipIds: string[] }).clipIds).toHaveLength(1000);
		expect(adjustments(h)).toHaveLength(1000);
		valid(h);
		// generous bound for a shared test machine; the wp-note records the measured time (edit-automation.md)
		expect(ms).toBeLessThan(30_000);
		console.info(`[perf] clip.addAdjustmentBatch 1000 items: ${ms.toFixed(0)} CPU ms`);
	});
});

describe('keyframe.addBatch', () => {
	function clipsOnV1(h: Harness, n: number): Clip[] {
		const mediaId = h.registerVideo({ seconds: 600 });
		for (let i = 0; i < n; i++)
			h.ok([
				{
					type: 'clip.place',
					source: { mediaId },
					sourceRange: { in: { seconds: i * 3 }, out: { seconds: i * 3 + 2 } },
					at: i * 60,
					tracks: { video: 'V1' },
					audio: false,
				},
			]);
		return h.clips('V1');
	}

	it('keys Motion scale on many clips (punch-ins) and an effect of a clip, in one command', () => {
		const h = new Harness();
		const clips = clipsOnV1(h, 3);
		h.ok([
			{ type: 'effect.add', target: { clipId: clips[0]!.id }, effectId: 'jasper.gaussian-blur', ref: '$fx' },
		]);
		const fxId = fxOf(h.clips('V1')[0]!)[0]!.id;
		const before = h.doc;
		const r = h.ok([
			{
				type: 'keyframe.addBatch',
				targets: [
					...clips.map((c) => ({
						clipId: c.id,
						path: ['transform', 'scale'],
						keys: [
							{ at: { frames: 30 }, value: 100 },
							{ at: { frames: 37 }, value: 180 },
						],
					})),
					{ clipId: clips[0]!.id, path: ['effect', fxId, 'radius'], keys: [{ at: { frames: 0 }, value: 5 }] },
				],
			},
		]);
		valid(h);
		const res = r.results[0] as { keyframeIds: string[][]; targets: number };
		expect(res.targets).toBe(4);
		expect(res.keyframeIds.map((x) => x.length)).toEqual([2, 2, 2, 1]);
		for (const c of h.clips('V1')) {
			const scale = (c as { transform: { scale: Animatable<number> } }).transform.scale;
			expect(scale.keyframes.map((k) => k.value)).toEqual([100, 180]);
			// frames from the clip's start: 30 frames into the clip, at its source time
			expect(scale.keyframes[0]!.time).toBe(c.sourceIn + 30 * F30);
		}
		const blur = fxOf(h.clips('V1')[0]!)[0]!;
		expect((blur.params.radius as Animatable<number>).keyframes.map((k) => k.value)).toEqual([5]);
		h.doc = before;
		expect(
			(h.clips('V1')[1] as { transform: { scale: Animatable<number> } }).transform.scale.keyframes,
		).toEqual([]);
	});

	it('resolves an effect added earlier in the transaction by its temp ref', () => {
		const h = new Harness();
		const [c] = clipsOnV1(h, 1);
		h.ok([
			{ type: 'effect.add', target: { clipId: c!.id }, effectId: 'jasper.gaussian-blur', ref: '$fx' },
			{
				type: 'keyframe.addBatch',
				targets: [
					{ clipId: c!.id, path: ['effect', '$fx', 'radius'], keys: [{ at: { frames: 2 }, value: 9 }] },
				],
			},
		]);
		valid(h);
		const blur = fxOf(h.clips('V1')[0]!)[0]!;
		expect((blur.params.radius as Animatable<number>).keyframes).toHaveLength(1);
	});

	it('refuses naming the target and key; nothing applies', () => {
		const h = new Harness();
		const clips = clipsOnV1(h, 2);
		const doc = h.doc;
		const refuse = (targets: unknown[]) => {
			const r = h.tx([{ type: 'keyframe.addBatch', targets }]);
			expect(r.ok).toBe(false);
			expect(h.doc).toBe(doc);
			return errorsOf(r)[0]!;
		};
		const scale = (clipId: string, keys: unknown[]) => ({ clipId, path: ['transform', 'scale'], keys });
		let e = refuse([
			scale(clips[0]!.id, [{ at: { frames: 1 }, value: 120 }]),
			scale('clp_000000000000NOPE', [{ at: { frames: 1 }, value: 1 }]),
		]);
		expect(e.code).toBe('E_NOT_FOUND');
		expect(e.message).toMatch(/^targets\[1\] \(clp_000000000000NOPE transform\.scale\)/);
		e = refuse([
			scale(clips[1]!.id, [
				{ at: { frames: 1 }, value: 120 },
				{ at: { frames: 4 }, value: 'big' },
			]),
		]);
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(e.message).toContain(`targets[0] (${clips[1]!.id} transform.scale): keys[1]`);
		expect(e.path?.slice(0, 4)).toEqual(['targets', '0', 'keys', '1']);
		e = refuse([
			scale(clips[0]!.id, [
				{ at: { frames: 3 }, value: 120 },
				{ at: { frames: 3 }, value: 130 },
			]),
		]);
		expect(e.message).toContain('keys[1]: lands on the same frame as keys[0]');
		e = refuse([{ clipId: clips[0]!.id, path: ['nope', 'x'], keys: [{ at: { frames: 1 }, value: 1 }] }]);
		expect(e.code).toBe('E_INVALID_PARAM');
		e = refuse([
			{
				clipId: clips[0]!.id,
				path: ['effect', 'fx_000000000000NOPE', 'radius'],
				keys: [{ at: { frames: 1 }, value: 1 }],
			},
		]);
		expect(e.code).toBe('E_NOT_FOUND');
		expect(e.message).toContain('is not on clip');
	});

	it('1 000 targets in one command', () => {
		const h = new Harness();
		const ok = h.ok([
			{
				type: 'clip.addAdjustmentBatch',
				trackId: 'V2',
				items: Array.from({ length: 1000 }, (_, i) => ({ start: i * 10, length: 10, ref: `$a${i}` })),
			},
		]);
		const ids = (ok.results[0] as { clipIds: string[] }).clipIds;
		const t0 = threadCpuMs();
		h.ok([
			{
				type: 'keyframe.addBatch',
				targets: ids.map((clipId) => ({
					clipId,
					path: ['opacity'],
					keys: [
						{ at: { frames: 0 }, value: 0 },
						{ at: { frames: 9 }, value: 100 },
					],
				})),
			},
		]);
		const ms = threadCpuMs() - t0;
		valid(h);
		expect(adjustments(h).every((c) => (c.opacity as Animatable<number>).keyframes.length === 2)).toBe(true);
		expect(ms).toBeLessThan(30_000);
		console.info(`[perf] keyframe.addBatch 1000 targets × 2 keys: ${ms.toFixed(0)} CPU ms`);
	});
});
