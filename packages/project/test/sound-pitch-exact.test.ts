// WP6.5b carry-over (wp-note "Phase 2 verification: model review", "Not fixed"): `soundDesign.swap {pitchSt: 0}` after a
// fractional varispeed shift kept up to ±0.5 st, because the seeded ±2 % variation and a fractional shift cannot be told
// apart from the clip speed alone. Placement and swap now record the applied shift and the speed under it
// (`sfx.pitch {st, baseRate}`), so a reset gives back exactly the variation, and a re-pitch is `baseRate · 2^(st/12)`.
// Clips placed before (no record), or whose speed was changed since by another command (a stale record), keep the
// previous reading: whole semitones of varispeed, the rest is the variation.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	applyTransaction,
	type ClipSfx,
	checkInvariants,
	clipPitchOf,
	createCounterIdSource,
	flicksPerFrame,
	type LibraryProvenance,
	readClipSfx,
	repairDocument,
} from '../src/index.ts';
import { Harness, makeCtx, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

type SfxClip = AudioClip & { sfx?: ClipSfx };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const SHIFTER = 'jasper.audio.pitch-shifter';

let n = 500;
function libMedia(h: Harness): string {
	const soundId = `snd_${(++n).toString(16).padStart(16, '0')}`;
	const library: LibraryProvenance = {
		...LIB,
		soundId,
		title: `Sound ${n}`,
		types: ['hit'],
		descriptors: {
			...LIB.descriptors!,
			peakSec: 0.0705,
			onsetSec: 0.06,
			headQuietSec: 0.05,
			durationSec: 0.55,
		},
		leadSilenceSec: 0.05,
	};
	const r = h.ok([
		{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: 0.55 }), library } },
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}

const clip = (h: Harness, id: string) => h.seq.clips[id] as SfxClip;
const shifters = (c: SfxClip) => c.effects.filter((fx) => (fx as { effectId?: string }).effectId === SHIFTER);

function placed(h: Harness, media: string, frame: number, extra: Record<string, unknown> = {}): string {
	const r = h.ok([{ type: 'soundDesign.place', frame, layers: [{ mediaId: media, ...extra }] }]);
	return (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
}
const swapPitch = (h: Harness, id: string, m: string, pitchSt: number) =>
	h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: m, pitchSt }]);
const alignedAt = (c: SfxClip, F: number) =>
	c.start * F + (c.sfx!.placement.peakFlicks - c.sourceIn) / c.speed.rate - c.sfx!.placement.errorFlicks;

describe('pitch reset is exact (sfx.pitch)', () => {
	it('swap {pitchSt: 0} after a fractional varispeed shift restores the variation exactly', () => {
		const h = new Harness();
		const m = libMedia(h);
		// 1.02 · 2^(2.5/12) is nearer 3 st than 2: the speed alone reads as "3 st, variation 0.9906"
		const id = placed(h, m, 90, { rate: 1.02 });
		swapPitch(h, id, m, 2.5);
		expect(clip(h, id).speed.rate).toBeCloseTo(1.02 * 2 ** (2.5 / 12), 5);
		expect(clipPitchOf(clip(h, id))).toMatchObject({ st: 2.5, baseRate: 1.02, recorded: true });
		swapPitch(h, id, m, 0);
		const c = clip(h, id);
		expect(c.speed.rate).toBe(1.02);
		expect(shifters(c)).toHaveLength(0);
		expect(clipPitchOf(c)).toMatchObject({ st: 0, baseRate: 1.02 });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('place {pitchSt} (and a cue’s pitch) records the shift; a later reset and re-pitch are exact', () => {
		const h = new Harness();
		const m = libMedia(h);
		const id = placed(h, m, 60, { rate: 0.9817, pitchSt: -2.75 });
		expect(clip(h, id).sfx!.pitch).toEqual({ st: -2.75, baseRate: 0.9817 });
		swapPitch(h, id, m, 1.5);
		expect(clip(h, id).speed.rate).toBe(Math.round(0.9817 * 2 ** (1.5 / 12) * 1e6) / 1e6);
		swapPitch(h, id, m, 0);
		expect(clip(h, id).speed.rate).toBe(0.9817);
		// through a cue's pitch
		const cue = h.ok([
			{
				type: 'soundCue.add',
				cues: [{ frame: 150, kind: 'cut', weight: 'support', source: 'user', pitchSt: 2.4 }],
			},
		]);
		const cueId = (cue.results[0] as { cueIds: string[] }).cueIds[0]!;
		const r = h.ok([{ type: 'soundDesign.place', cueId, layers: [{ mediaId: m, rate: 1.0137 }] }]);
		const cid = (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		expect(clip(h, cid).sfx!.pitch).toEqual({ st: 2.4, baseRate: 1.0137 });
		swapPitch(h, cid, m, 0);
		expect(clip(h, cid).speed.rate).toBe(1.0137);
	});

	it('across the Pitch Shifter boundary both ways; the aligned point stays; never two shifters', () => {
		const h = new Harness();
		const m = libMedia(h);
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const id = placed(h, m, 90, { rate: 1.0199 });
		for (const st of [2.5, 7.25, -2.6, -11.5, 0.49, 0]) {
			swapPitch(h, id, m, st);
			const c = clip(h, id);
			const varispeed = Math.abs(st) <= 3;
			expect(c.speed.rate).toBe(varispeed ? Math.round(1.0199 * 2 ** (st / 12) * 1e6) / 1e6 : 1.0199);
			expect(shifters(c)).toHaveLength(varispeed ? 0 : 1);
			expect(clipPitchOf(c).st).toBe(st);
			expect(Math.abs(alignedAt(c, F) - 90 * F)).toBeLessThanOrEqual(1);
		}
		expect(clip(h, id).speed.rate).toBe(1.0199);
	});

	it('undo / redo: the record follows the document', () => {
		const h = new Harness();
		const m = libMedia(h);
		const id = placed(h, m, 90, { rate: 1.015 });
		swapPitch(h, id, m, 2.5);
		const before = h.doc;
		const snap = clone(before);
		const cmds = [{ type: 'soundDesign.swap', clipId: id, mediaId: m, pitchSt: 0 }];
		const run = () =>
			applyTransaction(
				before,
				{ label: 't', origin: 'user', sequenceId: h.seqId, commands: cmds as never },
				makeCtx({ revision: h.revision }, createCounterIdSource(7)),
			);
		const first = run();
		expect(first.result.ok).toBe(true);
		// undo = the untouched document (still 2.5 st), redo = the same result
		expect(clone(before)).toEqual(snap);
		expect((before.sequences[h.seqId]!.clips[id] as SfxClip).sfx!.pitch).toEqual({
			st: 2.5,
			baseRate: 1.015,
		});
		expect(run().document).toEqual(first.document);
		const after = first.document.sequences[h.seqId]!.clips[id] as SfxClip;
		expect(after.speed.rate).toBe(1.015);
		expect(after.sfx!.pitch).toEqual({ st: 0, baseRate: 1.015 });
	});

	it('a clip placed before the record (none) keeps the previous reading; a stale record is ignored', () => {
		const h = new Harness();
		const m = libMedia(h);
		const id = placed(h, m, 90, { rate: 1.01 });
		swapPitch(h, id, m, 2);
		// an older build's clip: no record (whole semitones read exactly)
		const seq = h.doc.sequences[h.seqId]!;
		const c0 = clone(seq.clips[id]) as SfxClip;
		delete c0.sfx!.pitch;
		h.doc = {
			...h.doc,
			sequences: { ...h.doc.sequences, [h.seqId]: { ...seq, clips: { ...seq.clips, [id]: c0 } } },
		};
		expect(clipPitchOf(clip(h, id))).toMatchObject({ st: 2, recorded: false });
		swapPitch(h, id, m, 0);
		expect(clip(h, id).speed.rate).toBeCloseTo(1.01, 6);
		// the speed changed by another command since: the record no longer describes it and is not used
		swapPitch(h, id, m, 1.5);
		h.ok([{ type: 'clip.setSpeed', clipIds: [id], rate: 1.5, ripple: false }]);
		const p = clipPitchOf(clip(h, id));
		expect(p.recorded).toBe(false);
		// 1.5× is 7 st of varispeed: past ±3, so the previous reading takes it all as speed
		expect(p.st).toBe(0);
		swapPitch(h, id, m, 0);
		expect(clip(h, id).sfx!.pitch).toEqual({ st: 0, baseRate: clip(h, id).speed.rate });
	});

	it('repair: a malformed record is dropped field by field, the clip kept', () => {
		const base = {
			cueId: null,
			soundId: null,
			layer: 0,
			role: 'support',
			placement: { align: 'peak', peakFlicks: 10, errorFlicks: 0 },
		};
		for (const bad of [
			{ st: Number.NaN, baseRate: 1 },
			{ st: 13, baseRate: 1 },
			{ st: 1, baseRate: 0 },
			{ st: 1, baseRate: Number.POSITIVE_INFINITY },
			{ st: 1 },
			'x',
			[1, 2],
		]) {
			const r = readClipSfx({ ...base, pitch: bad });
			expect(r).not.toBeNull();
			expect(r!.pitch).toBeUndefined();
		}
		expect(readClipSfx({ ...base, pitch: { st: -2.5, baseRate: 0.99 } })!.pitch).toEqual({
			st: -2.5,
			baseRate: 0.99,
		});
		// repairDocument goes through the same reading
		const h = new Harness();
		const m = libMedia(h);
		const id = placed(h, m, 30, { rate: 1.01, pitchSt: 1.5 });
		const doc = clone(h.doc);
		(doc.sequences[h.seqId]!.clips[id] as SfxClip).sfx!.pitch = { st: 99, baseRate: -1 } as never;
		const fixed = repairDocument(doc, createCounterIdSource(99));
		const fc0 = fixed.document.sequences[h.seqId]!.clips[id] as SfxClip;
		expect(fc0.sfx).toBeDefined();
		expect(fc0.sfx!.pitch).toBeUndefined();
		expect(checkInvariants(fixed.document)).toEqual([]);
	});

	it('property: any run of pitches over any variation resets to exactly the variation', () => {
		const h0 = new Harness();
		const m = libMedia(h0);
		const base = h0.doc;
		fc.assert(
			fc.property(
				fc.oneof(fc.integer({ min: 9800, max: 10200 }), fc.constant(10_000)),
				fc.array(fc.integer({ min: -1200, max: 1200 }), { minLength: 1, maxLength: 5 }),
				fc.integer({ min: -1200, max: 1200 }),
				(v, steps, placeSt) => {
					const h = new Harness();
					h.doc = base;
					const variation = v / 10_000;
					const id = placed(h, m, 120, { rate: variation, pitchSt: placeSt / 100 });
					for (const s of steps) {
						swapPitch(h, id, m, s / 100);
						const c = clip(h, id);
						const st = s / 100;
						expect(clipPitchOf(c).st).toBe(st);
						if (Math.abs(st) <= 3 && st !== 0)
							expect(c.speed.rate).toBe(Math.round(variation * 2 ** (st / 12) * 1e6) / 1e6);
						else expect(c.speed.rate).toBe(variation);
					}
					swapPitch(h, id, m, 0);
					const c = clip(h, id);
					expect(c.speed.rate).toBe(variation);
					expect(shifters(c)).toHaveLength(0);
					expect(clipPitchOf(c)).toMatchObject({ st: 0, baseRate: variation });
					// recorded unless the speed alone says it (0 st over speed 1)
					expect(c.sfx!.pitch).toEqual(variation === 1 ? undefined : { st: 0, baseRate: variation });
				},
			),
			{ numRuns: 150, seed: 6505 },
		);
	});
});
