// `soundDesign.setAutoGain` (Essential Sound ▸ Sound Design ▸ "Auto gain", spec 12 §2.7; wp-note "Phase 4 → WP4.2b"):
// off keeps the gain as the user's own (the level stays for display, marked `manual`), so swaps, role changes and
// delivery presets leave it alone; on hands it back; a solve naming the clip replaces the record; undo / redo; refusals;
// the flag through load and repair.
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	type ClipSfx,
	checkInvariants,
	createCounterIdSource,
	type LibraryProvenance,
	loadProject,
	repairDocument,
	sfxGainOwner,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

type SfxClip = AudioClip & { sfx?: ClipSfx };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

let n = 0;
function libMedia(h: Harness, types: string[] = ['hit']) {
	const soundId = `snd_${(0xb000 + ++n).toString(16).padStart(16, '0')}`;
	const library: LibraryProvenance = {
		...LIB,
		soundId,
		title: `Sound ${n}`,
		types,
		descriptors: {
			...LIB.descriptors!,
			peakSec: 0.0705,
			onsetSec: 0.06,
			headQuietSec: 0.05,
			durationSec: 0.55,
			maxMomentaryLufs: -20,
			truePeakDb: -10,
		} as LibraryProvenance['descriptors'],
		leadSilenceSec: 0.05,
	};
	const r = h.ok([
		{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: 0.55 }), library } },
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}
const clipOf = (h: Harness, id: string) => h.seq.clips[id] as SfxClip;
const placed = (r: { results: unknown[] }) =>
	r.results.flatMap((q) => ((q as { clips?: { clipId: string }[] }).clips ?? []).map((c) => c.clipId));

describe('soundDesign.setAutoGain', () => {
	it('off keeps the solved gain as the user’s (level kept, manual); on hands it back; undo / redo', () => {
		const h = new Harness();
		const m = libMedia(h);
		const [a] = placed(
			h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m, gainOffsetDb: 0.5 }] }]),
		);
		h.ok([
			{
				type: 'soundDesign.applyGains',
				gains: { [a!]: -6 },
				report: { [a!]: { targetLiftDb: 3.5, achievedLiftDb: 1.2, limitedBy: ['dialogue'], reason: 'x' } },
			},
		]);
		expect(sfxGainOwner(clipOf(h, a!))).toBe('solver');
		const before = h.doc;
		const snapshot = clone(before);
		const off = { type: 'soundDesign.setAutoGain', clipIds: [a!], auto: false };
		const r = h.ok([off], { label: 'Auto Gain' });
		expect(r.results[0]).toEqual({ clips: [{ clipId: a, owner: 'user' }] });
		expect(clipOf(h, a!).gainDb).toBe(-6);
		expect(clipOf(h, a!).sfx!.level).toEqual({
			by: 'solver',
			gainDb: -6,
			offsetDb: 0.5,
			targetLiftDb: 3.5,
			achievedLiftDb: 1.2,
			limitedBy: ['dialogue'],
			reason: 'x',
			manual: true,
		});
		expect(checkInvariants(h.doc)).toEqual([]);
		// undo = the document before (untouched), redo = the same document
		expect(before).toEqual(snapshot);
		const after = clone(h.doc);
		h.doc = before;
		h.ok([off]);
		expect(clone(h.doc.sequences)).toEqual(after.sequences);
		// on: the solver owns it again (the gain still equals the record)
		const on = h.ok([{ type: 'soundDesign.setAutoGain', clipIds: [a!], auto: true }]);
		expect(on.results[0]).toEqual({ clips: [{ clipId: a, owner: 'solver' }] });
		expect(clipOf(h, a!).sfx!.level).not.toHaveProperty('manual');
	});

	it('a manual gain survives a swap, a role change and a delivery preset; a solve naming it replaces the record', () => {
		const h = new Harness();
		const m = libMedia(h);
		const other = libMedia(h, ['boom']);
		const [a, b] = placed(
			h.ok([
				{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] },
				{ type: 'soundDesign.place', frame: 140, layers: [{ mediaId: m }] },
			]),
		);
		h.ok([{ type: 'soundDesign.setAutoGain', clipIds: [a!], auto: false }]);
		const gain = clipOf(h, a!).gainDb;
		h.ok([{ type: 'soundDesign.setRole', clipIds: [a!, b!], role: 'hero' }]);
		h.ok([{ type: 'soundDesign.swap', clipId: a!, mediaId: other }]);
		h.ok([{ type: 'soundDesign.applyDelivery', delivery: 'broadcast-r128', loudness: false }]);
		expect(clipOf(h, a!).gainDb).toBe(gain);
		expect(sfxGainOwner(clipOf(h, a!))).toBe('user');
		// the automatic one followed the role and the delivery
		expect(clipOf(h, b!).gainDb).not.toBe(gain);
		expect(sfxGainOwner(clipOf(h, b!))).toBe('default');
		// a solve that does not name it on purpose (no override) leaves it: skipped, reported
		const skip = h.ok([{ type: 'soundDesign.applyGains', gains: { [a!]: -9 } }]);
		expect(skip.results[0]).toMatchObject({ clips: [], skipped: [{ clipId: a }] });
		expect(clipOf(h, a!).gainDb).toBe(gain);
		h.ok([{ type: 'soundDesign.applyGains', gains: { [a!]: -9 }, override: true }]);
		expect(clipOf(h, a!).sfx!.level).toEqual({ by: 'solver', gainDb: -9, limitedBy: [] });
		expect(sfxGainOwner(clipOf(h, a!))).toBe('solver');
	});

	it('on hands a gain the user changed since back to the recorded level (spec 12 §2.7); clips without a level are left alone', () => {
		const h = new Harness();
		const m = libMedia(h);
		const [a] = placed(h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] }]));
		const level = clipOf(h, a!).sfx!.level!.gainDb;
		h.ok([{ type: 'audio.setGain', clipIds: [a!], mode: 'set', db: 2 }]);
		const r = h.ok([{ type: 'soundDesign.setAutoGain', clipIds: [a!], auto: true }]);
		expect(r.results[0]).toEqual({ clips: [{ clipId: a, owner: 'default' }] });
		expect(clipOf(h, a!).gainDb).toBe(level);
		// an Essential-SFX clip without sfx metadata: nothing to mark, accepted
		const v = h.registerVideo({ audio: true });
		const placedRefs = h.ok([
			{ type: 'clip.place', source: { mediaId: v }, at: 300, tracks: { audio: 'A3' }, ref: '$c' },
		]).refs as Record<string, string>;
		const c = Object.values(h.seq.clips).find((x) => x.kind === 'audio' && x.id !== a && x.start === 300)!;
		expect(placedRefs.$c).toBeTruthy();
		h.ok([{ type: 'essentialSound.setType', clipIds: [c.id], audioType: 'sfx' }]);
		const before = clone(h.doc.sequences);
		const r2 = h.ok([{ type: 'soundDesign.setAutoGain', clipIds: [c.id], auto: false }]);
		expect(r2.results[0]).toEqual({ clips: [{ clipId: c.id, owner: 'user' }] });
		expect(clone(h.doc.sequences)).toEqual(before);
		// on: nothing to hand it to, reported
		const r3 = h.ok([{ type: 'soundDesign.setAutoGain', clipIds: [c.id], auto: true }]);
		expect(r3.results[0]).toEqual({
			clips: [
				{
					clipId: c.id,
					owner: 'user',
					skipped: 'no recorded level to hand the gain to (rebalance to solve it)',
				},
			],
		});
		expect(clone(h.doc.sequences)).toEqual(before);
	});

	it('refuses unknown clips, non-effects, locked tracks and bad arguments', () => {
		const h = new Harness();
		const m = libMedia(h);
		const [a] = placed(h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] }]));
		const v = h.registerVideo({ audio: true });
		h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 200, tracks: { video: 'V1', audio: 'A2' } }]);
		const vid = Object.values(h.seq.clips).find((c) => c.kind === 'video')!.id;
		const bed = Object.values(h.seq.clips).find((c) => c.kind === 'audio' && c.id !== a)!.id;
		const code = (cmd: Record<string, unknown>) => {
			const r = h.tx([{ type: 'soundDesign.setAutoGain', auto: false, ...cmd }]);
			expect(r.ok).toBe(false);
			return r.ok ? null : r.errors[0]!.code;
		};
		expect(code({ clipIds: ['clp_00000000000nope'] })).toBe('E_NOT_FOUND');
		expect(code({ sequenceId: 'seq_000000000000none', clipIds: [a!] })).toBe('E_NOT_FOUND');
		expect(code({ clipIds: [vid] })).toBe('E_INVALID_PARAM');
		expect(code({ clipIds: [bed] })).toBe('E_INVALID_PARAM');
		expect(code({ clipIds: [] })).toBe('E_SCHEMA');
		expect(code({ clipIds: [a!], auto: 'no' })).toBe('E_SCHEMA');
		expect(code({ clipIds: [a!], bogus: 1 })).toBe('E_SCHEMA');
		const track = clipOf(h, a!).trackId;
		h.ok([{ type: 'track.update', trackId: track, patch: { locked: true } }]);
		expect(code({ clipIds: [a!] })).toBe('E_TRACK_LOCKED');
		h.ok([{ type: 'track.update', trackId: track, patch: { locked: false } }]);
		expect(sfxGainOwner(clipOf(h, a!))).toBe('default');
	});

	it('the manual flag survives load; a damaged one drops the level (gain kept), idempotently', () => {
		const h = new Harness();
		const m = libMedia(h);
		const [a] = placed(h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] }]));
		h.ok([{ type: 'soundDesign.setAutoGain', clipIds: [a!], auto: false }]);
		const good = loadProject(clone(h.doc), { ids: createCounterIdSource(900) });
		expect(good.issues).toEqual([]);
		const g = good.document.sequences[h.seqId]!.clips[a!] as SfxClip;
		expect(g.sfx!.level).toMatchObject({ by: 'default', manual: true });
		expect(sfxGainOwner(g)).toBe('user');
		const raw = clone(h.doc);
		const sfx = (raw.sequences[h.seqId]!.clips[a!] as unknown as { sfx: { level: Record<string, unknown> } })
			.sfx;
		sfx.level.manual = 'yes';
		const loaded = loadProject(raw, { ids: createCounterIdSource(901) });
		const out = loaded.document.sequences[h.seqId]!.clips[a!] as SfxClip;
		expect(out.sfx!.level).toBeUndefined();
		expect(out.gainDb).toBe(clipOf(h, a!).gainDb);
		expect(sfxGainOwner(out)).toBe('user');
		expect(repairDocument(loaded.document, createCounterIdSource(5000)).report).toEqual([]);
	});
});
