// WP2.4b model additions (spec 12 §2.7 Essential Sound ▸ Align / Pitch / Role, Detect Peak): `soundDesign.swap` with the
// same media re-aligns, `pitchSt` re-pitches around the aligned point (varispeed keeps the seeded variation, larger
// shifts use the Pitch Shifter), `soundDesign.setRole`, and `soundDesign.setPeak` on project audio (no library sound).
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	type ClipSfx,
	checkInvariants,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type LibraryProvenance,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

type SfxClip = AudioClip & { sfx?: ClipSfx };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

let n = 100;
function libMedia(h: Harness, o: { peakSec?: number; durationSec?: number; types?: string[] } = {}): string {
	const durationSec = o.durationSec ?? 0.55;
	const soundId = `snd_${(++n).toString(16).padStart(16, '0')}`;
	const library: LibraryProvenance = {
		...LIB,
		soundId,
		title: `Sound ${n}`,
		types: o.types ?? ['hit'],
		descriptors: {
			...LIB.descriptors!,
			peakSec: o.peakSec ?? 0.0705,
			onsetSec: 0.06,
			headQuietSec: 0.05,
			durationSec,
		},
		leadSilenceSec: 0.05,
	};
	const r = h.ok([
		{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: durationSec }), library } },
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}

const clip = (h: Harness, id: string) => h.seq.clips[id] as SfxClip;
const err = (r: ReturnType<Harness['tx']>) => (r.ok ? null : r.errors[0]!);

function placed(h: Harness, media: string, frame: number, extra: Record<string, unknown> = {}): string {
	const r = h.ok([{ type: 'soundDesign.place', frame, layers: [{ mediaId: media, ...extra }] }]);
	return (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
}

/** Sequence flicks at which the clip's aligned point plays. */
const alignedAt = (c: SfxClip, F: number) =>
	c.start * F + (c.sfx!.placement.peakFlicks - c.sourceIn) / c.speed.rate;

describe('soundDesign.swap: align and pitch (Essential Sound SFX)', () => {
	it('the same media with another align puts its start / end on the frame the peak played at; undo / redo', () => {
		const h = new Harness();
		const m = libMedia(h, { peakSec: 0.25, durationSec: 0.9 });
		const id = placed(h, m, 120);
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const before = h.doc;
		const snap = clone(before);
		const r = h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: m, align: 'start' }]);
		const c = clip(h, id);
		expect(c.sfx!.placement.align).toBe('start');
		expect(Math.abs(alignedAt(c, F) - 120 * F)).toBeLessThanOrEqual(1);
		expect(c.sfx!.placement.peakFlicks).toBe(Math.round(0.06 * FLICKS_PER_SECOND));
		expect((r.results[0] as { alignedFrame: number }).alignedFrame).toBe(120);
		// end: the clip's last sample lands on frame 120 (it starts earlier)
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: m, align: 'end' }]);
		const e = clip(h, id);
		expect(e.sfx!.placement.align).toBe('end');
		expect(e.start).toBeLessThan(c.start);
		expect(Math.abs(alignedAt(e, F) - 120 * F)).toBeLessThanOrEqual(1);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snap);
	});

	it('pitchSt: varispeed within ±3 st keeps the variation and the aligned point; larger uses the Pitch Shifter; 0 resets', () => {
		const h = new Harness();
		const m = libMedia(h);
		const id = placed(h, m, 90, { rate: 1.012 });
		const F = flicksPerFrame(h.seq.settings.frameRate);
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: m, pitchSt: 2 }]);
		let c = clip(h, id);
		expect(c.speed.rate).toBeCloseTo(1.012 * 2 ** (2 / 12), 5);
		expect(c.speed.maintainPitch).toBe(false);
		expect(Math.abs(alignedAt(c, F) - 90 * F)).toBeLessThanOrEqual(1);
		expect(
			c.effects.some((fx) => (fx as { effectId?: string }).effectId === 'jasper.audio.pitch-shifter'),
		).toBe(false);
		// +5 st: speed back to the variation, the shifter carries the shift
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: m, pitchSt: 5.5 }]);
		c = clip(h, id);
		expect(c.speed.rate).toBeCloseTo(1.012, 5);
		const shifters = c.effects.filter(
			(fx) => (fx as { effectId?: string }).effectId === 'jasper.audio.pitch-shifter',
		);
		expect(shifters).toHaveLength(1);
		expect((shifters[0]!.params.semitones as { value: number }).value).toBe(5);
		expect((shifters[0]!.params.cents as { value: number }).value).toBe(50);
		expect(Math.abs(alignedAt(c, F) - 90 * F)).toBeLessThanOrEqual(1);
		// 0: no shifter, no varispeed shift (the variation stays)
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: m, pitchSt: 0 }]);
		c = clip(h, id);
		expect(c.speed.rate).toBeCloseTo(1.012, 5);
		expect(
			c.effects.some((fx) => (fx as { effectId?: string }).effectId === 'jasper.audio.pitch-shifter'),
		).toBe(false);
		expect(checkInvariants(h.doc)).toEqual([]);
		// refusals
		expect(err(h.tx([{ type: 'soundDesign.swap', clipId: id, mediaId: m, pitchSt: 13 }]))?.code).toBe(
			'E_SCHEMA',
		);
	});

	it('pan keyframes keep their sequence times through a pitch change', () => {
		const h = new Harness();
		const m = libMedia(h, { types: ['whoosh'], peakSec: 0.3, durationSec: 1 });
		const id = placed(h, m, 90, {
			pan: {
				keyframes: [
					{ offset: -3, value: -50 },
					{ offset: 3, value: 50 },
				],
			},
		});
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const seqTimes = () => {
			const c = clip(h, id);
			return c.pan.keyframes.map((k) => c.start * F + (k.time - c.sourceIn) / c.speed.rate);
		};
		const t0 = seqTimes();
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: m, pitchSt: -3 }]);
		for (const [i, t] of seqTimes().entries()) expect(Math.abs(t - t0[i]!)).toBeLessThanOrEqual(1);
	});
});

describe('soundDesign.swap: frame and pitch together (merged with WP2.3)', () => {
	it('re-pitches onto another frame: the aligned point lands there, pan keys travel with it', () => {
		const h = new Harness();
		const m = libMedia(h, { types: ['whoosh'], peakSec: 0.3, durationSec: 1 });
		const id = placed(h, m, 90, {
			pan: {
				keyframes: [
					{ offset: -3, value: -50 },
					{ offset: 3, value: 50 },
				],
			},
		});
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const keyTimes = () => {
			const c = clip(h, id);
			return c.pan.keyframes.map((k) => c.start * F + (k.time - c.sourceIn) / c.speed.rate);
		};
		const t0 = keyTimes();
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: m, frame: 120, pitchSt: 2 }]);
		const c = clip(h, id);
		expect(c.speed.rate).toBeCloseTo(2 ** (2 / 12), 5);
		expect(Math.abs(alignedAt(c, F) - 120 * F)).toBeLessThanOrEqual(1);
		for (const [i, t] of keyTimes().entries()) expect(Math.abs(t - (t0[i]! + 30 * F))).toBeLessThanOrEqual(2);
	});
});

describe('soundDesign.setRole', () => {
	it('sets the role of placed clips; a library clip without sfx gets it; undo / redo; refusals', () => {
		const h = new Harness();
		const m = libMedia(h);
		const a = placed(h, m, 60);
		const r0 = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 200,
				tracks: { audio: 'A1' },
				video: false,
				ref: '$b',
			},
		]);
		const b = r0.refs.$b!;
		expect(clip(h, b).sfx).toBeUndefined();
		const before = h.doc;
		const snap = clone(before);
		const r = h.ok([{ type: 'soundDesign.setRole', clipIds: [a, b], role: 'hero' }]);
		expect(r.results[0]).toEqual({ clipIds: [a, b], role: 'hero' });
		expect(clip(h, a).sfx!.role).toBe('hero');
		expect(clip(h, b).sfx).toMatchObject({
			cueId: null,
			role: 'hero',
			layer: 0,
			soundId: (h.doc.media[m]!.library as LibraryProvenance).soundId,
		});
		expect(clip(h, b).sfx!.placement.align).toBe('peak');
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snap);
		const after = clone(h.doc);
		h.doc = before;
		h.ok([{ type: 'soundDesign.setRole', clipIds: [a, b], role: 'hero' }]);
		expect(clone(h.doc)).toEqual(after);
		// refusals
		const plain = h.registerVideo({ seconds: 5 });
		const pr = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: plain },
				at: 300,
				tracks: { video: 'V1', audio: 'A3' },
				ref: '$p',
			},
		]);
		const linked = Object.values(h.seq.clips).filter((c) => c.start === 300);
		const v = linked.find((c) => c.kind === 'video')!.id;
		const plainAudio = linked.find((c) => c.kind === 'audio')!.id;
		expect(pr.ok).toBe(true);
		const code = (cmd: Record<string, unknown>) => err(h.tx([{ type: 'soundDesign.setRole', ...cmd }]))?.code;
		expect(code({ clipIds: ['clp_0000000000000999'], role: 'hero' })).toBe('E_NOT_FOUND');
		expect(code({ clipIds: [v], role: 'hero' })).toBe('E_INVALID_PARAM');
		expect(code({ clipIds: [plainAudio], role: 'hero' })).toBe('E_INVALID_PARAM');
		expect(code({ clipIds: [a], role: 'boss' })).toBe('E_SCHEMA');
		expect(code({ clipIds: [], role: 'hero' })).toBe('E_SCHEMA');
		h.ok([{ type: 'track.update', trackId: clip(h, a).trackId, patch: { locked: true } }]);
		expect(code({ clipIds: [a], role: 'layer' })).toBe('E_TRACK_LOCKED');
	});
});

describe('soundDesign.setPeak on project audio (Detect Peak)', () => {
	it('an audio clip that is not a library sound gets sfx with no sound id; the clip does not move; undo', () => {
		const h = new Harness();
		const plain = h.registerVideo({ seconds: 5 });
		h.ok([{ type: 'clip.place', source: { mediaId: plain }, at: 100, tracks: { video: 'V1', audio: 'A2' } }]);
		const a = Object.values(h.seq.clips).find((c) => c.kind === 'audio')! as SfxClip;
		const before = h.doc;
		h.ok([{ type: 'soundDesign.setPeak', clipId: a.id, peakFlicks: Math.round(1.25 * FLICKS_PER_SECOND) }]);
		const c = clip(h, a.id);
		expect(c.start).toBe(a.start);
		expect(c.sfx).toEqual({
			cueId: null,
			soundId: null,
			layer: 0,
			role: 'support',
			placement: { align: 'peak', peakFlicks: Math.round(1.25 * FLICKS_PER_SECOND), errorFlicks: 0 },
		});
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before.sequences[h.seqId]!.clips[a.id]).toEqual(a);
	});
});
