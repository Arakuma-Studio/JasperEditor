// `soundDesign.applyGains` (spec 12 §2.4 / §2.9, P4-R2; wp-note "Phase 4 → WP4.1b"): solved gains on placed sounds,
// recorded as `sfx.level {by: 'solver'}` keeping the fill's variation offset; gain ownership (default → solver → user);
// `$ref` keys from a placement in the same transaction; a sound effect without `sfx` metadata; swap / role back to the
// default; immutability; every refusal; the stored level through load and repair; `isSfxClip` / `sfxSolverWeight`.
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	type ClipSfx,
	checkInvariants,
	createCounterIdSource,
	isSfxClip,
	type LibraryProvenance,
	loadProject,
	repairDocument,
	sfxGainOwner,
	sfxSolverWeight,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

type SfxClip = AudioClip & { sfx?: ClipSfx };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

let n = 0;
function libMedia(h: Harness, types: string[] = ['hit']) {
	const soundId = `snd_${(0xa000 + ++n).toString(16).padStart(16, '0')}`;
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

describe('soundDesign.applyGains', () => {
	it('sets solved gains, records the solver level with the variation offset; immutability', () => {
		const h = new Harness();
		const m = libMedia(h);
		const [a, b] = placed(
			h.ok([
				{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m, gainOffsetDb: 0.5 }] },
				{ type: 'soundDesign.place', frame: 120, layers: [{ mediaId: m }] },
			]),
		);
		// support default: −22 − (−20) = −2 (+0.5)
		expect(clipOf(h, a!).gainDb).toBe(-1.5);
		expect(sfxGainOwner(clipOf(h, a!))).toBe('default');
		const before = h.doc;
		const snapshot = clone(before);
		const apply = {
			type: 'soundDesign.applyGains',
			gains: { [a!]: -6.004, [b!]: 3.2 },
			report: {
				[a!]: {
					targetLiftDb: 3.5,
					achievedLiftDb: 1.234,
					limitedBy: ['dialogue', 'dialogue'],
					reason: '−6 dB, limited by dialogue A1',
				},
			},
		};
		const r = h.ok([apply], { label: 'Rebalance SFX Levels' });
		expect(r.results[0]).toEqual({
			clips: [
				{ clipId: a, fromDb: -1.5, gainDb: -6 },
				{ clipId: b, fromDb: -2, gainDb: 3.2 },
			],
		});
		expect(clipOf(h, a!).gainDb).toBe(-6);
		expect(clipOf(h, a!).sfx!.level).toEqual({
			by: 'solver',
			gainDb: -6,
			offsetDb: 0.5,
			targetLiftDb: 3.5,
			achievedLiftDb: 1.23,
			limitedBy: ['dialogue'],
			reason: '−6 dB, limited by dialogue A1',
		});
		expect(clipOf(h, b!).sfx!.level).toEqual({ by: 'solver', gainDb: 3.2, limitedBy: [] });
		expect(sfxGainOwner(clipOf(h, a!))).toBe('solver');
		expect(checkInvariants(h.doc)).toEqual([]);
		// The previous document stays unchanged.
		expect(before).toEqual(snapshot);
		// a gain the user sets since is theirs
		h.ok([{ type: 'audio.setGain', clipIds: [a!], mode: 'set', db: 1 }]);
		expect(sfxGainOwner(clipOf(h, a!))).toBe('user');
	});

	it('takes $refs bound by a placement in the same transaction (the plan job’s place items)', () => {
		const h = new Harness();
		const m = libMedia(h);
		const r = h.ok([
			{
				type: 'soundDesign.place',
				frame: 60,
				layers: [
					{ mediaId: m, ref: '$sfx_001_0' },
					{ mediaId: m, ref: '$sfx_001_1' },
				],
			},
			{ type: 'soundDesign.applyGains', gains: { $sfx_001_0: -4, $sfx_001_1: -12.5 } },
		]);
		const [a, b] = placed(r);
		expect([clipOf(h, a!).gainDb, clipOf(h, b!).gainDb]).toEqual([-4, -12.5]);
		expect(clipOf(h, b!).sfx!.level!.by).toBe('solver');
	});

	it('a sound effect without sfx metadata (Essential Sound SFX) only gets the gain', () => {
		const h = new Harness();
		const mid = (
			h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio', seconds: 2 }) }]).results[0] as {
				mediaId: string;
			}
		).mediaId;
		const cid = (
			h.ok([{ type: 'clip.place', source: { mediaId: mid }, at: 0, tracks: { audio: 'A1' }, ref: '$c' }])
				.refs as Record<string, string>
		).$c!;
		// untyped plain audio is bed, not an effect
		expect(isSfxClip(clipOf(h, cid))).toBe(false);
		expect(h.tx([{ type: 'soundDesign.applyGains', gains: { [cid]: -3 } }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM' }],
		});
		h.ok([{ type: 'essentialSound.setType', clipIds: [cid], audioType: 'sfx' }]);
		expect(isSfxClip(clipOf(h, cid))).toBe(true);
		h.ok([{ type: 'soundDesign.applyGains', gains: { [cid]: -3 } }]);
		expect(clipOf(h, cid).gainDb).toBe(-3);
		expect(clipOf(h, cid).sfx).toBeUndefined();
		// typed dialogue: bed even with a detected peak (sfx metadata)
		h.ok([
			{ type: 'essentialSound.setType', clipIds: [cid], audioType: 'dialogue' },
			{ type: 'soundDesign.setPeak', clipId: cid, peakFlicks: 0 },
		]);
		expect(clipOf(h, cid).sfx).toBeDefined();
		expect(isSfxClip(clipOf(h, cid))).toBe(false);
	});

	it('a swap or a role change returns an untouched solved gain to the default level (offset kept)', () => {
		const h = new Harness();
		const m = libMedia(h);
		const other = libMedia(h);
		const [a] = placed(
			h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m, gainOffsetDb: -1 }] }]),
		);
		h.ok([{ type: 'soundDesign.applyGains', gains: { [a!]: 5 } }]);
		h.ok([{ type: 'soundDesign.setRole', clipIds: [a!], role: 'hero' }]);
		// hero: −16 − (−20) = +4, capped by −6 − (−10) = +4; −1 offset
		expect(clipOf(h, a!).gainDb).toBe(3);
		expect(clipOf(h, a!).sfx!.level).toMatchObject({ by: 'default', offsetDb: -1 });
		h.ok([{ type: 'soundDesign.applyGains', gains: { [a!]: 7 } }]);
		h.ok([{ type: 'soundDesign.swap', clipId: a!, mediaId: other }]);
		expect(clipOf(h, a!).sfx!.level).toMatchObject({ by: 'default', gainDb: 3, offsetDb: -1 });
	});

	it('refuses unknown clips and refs, non-effects, report keys without a gain, locked tracks, out of range', () => {
		const h = new Harness();
		const m = libMedia(h);
		const [a] = placed(h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] }]));
		const v = h.registerVideo({ audio: false });
		const vid = (
			h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 200, tracks: { video: 'V1' }, ref: '$v' }])
				.refs as Record<string, string>
		).$v!;
		const before = clone(h.doc);
		const code = (cmd: Record<string, unknown>) => {
			const r = h.tx([{ type: 'soundDesign.applyGains', ...cmd }]);
			expect(r.ok).toBe(false);
			return r.ok ? null : r.errors[0]!.code;
		};
		expect(code({ gains: { clp_00000000000nope: -3 } })).toBe('E_NOT_FOUND');
		expect(code({ gains: { $nothing: -3 } })).toBe('E_NOT_FOUND');
		expect(code({ sequenceId: 'seq_000000000000none', gains: { [a!]: -3 } })).toBe('E_NOT_FOUND');
		expect(code({ gains: { [vid]: -3 } })).toBe('E_INVALID_PARAM');
		expect(code({ gains: { [a!]: -3 }, report: { [vid]: { reason: 'x' } } })).toBe('E_INVALID_PARAM');
		expect(code({ gains: { [a!]: -31 } })).toBe('E_SCHEMA');
		expect(code({ gains: { [a!]: 12.5 } })).toBe('E_SCHEMA');
		expect(code({ gains: {} })).toBe('E_SCHEMA');
		expect(code({ gains: { [a!]: -3 }, report: { [a!]: { limitedBy: ['x'], bogus: 1 } } })).toBe('E_SCHEMA');
		expect(code({ gains: { 'not an id!': -3 } })).toBe('E_SCHEMA');
		// a ref is per transaction: one bound in an earlier transaction is unknown
		const dup = h.tx([
			{ type: 'soundDesign.place', frame: 300, layers: [{ mediaId: m, ref: '$x' }] },
			{ type: 'soundDesign.applyGains', gains: { $x: -3 } },
		]);
		expect(dup.ok).toBe(true);
		const x = placed(dup as { results: unknown[] })[0]!;
		expect(code({ gains: { [x]: -3, $x: 1 } })).toBe('E_NOT_FOUND');
		const track = clipOf(h, a!).trackId;
		h.ok([{ type: 'track.update', trackId: track, patch: { locked: true } }]);
		expect(code({ gains: { [a!]: -3 } })).toBe('E_TRACK_LOCKED');
		h.ok([{ type: 'track.update', trackId: track, patch: { locked: false } }]);
		expect(clipOf(h, a!).gainDb).toBe((before.sequences[h.seqId]!.clips[a!] as SfxClip).gainDb);
	});

	it('a solver level survives load; a damaged one is dropped (the gain kept), idempotently', () => {
		const h = new Harness();
		const m = libMedia(h);
		const [a] = placed(h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] }]));
		h.ok([
			{
				type: 'soundDesign.applyGains',
				gains: { [a!]: -7.5 },
				report: { [a!]: { limitedBy: ['bed-cap'], achievedLiftDb: null } },
			},
		]);
		const good = loadProject(clone(h.doc), { ids: createCounterIdSource(900) });
		expect(good.issues).toEqual([]);
		expect((good.document.sequences[h.seqId]!.clips[a!] as SfxClip).sfx!.level).toEqual({
			by: 'solver',
			gainDb: -7.5,
			achievedLiftDb: null,
			limitedBy: ['bed-cap'],
		});
		const raw = clone(h.doc);
		const sfx = (raw.sequences[h.seqId]!.clips[a!] as unknown as { sfx: Record<string, unknown> }).sfx;
		sfx.level = { by: 'solver', gainDb: -7.5, limitedBy: 'bed-cap' };
		expect(checkInvariants(raw).some((i) => i.invariant === 'INV-SFX')).toBe(true);
		const loaded = loadProject(raw, { ids: createCounterIdSource(901) });
		const out = loaded.document.sequences[h.seqId]!.clips[a!] as SfxClip;
		expect(out.sfx!.level).toBeUndefined();
		expect(out.gainDb).toBe(-7.5);
		expect(sfxGainOwner(out)).toBe('user');
		expect(repairDocument(loaded.document, createCounterIdSource(5000)).report).toEqual([]);
	});
});

describe('isSfxClip / sfxSolverWeight', () => {
	it('classifies by Essential Sound type, then sfx metadata', () => {
		const sfx = {
			cueId: null,
			soundId: null,
			layer: 0,
			role: 'support',
			placement: { align: 'peak', peakFlicks: 0, errorFlicks: 0 },
		};
		expect(isSfxClip({ kind: 'audio', sfx })).toBe(true);
		expect(isSfxClip({ kind: 'audio', essential: { type: 'sfx' } })).toBe(true);
		expect(isSfxClip({ kind: 'audio', essential: { type: 'music' }, sfx })).toBe(false);
		expect(isSfxClip({ kind: 'audio', essential: { type: 'ambience' }, sfx })).toBe(false);
		expect(isSfxClip({ kind: 'audio' })).toBe(false);
		expect(isSfxClip({ kind: 'audio', sfx: 'garbage' })).toBe(false);
		expect(isSfxClip({ kind: 'video', sfx })).toBe(false);
		expect(isSfxClip(null)).toBe(false);
		expect(sfxSolverWeight('hero', ['hit'])).toBe('hero');
		expect(sfxSolverWeight('layer', ['whoosh'])).toBe('support');
		expect(sfxSolverWeight('support', null)).toBe('support');
		expect(sfxSolverWeight('hero', ['roomtone'])).toBe('ambient');
		expect(sfxSolverWeight(null, ['ambience'])).toBe('ambient');
	});
});
