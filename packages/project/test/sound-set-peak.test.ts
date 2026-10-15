// soundDesign.setPeak (spec 12 §2.7 "Peak handle", Shift-drag): a peak override on a placed clip or a library clip;
// the clip does not move; the error against its cue; refusals; undo / redo.
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

function libMedia(h: Harness): string {
	const library: LibraryProvenance = {
		...LIB,
		descriptors: { ...LIB.descriptors!, peakSec: 0.0705, onsetSec: 0.06, headQuietSec: 0.05, durationSec: 0.55 },
		leadSilenceSec: 0.05,
	};
	const r = h.ok([
		{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: 0.55 }), library } },
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}

const clipOf = (h: Harness, id: string) => h.seq.clips[id] as SfxClip;

describe('soundDesign.setPeak', () => {
	it('overrides the peak of a placed clip without moving it; the error is measured against its cue; undo / redo', () => {
		const h = new Harness();
		const m = libMedia(h);
		const cueId = (
			h.ok([{ type: 'soundCue.add', cues: [{ frame: 45, kind: 'land', weight: 'hero', source: 'user' }] }])
				.results[0] as { cueIds: string[] }
		).cueIds[0]!;
		const placed = h.ok([{ type: 'soundDesign.place', cueId, layers: [{ mediaId: m }] }]);
		const id = (placed.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		const before = h.doc;
		const snapshot = clone(before);
		const c0 = clipOf(h, id);
		const F = flicksPerFrame(h.seq.settings.frameRate);
		// the real peak is 2 frames later than the descriptors said
		const peakFlicks = c0.sfx!.placement.peakFlicks + 2 * F;
		const r = h.ok([{ type: 'soundDesign.setPeak', clipId: id, peakFlicks: Math.round(peakFlicks) }]);
		const c = clipOf(h, id);
		expect(c.start).toBe(c0.start);
		expect(c.sourceIn).toBe(c0.sourceIn);
		expect(c.sfx!.placement).toEqual({ align: 'peak', peakFlicks: Math.round(peakFlicks), errorFlicks: Math.round(2 * F) });
		expect(c.sfx!.cueId).toBe(cueId);
		expect(r.results[0]).toEqual({ clipId: id, peakFlicks: Math.round(peakFlicks), errorFlicks: Math.round(2 * F) });
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(r.changed).toContain(id);
		// a peak before the cue frame is early: no lateness to record
		h.ok([{ type: 'soundDesign.setPeak', clipId: id, peakFlicks: 0 }]);
		expect(clipOf(h, id).sfx!.placement.errorFlicks).toBe(0);
		// undo: the document before the transaction is untouched; redo gives the same document
		expect(before).toEqual(snapshot);
		h.doc = before;
		h.ok([{ type: 'soundDesign.setPeak', clipId: id, peakFlicks: Math.round(peakFlicks) }]);
		expect(clipOf(h, id).sfx!.placement.peakFlicks).toBe(Math.round(peakFlicks));
		expect(clipOf(h, id).start).toBe(c0.start);
	});

	it('gives a library clip placed without sound design its sfx metadata (not linked to a cue)', () => {
		const h = new Harness();
		const m = libMedia(h);
		const r = h.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: 30, tracks: { audio: 'A1' }, video: false, ref: '$c' },
		]);
		const id = r.refs.$c!;
		expect(clipOf(h, id).sfx).toBeUndefined();
		h.ok([{ type: 'soundDesign.setPeak', clipId: id, peakFlicks: Math.round(0.1 * FLICKS_PER_SECOND) }]);
		expect(clipOf(h, id).sfx).toEqual({
			cueId: null,
			soundId: LIB.soundId,
			layer: 0,
			role: 'support',
			placement: { align: 'peak', peakFlicks: Math.round(0.1 * FLICKS_PER_SECOND), errorFlicks: 0 },
		});
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refuses: unknown clip, not audio, not a library sound, past the media end, locked track, bad input', () => {
		const h = new Harness();
		const m = libMedia(h);
		const plain = h.registerVideo({ seconds: 5 });
		const r = h.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' }, video: false, ref: '$a' },
			{ type: 'clip.place', source: { mediaId: plain }, at: 100, tracks: { video: 'V1', audio: 'A2' }, ref: '$v' },
		]);
		const a = r.refs.$a!;
		const linked = Object.values(h.seq.clips).filter((c) => c.start === 100);
		const v = linked.find((c) => c.kind === 'video')!.id;
		const plainAudio = linked.find((c) => c.kind === 'audio')!.id;
		const code = (cmd: Record<string, unknown>) => {
			const x = h.tx([{ type: 'soundDesign.setPeak', ...cmd }]);
			return x.ok ? null : x.errors[0]!.code;
		};
		expect(code({ clipId: 'clp_0000000000000000', peakFlicks: 0 })).toBe('E_NOT_FOUND');
		expect(code({ clipId: v, peakFlicks: 0 })).toBe('E_INVALID_PARAM');
		expect(code({ clipId: plainAudio, peakFlicks: 0 })).toBe('E_INVALID_PARAM');
		expect(code({ clipId: a, peakFlicks: Math.round(0.6 * FLICKS_PER_SECOND) })).toBe('E_INVALID_PARAM');
		expect(code({ clipId: a, peakFlicks: -1 })).toBe('E_SCHEMA');
		expect(code({ clipId: a, peakFlicks: 1.5 })).toBe('E_SCHEMA');
		expect(code({ clipId: a, peakFlicks: 0, extra: 1 })).toBe('E_SCHEMA');
		const track = clipOf(h, a).trackId;
		h.ok([{ type: 'track.update', trackId: track, patch: { locked: true } }]);
		expect(code({ clipId: a, peakFlicks: 0 })).toBe('E_TRACK_LOCKED');
	});
});
