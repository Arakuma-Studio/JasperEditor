// WP6.5b carry-over (wp-note "Fix: SFX tail truncation", "Fresh inserts use the padded copy"): a project holding an
// older copy of a library sound got a SECOND media of it on its next insert (a copy has its own fingerprint).
// `media.upgradeLibraryCopy` replaces the older copy in place: same media id and Project item, the new file, and every
// clip moved in content time by the lead difference so it plays the same samples at the same times.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	type ClipSfx,
	checkInvariants,
	FLICKS_PER_SECOND,
	type LibraryProvenance,
	libraryCopyShift,
	type MediaAsset,
	olderLibraryCopyOf,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

type SfxClip = AudioClip & { sfx?: ClipSfx };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const SOUND_SEC = 0.55;

function lib(lead: number, trail: number, soundId = LIB.soundId): LibraryProvenance {
	return {
		...LIB,
		soundId,
		descriptors: {
			...LIB.descriptors!,
			peakSec: 0.0705 + lead,
			onsetSec: 0.06 + lead,
			headQuietSec: 0.05 + lead,
			durationSec: SOUND_SEC + lead + trail,
		},
		...(lead ? { leadSilenceSec: lead } : {}),
		...(trail ? { trailSilenceSec: trail } : {}),
	};
}

/** A registered copy (what the engine returns), `lead` / `trail` seconds of silence around the 0.55 s sound. */
function copyAsset(lead: number, trail: number, soundId?: string) {
	return {
		...videoAsset({ kind: 'audio', seconds: SOUND_SEC + lead + trail }),
		library: lib(lead, trail, soundId),
	};
}

function register(h: Harness, asset: ReturnType<typeof copyAsset>): string {
	const r = h.ok([{ type: 'media.register', asset }]);
	return (r.results[0] as { mediaId: string }).mediaId;
}

function place(h: Harness, mediaId: string, frame: number, extra: Record<string, unknown> = {}): string {
	const r = h.ok([{ type: 'soundDesign.place', frame, layers: [{ mediaId, gainDb: 0, ...extra }] }]);
	return (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
}

const clip = (h: Harness, id: string) => h.seq.clips[id] as SfxClip;
/** The source sample (flicks into the SOUND, lead removed) a clip plays at its first frame. */
const soundAt = (h: Harness, id: string) => {
	const c = clip(h, id);
	const p = (h.doc.media[c.mediaId] as MediaAsset & { library?: LibraryProvenance }).library;
	return c.sourceIn - Math.round((p?.leadSilenceSec ?? 0) * FLICKS_PER_SECOND);
};

describe('media.upgradeLibraryCopy', () => {
	it('replaces an older copy in place: same media and item, new file, every clip plays the same samples; immutability', () => {
		const h = new Harness();
		// an Ogg registered as it is (no lead, no trail), placed twice: one with pan keyframes
		const old = register(h, copyAsset(0, 0));
		const a = place(h, old, 60, {
			pan: {
				keyframes: [
					{ offset: -2, value: -50 },
					{ offset: 3, value: 50 },
				],
			},
		});
		const b = place(h, old, 200, { align: 'start' });
		const before = h.doc;
		const snap = clone(before);
		const items = Object.values(before.items).filter((i) => i.kind === 'media' && i.mediaId === old);
		const was = { a: clone(clip(h, a)), b: clone(clip(h, b)) };
		const soundA = soundAt(h, a);
		const soundB = soundAt(h, b);
		const asset = copyAsset(0.05, 0.05);
		const cmds = [{ type: 'media.upgradeLibraryCopy', mediaId: old, asset, ref: '$m' }];
		const first = h.ok(cmds);
		expect(first.results[0]).toMatchObject({ mediaId: old, upgraded: true, clipIds: [a, b] });
		expect(first.refs.$m).toBe(old);
		const shift = Math.round(0.05 * FLICKS_PER_SECOND);
		expect((first.results[0] as { shiftFlicks: number }).shiftFlicks).toBe(shift);
		// The previous document stays unchanged.
		expect(clone(before)).toEqual(snap);
		expect(checkInvariants(h.doc)).toEqual([]);
		const m = h.doc.media[old] as MediaAsset & { library?: LibraryProvenance };
		expect(m.fingerprint).toBe(asset.fingerprint);
		expect(m.probe.durationFlicks).toBe(asset.probe.durationFlicks);
		expect(m.library?.leadSilenceSec).toBe(0.05);
		expect(Object.keys(h.doc.media)).toHaveLength(1);
		expect(Object.values(h.doc.items).filter((i) => i.kind === 'media' && i.mediaId === old)).toEqual(items);
		for (const [id, w, sound] of [
			[a, was.a, soundA],
			[b, was.b, soundB],
		] as const) {
			const c = clip(h, id);
			expect(c.start).toBe(w.start);
			expect(c.duration).toBe(w.duration);
			expect(c.sourceIn).toBe(w.sourceIn + shift);
			expect(soundAt(h, id)).toBe(sound);
			expect(c.sfx!.placement.peakFlicks).toBe(w.sfx!.placement.peakFlicks + shift);
			expect(c.sfx!.placement.errorFlicks).toBe(w.sfx!.placement.errorFlicks);
		}
		const keys = (c: SfxClip) => (c.pan as { keyframes: { time: number }[] }).keyframes.map((k) => k.time);
		expect(keys(clip(h, a))).toEqual(keys(was.a).map((t) => t + shift));
		// registering the same new copy again (another insert) finds it by fingerprint: nothing older is left
		expect(olderLibraryCopyOf(h.doc, LIB.soundId, asset.fingerprint)).toBeNull();
	});

	it('refusals: unknown media, another sound, another length, a copy already in the project, a video', () => {
		const h = new Harness();
		const old = register(h, copyAsset(0, 0));
		const refused = (c: Record<string, unknown>, code: string) => {
			const before = h.doc;
			const r = h.tx([{ type: 'media.upgradeLibraryCopy', ...c }]);
			expect(r.ok, JSON.stringify(r)).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code).toBe(code);
			expect(h.doc).toBe(before);
		};
		refused({ mediaId: 'med_ffffffffffffffff', asset: copyAsset(0.05, 0) }, 'E_NOT_FOUND');
		refused({ mediaId: old, asset: copyAsset(0.05, 0, 'snd_00000000000000aa') }, 'E_INVALID_PARAM');
		const longer = copyAsset(0.05, 0);
		longer.probe.durationFlicks = longer.probe.durationFlicks! + Math.round(0.2 * FLICKS_PER_SECOND);
		refused({ mediaId: old, asset: longer }, 'E_INVALID_PARAM');
		const twin = copyAsset(0.05, 0);
		register(h, twin);
		refused({ mediaId: old, asset: twin }, 'E_INVALID_PARAM');
		const vid = h.registerVideo({ seconds: 2 });
		refused({ mediaId: vid, asset: copyAsset(0.05, 0) }, 'E_INVALID_PARAM');
		refused({ mediaId: old, asset: { ...copyAsset(0.05, 0), kind: 'video' } }, 'E_INVALID_PARAM');
		refused({ mediaId: old, asset: { ...copyAsset(0.05, 0), library: undefined } }, 'E_SCHEMA');
		refused({ mediaId: old, asset: copyAsset(0.05, 0), extra: 1 }, 'E_SCHEMA');
	});

	it('a clip that cannot move onto the new copy refuses it (E_OUT_OF_MEDIA), or with ifPossible keeps the old copy', () => {
		const h = new Harness();
		// an older copy with a lead the new copy does not have: a clip starting in that lead cannot move
		const old = register(h, copyAsset(0.05, 0));
		const id = place(h, old, 30, { align: 'start' });
		// extend its head to the first whole frame of the copy: it now starts inside the old lead silence
		const F = FLICKS_PER_SECOND / 30;
		h.ok([{ type: 'clip.trim', clipId: id, edge: 'in', deltaFrames: -Math.floor(clip(h, id).sourceIn / F) }]);
		expect(clip(h, id).sourceIn).toBeLessThan(Math.round(0.05 * FLICKS_PER_SECOND));
		const next = copyAsset(0, 0.05);
		const r = h.tx([{ type: 'media.upgradeLibraryCopy', mediaId: old, asset: next }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
		const kept = h.ok([
			{
				type: 'media.upgradeLibraryCopy',
				mediaId: old,
				asset: next,
				ifPossible: true,
				name: 'Hit',
				ref: '$m',
			},
		]);
		expect(kept.warnings.map((w) => w.code)).toContain('W_COPY_KEPT');
		const res = kept.results[0] as { mediaId: string; upgraded: boolean };
		expect(res.upgraded).toBe(false);
		expect(res.mediaId).not.toBe(old);
		expect(kept.refs.$m).toBe(res.mediaId);
		expect(h.doc.media[res.mediaId]!.fingerprint).toBe(next.fingerprint);
		expect(h.doc.media[old]).toBeDefined();
		expect(clip(h, id).mediaId).toBe(old);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('olderLibraryCopyOf: the most used older copy of the same sound, none when the copy is already there', () => {
		const h = new Harness();
		const a = register(h, copyAsset(0, 0));
		const b = register(h, copyAsset(0.05, 0));
		register(h, copyAsset(0, 0, 'snd_00000000000000bb'));
		place(h, b, 40);
		place(h, b, 120);
		place(h, a, 220);
		expect(olderLibraryCopyOf(h.doc, LIB.soundId, 'q1:new')).toBe(b);
		expect(olderLibraryCopyOf(h.doc, LIB.soundId, h.doc.media[a]!.fingerprint)).toBeNull();
		expect(olderLibraryCopyOf(h.doc, 'snd_00000000000000cc', 'q1:new')).toBeNull();
	});

	it('property: over leads and trails of both copies and clip positions, every clip plays the same sound samples', () => {
		const leads = [0, 0.05];
		const trails = [0, 0.05];
		fc.assert(
			fc.property(
				fc.constantFrom(...leads),
				fc.constantFrom(...trails),
				fc.constantFrom(...leads),
				fc.constantFrom(...trails),
				fc.array(fc.integer({ min: 30, max: 400 }), { minLength: 1, maxLength: 4 }),
				(l0, t0, l1, t1, frames) => {
					const h = new Harness();
					const old = register(h, copyAsset(l0, t0));
					const ids = [...new Set(frames.map((f) => Math.floor(f / 25) * 25))].map((f) => place(h, old, f));
					const was = new Map(ids.map((id) => [id, { sound: soundAt(h, id), c: clone(clip(h, id)) }]));
					const r = h.tx([
						{ type: 'media.upgradeLibraryCopy', mediaId: old, asset: copyAsset(l1, t1), ifPossible: true },
					]);
					expect(r.ok, JSON.stringify(r)).toBe(true);
					const up = (r as { results: { upgraded: boolean }[] }).results[0]!.upgraded;
					// only a smaller lead can leave a clip (one that starts inside the old lead) without its samples
					if (l1 >= l0) expect(up).toBe(true);
					for (const id of ids) {
						const w = was.get(id)!;
						expect(soundAt(h, id)).toBe(w.sound);
						expect(clip(h, id).start).toBe(w.c.start);
						expect(clip(h, id).duration).toBe(w.c.duration);
						expect(clip(h, id).mediaId).toBe(old);
						if (!up) expect(clip(h, id)).toEqual(w.c);
					}
					expect(checkInvariants(h.doc)).toEqual([]);
				},
			),
			{ numRuns: 60, seed: 6503 },
		);
	});

	it('libraryCopyShift: exact sample shifts, never NaN on hostile input', () => {
		const d = (lead: number, trail: number) => Math.round((SOUND_SEC + lead + trail) * FLICKS_PER_SECOND);
		expect(
			libraryCopyShift(
				{ library: lib(0, 0), durationFlicks: d(0, 0) },
				{ library: lib(0.05, 0.05), durationFlicks: d(0.05, 0.05) },
			),
		).toEqual({
			ok: true,
			shiftFlicks: 0.05 * FLICKS_PER_SECOND,
		});
		for (const bad of [null, 'x', { soundId: 1 }, []])
			expect(
				libraryCopyShift({ library: bad, durationFlicks: 1 }, { library: lib(0, 0), durationFlicks: 1 }).ok,
			).toBe(false);
		for (const dur of [Number.NaN, -1, 0, null, undefined, Number.POSITIVE_INFINITY])
			expect(
				libraryCopyShift(
					{ library: lib(0, 0), durationFlicks: dur },
					{ library: lib(0, 0), durationFlicks: d(0, 0) },
				).ok,
			).toBe(false);
	});
});
