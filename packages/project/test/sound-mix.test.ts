// Sound design mixing commands (spec 12 §2.4 / §2.9, P4-R3 / P4-R4; wp-note "Phase 4 → WP4.2a"): `audio.volumeDip`
// (minimum merge, keys outside the dips never replaced; property), `soundDesign.applyStopBefore` (track lane or clip
// fallback; exact removal; follows the cue), `soundDesign.applyBuild` (one High Pass per music track, reused; removal),
// `soundDesign.ensureBus` / `removeBus` (room glue rules, idempotence, placement adds sends), `soundDesign.applyDelivery`
// (settings, loudness, Auto-Match by type, ducking with re-dips, default levels), undo / redo and refusals, repair.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	type AudioClip,
	BUILD_FILTER_EFFECT_ID,
	checkInvariants,
	clipLaneTime,
	DELIVERY_PRESETS,
	type Dip,
	dipEnvelopeAt,
	evaluate,
	FLICKS_PER_SECOND,
	type Keyframe,
	type LibraryProvenance,
	loadProject,
	mergeDips,
	ROOM_REVERB_EFFECT_ID,
	readSoundDesign,
	repairDocument,
	type SoundDesign,
	sfxGainOwner,
	unwriteCurve,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const F30 = 705_600_000 / 30;
const S = FLICKS_PER_SECOND;
const MS = S / 1000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Clip = AudioClip & { sfx?: unknown };

function addAudio(h: Harness, at: number, track: string, type: string | null, seconds = 20) {
	const m = h.registerVideo({ kind: 'audio', seconds });
	const r = h.ok([{ type: 'clip.place', source: { mediaId: m }, at, tracks: { audio: track } }]);
	const id = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
	if (type) h.ok([{ type: 'essentialSound.setType', clipIds: [id], audioType: type }]);
	return id;
}
const clipOf = (h: Harness, id: string) => h.seq.clips[id] as Clip;
const track = (h: Harness, label: string) => h.seq.audioTracks[Number(label.slice(1)) - 1]!;
const trackVol = (h: Harness, label: string, t: number) => {
	const v = track(h, label).volumeDb;
	return v ? evaluate(v as Animatable<number>, t) : 0;
};
const clipVol = (h: Harness, id: string, seqFlicks: number) => {
	const c = clipOf(h, id);
	return evaluate(c.volumeDb as Animatable<number>, clipLaneTime(c, h.seq.settings.frameRate).toLane(seqFlicks));
};
/** A document with fresh-id differences removed (keys and records written again get new ids). */
const noIds = (x: unknown) => JSON.parse(JSON.stringify(x).replace(/"(kf|snd|fx|trk)_[0-9A-Za-z]+"/g, '"$1"'));
const sd = (h: Harness) => h.seq.soundDesign as SoundDesign | undefined;

let n = 0;
function libMedia(h: Harness, types: string[]) {
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

function heroCue(h: Harness, frame: number, extra: Record<string, unknown> = {}) {
	const r = h.ok([
		{
			type: 'soundCue.add',
			cues: [{ frame, kind: 'land', weight: 'hero', source: 'user', ...extra }],
		},
	]);
	return (r.results[0] as { cueIds: string[] }).cueIds[0]!;
}

describe('audio.volumeDip', () => {
	it('dips a static clip relative to its level, only inside the dip; undo / redo; refusals', () => {
		const h = new Harness();
		const music = addAudio(h, 0, 'A1', 'music');
		h.ok([{ type: 'param.set', target: ['clip', music, 'volumeDb'], value: -3 }]);
		const dip = { start: 2 * S, end: 2.5 * S, depthDb: -24, fadeMs: 30 };
		const before = h.doc;
		const snap = clone(before);
		const r = h.ok([{ type: 'audio.volumeDip', clipIds: [music], dips: [dip] }]);
		expect((r.results[0] as { clips: Record<string, { written: number }> }).clips[music]!.written).toBe(4);
		expect(clipVol(h, music, 1 * S)).toBe(-3);
		expect(clipVol(h, music, 2 * S - 30 * MS)).toBeCloseTo(-3, 6);
		expect(clipVol(h, music, 2 * S - 15 * MS)).toBeCloseTo(-15, 6);
		expect(clipVol(h, music, 2.2 * S)).toBeCloseTo(-27, 6);
		expect(clipVol(h, music, 2.5 * S + 30 * MS)).toBeCloseTo(-3, 6);
		expect(clipVol(h, music, 5 * S)).toBe(-3);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snap);
		const after = clone(h.doc.sequences);
		h.doc = before;
		h.ok([{ type: 'audio.volumeDip', clipIds: [music], dips: [dip] }]);
		expect(noIds(h.doc.sequences)).toEqual(noIds(after));
		// outside the clip: skipped
		const r2 = h.ok([
			{ type: 'audio.volumeDip', clipIds: [music], dips: [{ start: 60 * S, end: 61 * S, depthDb: -6, fadeMs: 0 }] },
		]);
		expect((r2.results[0] as { clips: Record<string, unknown> }).clips[music]).toEqual({
			skipped: 'no dip in the clip',
		});
		// refusals
		const v = h.registerVideo({ seconds: 5, audio: false });
		const vr = h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 0, tracks: { video: 'V1' } }]);
		const vid = (vr.results[0] as { clipIds: string[] }).clipIds[0]!;
		expect(h.tx([{ type: 'audio.volumeDip', clipIds: [vid], dips: [dip] }]).errors?.[0]?.code).toBe(
			'E_INVALID_PARAM',
		);
		expect(h.tx([{ type: 'audio.volumeDip', clipIds: ['clp_nope'], dips: [dip] }]).errors?.[0]?.code).toBe(
			'E_NOT_FOUND',
		);
		expect(
			h.tx([{ type: 'audio.volumeDip', clipIds: [music], dips: [{ ...dip, depthDb: 3 }] }]).errors?.[0]?.code,
		).toBe('E_SCHEMA');
		expect(
			h.tx([{ type: 'audio.volumeDip', clipIds: [music], dips: [{ ...dip, end: 1 }] }]).errors?.[0]?.code,
		).toBe('E_SCHEMA');
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: true } }]);
		expect(h.tx([{ type: 'audio.volumeDip', clipIds: [music], dips: [dip] }]).errors?.[0]?.code).toBe(
			'E_TRACK_LOCKED',
		);
	});

	it('merges with ducking by the minimum: a ducked span is not ducked twice', () => {
		const h = new Harness();
		const music = addAudio(h, 0, 'A1', 'music');
		// duck −15 dB from 1 s to 4 s (800 ms ramps)
		h.ok([
			{ type: 'audio.autoDuck', targetClipIds: [music], regions: [[1.8 * S, 4 * S]], amountDb: 15, fadeMs: 800 },
		]);
		const ducked = clone(clipOf(h, music).volumeDb);
		h.ok([
			{ type: 'audio.volumeDip', clipIds: [music], dips: [{ start: 2.5 * S, end: 3 * S, depthDb: -24, fadeMs: 30 }] },
		]);
		// inside the duck the window edges are at −15: the dip floor is −39
		expect(clipVol(h, music, 2.7 * S)).toBeCloseTo(-39, 6);
		// outside the dip the ducked curve is unchanged
		for (const t of [0.5, 1, 1.5, 2, 2.4, 3.2, 4, 4.5, 6])
			expect(clipVol(h, music, t * S)).toBeCloseTo(evaluate(ducked as Animatable<number>, t * S), 9);
	});

	it('reversed and varispeed clips: the dip lands on its sequence time', () => {
		const h = new Harness();
		const music = addAudio(h, 30, 'A1', 'music', 20);
		h.ok([{ type: 'clip.setSpeed', clipIds: [music], rate: 2, reverse: true, ripple: false }]);
		h.ok([
			{ type: 'audio.volumeDip', clipIds: [music], dips: [{ start: 3 * S, end: 3.5 * S, depthDb: -12, fadeMs: 0 }] },
		]);
		expect(clipVol(h, music, 3.2 * S)).toBeCloseTo(-12, 6);
		expect(clipVol(h, music, 2.5 * S)).toBeCloseTo(0, 6);
		expect(clipVol(h, music, 4 * S)).toBeCloseTo(0, 6);
	});
});

describe('mergeDips (property)', () => {
	const keyArb = fc.record({
		t: fc.integer({ min: 0, max: 40 }),
		v: fc.double({ min: -40, max: 10, noNaN: true }),
		hold: fc.boolean(),
	});
	const dipArb = fc
		.record({
			s: fc.integer({ min: 0, max: 380 }),
			len: fc.integer({ min: 0, max: 60 }),
			depth: fc.double({ min: -60, max: 0, noNaN: true }),
			fade: fc.integer({ min: 0, max: 400 }),
		})
		.map((d) => ({ start: d.s * 10 * MS, end: (d.s + d.len) * 10 * MS, depthDb: d.depth, fadeMs: d.fade }));
	it('result = min(existing, dip) inside the windows, identical outside, keys outside kept; unwrite restores', () => {
		fc.assert(
			fc.property(
				fc.array(keyArb, { maxLength: 8 }),
				fc.double({ min: -20, max: 6, noNaN: true }),
				fc.array(dipArb, { minLength: 1, maxLength: 3 }),
				(keys, value, dips: Dip[]) => {
					const seen = new Set<number>();
					const kfs: Keyframe<number>[] = [];
					for (const k of keys) {
						const time = k.t * 100 * MS;
						if (seen.has(time)) continue;
						seen.add(time);
						kfs.push({
							id: `kf_${kfs.length}`,
							time,
							value: k.v,
							interpolation: k.hold ? 'hold' : 'linear',
							easeIn: { influence: 1, slope: 1 },
							easeOut: { influence: 1, slope: 1 },
						});
					}
					kfs.sort((a, b) => a.time - b.time);
					const anim: Animatable<number> = { value, keyframes: kfs };
					const lane = { toLane: (t: number) => t, toSeq: (t: number) => t, span: [0, Infinity] as [number, number] };
					let i = 0;
					const r = mergeDips(anim, lane, dips, { newId: () => `new_${i++}`, clamp: [-96, 15] });
					if (!r) return;
					const res: Animatable<number> = { value, keyframes: r.keyframes };
					const inWin = (t: number) => r.windows.some(([a, b]) => t >= a && t <= b);
					for (let k = 0; k <= 400; k++) {
						const t = k * 11 * MS;
						const e = evaluate(anim, t);
						const got = evaluate(res, t);
						const d = Math.min(15, Math.max(-96, dipEnvelopeAt(dips, t)));
						expect(got).toBeLessThanOrEqual(e + 1e-4);
						if (!inWin(t)) expect(got).toBeCloseTo(e, 4);
						else {
							// ≤ the dip curve relative to the window's reference level, = the minimum of both
							const w = r.windows.find(([a, b]) => t >= a && t <= b)!;
							const ref = Math.max(evaluate(anim, w[0]), evaluate(anim, w[1]));
							const dd = Math.min(15, Math.max(-96, ref + dipEnvelopeAt(dips, t)));
							// a hold step between two samples is drawn as a 1-flick ramp: skip its instant
							const step = kfs.some((kf, j) => j > 0 && kfs[j - 1]!.interpolation === 'hold' && Math.abs(kf.time - t) <= 2);
							if (!step) expect(got).toBeCloseTo(Math.min(e, dd), 4);
							expect(got).toBeLessThanOrEqual(dd + 1e-4);
							void d;
						}
					}
					// keys outside the windows are untouched
					for (const k of kfs)
						if (!r.windows.some(([a, b]) => k.time >= Math.round(a) && k.time <= Math.round(b)))
							expect(r.keyframes).toContainEqual(k);
					// unwriting gives the original keys back
					const back = unwriteCurve(r.keyframes, r);
					expect(back.exact).toBe(true);
					expect(back.keyframes).toEqual(kfs);
				},
			),
			{ numRuns: 300 },
		);
	});
});
