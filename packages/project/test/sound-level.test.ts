// Default insert level (spec 12 §2.3; Phase 2 verification B): `defaultSfxLevel` (role targets, delivery, true-peak
// ceiling, range, unmeasured sounds; property over hostile descriptors) and `soundDesign.place` applying it when no
// gain is given (recorded as `sfx.level`, `gainOffsetDb` for the variation), a swap / role change refreshing an
// untouched default and keeping a gain set since, undo / redo, refusals and the repair of a bad stored level.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	type ClipSfx,
	checkInvariants,
	createCounterIdSource,
	DELIVERY_INTEGRATED_LUFS,
	defaultSfxLevel,
	type LibraryProvenance,
	loadProject,
	repairDocument,
	SFX_DEFAULT_GAIN_MAX_DB,
	SFX_DEFAULT_GAIN_MIN_DB,
	SFX_PEAK_CEILING_DBTP,
	SFX_ROLES,
	SOUND_DELIVERIES,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

type SfxClip = AudioClip & { sfx?: ClipSfx };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('defaultSfxLevel', () => {
	it('web delivery: hero −16, support −22, layer −24, ambience −30 LUFS momentary', () => {
		const at = (role: (typeof SFX_ROLES)[number], types: string[] = ['hit']) =>
			defaultSfxLevel({ role, types, maxMomentaryLufs: -20, truePeakDb: -30 });
		expect(at('hero')).toMatchObject({
			targetLufs: -16,
			gainDb: 4,
			limitedBy: 'loudness',
			levelClass: 'hero',
		});
		expect(at('support')).toMatchObject({ targetLufs: -22, gainDb: -2, limitedBy: 'loudness' });
		expect(at('layer')).toMatchObject({ targetLufs: -24, gainDb: -4, limitedBy: 'loudness' });
		// a bed type follows the ambience target whatever its role
		expect(at('hero', ['ambience'])).toMatchObject({ targetLufs: -30, gainDb: -10, levelClass: 'ambience' });
		expect(at('support', ['roomtone', 'hit'])).toMatchObject({ targetLufs: -30, levelClass: 'ambience' });
	});

	it('targets follow the delivery (relative to its integrated target)', () => {
		for (const delivery of SOUND_DELIVERIES) {
			const l = defaultSfxLevel({ role: 'support', maxMomentaryLufs: -40, truePeakDb: -60, delivery });
			expect(l.targetLufs).toBe(DELIVERY_INTEGRATED_LUFS[delivery] - 8);
		}
		expect(
			defaultSfxLevel({ role: 'hero', maxMomentaryLufs: -20, delivery: 'broadcast-r128' }).targetLufs,
		).toBe(-25);
		// unknown delivery (hostile settings) → web
		expect(
			defaultSfxLevel({ role: 'hero', maxMomentaryLufs: -20, delivery: 'mars' as never }).targetLufs,
		).toBe(-16);
	});

	it('the true-peak ceiling of the role caps the gain; without a measured peak it never boosts', () => {
		// −30 LUFS hit with peaks at −3 dBTP (a sharp transient): +14 dB would put it at +11 dBTP
		expect(defaultSfxLevel({ role: 'hero', maxMomentaryLufs: -30, truePeakDb: -3 })).toMatchObject({
			gainDb: -3,
			limitedBy: 'peak',
			ceilingDbtp: -6,
		});
		expect(defaultSfxLevel({ role: 'layer', maxMomentaryLufs: -30, truePeakDb: -3 }).gainDb).toBe(-13);
		expect(defaultSfxLevel({ role: 'hero', maxMomentaryLufs: -30 })).toMatchObject({
			gainDb: 0,
			limitedBy: 'peak',
		});
		expect(defaultSfxLevel({ role: 'hero', maxMomentaryLufs: -10 })).toMatchObject({
			gainDb: -6,
			limitedBy: 'loudness',
		});
	});

	it('unmeasured sounds stay at 0 dB unless their peak is above the ceiling; the range is −30…+12 dB', () => {
		expect(defaultSfxLevel({ role: 'support', maxMomentaryLufs: null })).toMatchObject({
			gainDb: 0,
			limitedBy: 'unmeasured',
		});
		expect(defaultSfxLevel({ role: 'support', maxMomentaryLufs: null, truePeakDb: -2 })).toMatchObject({
			gainDb: -10,
			limitedBy: 'peak',
		});
		expect(defaultSfxLevel({ role: 'layer', maxMomentaryLufs: 10, truePeakDb: 12 })).toMatchObject({
			gainDb: SFX_DEFAULT_GAIN_MIN_DB,
			limitedBy: 'range',
		});
		expect(defaultSfxLevel({ role: 'hero', maxMomentaryLufs: -70, truePeakDb: -60 })).toMatchObject({
			gainDb: SFX_DEFAULT_GAIN_MAX_DB,
			limitedBy: 'range',
		});
	});

	it('property: any descriptors give a finite gain in range, at or under the target and the ceiling', () => {
		const anyNum = fc.oneof(
			fc.double({ noNaN: false }),
			fc.constantFrom(null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1e308, 400, -400),
		);
		fc.assert(
			fc.property(
				fc.constantFrom(...SFX_ROLES),
				fc.array(fc.constantFrom('hit', 'ambience', 'whoosh', 'roomtone', 3, null), { maxLength: 3 }),
				anyNum,
				anyNum,
				fc.constantFrom(...SOUND_DELIVERIES, undefined, null),
				(role, types, loud, peak, delivery) => {
					const l = defaultSfxLevel({
						role,
						types,
						maxMomentaryLufs: loud as number | null,
						truePeakDb: peak as number | null,
						delivery,
					});
					expect(Number.isFinite(l.gainDb)).toBe(true);
					expect(l.gainDb).toBeGreaterThanOrEqual(SFX_DEFAULT_GAIN_MIN_DB);
					expect(l.gainDb).toBeLessThanOrEqual(SFX_DEFAULT_GAIN_MAX_DB);
					const okLoud = typeof loud === 'number' && Number.isFinite(loud) && Math.abs(loud) <= 200;
					const okPeak = typeof peak === 'number' && Number.isFinite(peak) && Math.abs(peak) <= 200;
					if (l.limitedBy === 'range') return;
					if (okLoud) expect(loud + l.gainDb).toBeLessThanOrEqual(l.targetLufs + 0.05);
					if (okPeak) expect(peak + l.gainDb).toBeLessThanOrEqual(SFX_PEAK_CEILING_DBTP[l.levelClass] + 0.05);
					else expect(l.gainDb).toBeLessThanOrEqual(0);
				},
			),
			{ numRuns: 2000 },
		);
	});
});

let n = 0;
function libMedia(
	h: Harness,
	d: Partial<NonNullable<LibraryProvenance['descriptors']>> & { types?: string[] } = {},
) {
	const soundId = `snd_${(++n).toString(16).padStart(16, '0')}`;
	const { types, ...desc } = d;
	const library: LibraryProvenance = {
		...LIB,
		soundId,
		title: `Sound ${n}`,
		types: types ?? ['hit'],
		descriptors: {
			...LIB.descriptors!,
			peakSec: 0.0705,
			onsetSec: 0.06,
			headQuietSec: 0.05,
			durationSec: 0.55,
			...desc,
		} as LibraryProvenance['descriptors'],
		leadSilenceSec: 0.05,
	};
	const r = h.ok([
		{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: 0.55 }), library } },
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}
const clipOf = (h: Harness, id: string) => h.seq.clips[id] as SfxClip;

describe('soundDesign.place default level', () => {
	it('three layers of a hero cue get hero / layer / layer levels from their descriptors; recorded; undo / redo', () => {
		const h = new Harness();
		const a = libMedia(h, { maxMomentaryLufs: -10, truePeakDb: -1 });
		const b = libMedia(h, { maxMomentaryLufs: -30, truePeakDb: -20 });
		const c = libMedia(h, { maxMomentaryLufs: -30, truePeakDb: -12 });
		const cue = (
			h.ok([{ type: 'soundCue.add', cues: [{ frame: 90, kind: 'land', weight: 'hero', source: 'user' }] }])
				.results[0] as { cueIds: string[] }
		).cueIds[0]!;
		const before = h.doc;
		const snapshot = clone(before);
		const r = h.ok([
			{ type: 'soundDesign.place', cueId: cue, layers: [{ mediaId: a }, { mediaId: b }, { mediaId: c }] },
		]);
		const res = r.results[0] as {
			clips: { clipId: string; role: string; gainDb: number; level: ClipSfx['level'] | null }[];
		};
		expect(res.clips.map((x) => [x.role, x.gainDb])).toEqual([
			['hero', -6], // loudness −16 − (−10) = −6, under its −6 dBTP ceiling (peak −1 → −7 dBTP)
			['layer', 4], // −24 − (−30) = +6, capped by the layer ceiling −16 dBTP − (−20) = +4
			['layer', -4], // +6 capped at −16 − (−12) = −4
		]);
		expect(res.clips.map((x) => x.level!.limitedBy)).toEqual(['loudness', 'peak', 'peak']);
		for (const x of res.clips) {
			const cl = clipOf(h, x.clipId);
			expect(cl.gainDb).toBe(x.gainDb);
			expect(cl.sfx!.level).toEqual(x.level);
			expect(cl.sfx!.level!.by).toBe('default');
		}
		expect(checkInvariants(h.doc)).toEqual([]);
		// undo = the untouched document (the transaction is immutable); redo = the same levels
		expect(before).toEqual(snapshot);
		const after = h.doc;
		h.doc = before;
		const again = h.ok([
			{ type: 'soundDesign.place', cueId: cue, layers: [{ mediaId: a }, { mediaId: b }, { mediaId: c }] },
		]).results[0] as { clips: { clipId: string }[] };
		expect(again.clips.map((x) => clipOf(h, x.clipId).gainDb)).toEqual([-6, 4, -4]);
		expect(Object.keys(after.sequences)).toEqual(Object.keys(h.doc.sequences));
	});

	it('an explicit gainDb wins (no level recorded); gainOffsetDb is added to the default', () => {
		const h = new Harness();
		const m = libMedia(h, { maxMomentaryLufs: -20, truePeakDb: -10 });
		const r = h.ok([
			{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m, gainDb: 3, gainOffsetDb: 1 }] },
			{ type: 'soundDesign.place', frame: 80, layers: [{ mediaId: m, gainOffsetDb: -0.7 }] },
			{ type: 'soundDesign.place', frame: 120, layers: [{ mediaId: m, gainDb: 0 }] },
		]);
		const ids = r.results.map((x) => (x as { clips: { clipId: string }[] }).clips[0]!.clipId);
		expect(clipOf(h, ids[0]!).gainDb).toBe(3);
		expect(clipOf(h, ids[0]!).sfx!.level).toBeUndefined();
		// support: −22 − (−20) = −2, then −0.7
		expect(clipOf(h, ids[1]!).gainDb).toBe(-2.7);
		expect(clipOf(h, ids[1]!).sfx!.level).toEqual({
			by: 'default',
			gainDb: -2.7,
			offsetDb: -0.7,
			targetLufs: -22,
			limitedBy: 'loudness',
		});
		expect(clipOf(h, ids[2]!).gainDb).toBe(0);
		expect(clipOf(h, ids[2]!).sfx!.level).toBeUndefined();
	});

	it('the sequence delivery sets the targets; media without loudness descriptors stay at 0 dB', () => {
		const h = new Harness();
		h.ok([{ type: 'soundDesign.setSettings', delivery: 'broadcast-r128' }]);
		const m = libMedia(h, { maxMomentaryLufs: -20, truePeakDb: -10 });
		const silent = libMedia(h, { maxMomentaryLufs: null });
		const r = h.ok([
			{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] },
			{ type: 'soundDesign.place', frame: 90, layers: [{ mediaId: silent }] },
		]);
		const [x, y] = r.results.map((q) => clipOf(h, (q as { clips: { clipId: string }[] }).clips[0]!.clipId));
		expect(x!.gainDb).toBe(-11); // −31 − (−20)
		const lx = x!.sfx!.level!;
		expect(lx.by === 'default' ? lx.targetLufs : null).toBe(-31);
		expect(y!.gainDb).toBe(0);
		expect(y!.sfx!.level!.limitedBy).toBe('unmeasured');
	});

	it('swap and setRole refresh an untouched default (keeping the offset); a gain set since is kept', () => {
		const h = new Harness();
		const quiet = libMedia(h, { maxMomentaryLufs: -30, truePeakDb: -20 });
		const loud = libMedia(h, { maxMomentaryLufs: -12, truePeakDb: -2 });
		const r = h.ok([
			{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: quiet, gainOffsetDb: 0.5 }] },
			{ type: 'soundDesign.place', frame: 120, layers: [{ mediaId: quiet }] },
		]);
		const [a, b] = r.results.map((q) => (q as { clips: { clipId: string }[] }).clips[0]!.clipId);
		// support: −22 + 30 = +8, capped by −12 dBTP − (−20) = +8 → +8.5 with the offset
		expect(clipOf(h, a!).gainDb).toBe(8.5);
		h.ok([{ type: 'soundDesign.swap', clipId: a!, mediaId: loud }]);
		// −22 + 12 = −10 (peak −2 → −12 dBTP: exactly the ceiling), + 0.5
		expect(clipOf(h, a!).gainDb).toBe(-9.5);
		expect(clipOf(h, a!).sfx!.level).toMatchObject({ gainDb: -9.5, offsetDb: 0.5, limitedBy: 'loudness' });
		h.ok([{ type: 'soundDesign.setRole', clipIds: [a!], role: 'hero' }]);
		// hero: −16 + 12 = −4, capped at −6 − (−2) = −4 → −3.5
		expect(clipOf(h, a!).gainDb).toBe(-3.5);
		// the user moves b's gain: swaps and role changes keep it
		h.ok([{ type: 'audio.setGain', clipIds: [b!], mode: 'set', db: 2 }]);
		h.ok([{ type: 'soundDesign.swap', clipId: b!, mediaId: loud }]);
		h.ok([{ type: 'soundDesign.setRole', clipIds: [b!], role: 'layer' }]);
		expect(clipOf(h, b!).gainDb).toBe(2);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refuses an offset out of range; a bad stored level is dropped on load (the gain kept), idempotently', () => {
		const h = new Harness();
		const m = libMedia(h, { maxMomentaryLufs: -20, truePeakDb: -10 });
		const bad = h.tx([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m, gainOffsetDb: 40 }] }]);
		expect(bad.ok).toBe(false);
		const r = h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] }]);
		const id = (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		const raw = clone(h.doc);
		const sfx = (raw.sequences[h.seqId]!.clips[id] as unknown as { sfx: Record<string, unknown> }).sfx;
		sfx.level = { by: 'default', gainDb: 'loud', targetLufs: -22, limitedBy: 'loudness' };
		expect(checkInvariants(raw).some((i) => i.invariant === 'INV-SFX')).toBe(true);
		const loaded = loadProject(raw, { ids: createCounterIdSource(900) });
		expect(loaded.issues).toEqual([]);
		const out = loaded.document.sequences[h.seqId]!.clips[id] as SfxClip;
		expect(out.sfx!.level).toBeUndefined();
		expect(out.gainDb).toBe(-2);
		expect(loaded.repairs.map((x) => x.action)).toContain('repair-sfx');
		expect(repairDocument(loaded.document, createCounterIdSource(5000)).report).toEqual([]);
	});
});
