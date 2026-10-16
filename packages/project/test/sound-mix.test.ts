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
	createCounterIdSource,
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
	return evaluate(
		c.volumeDb as Animatable<number>,
		clipLaneTime(c, h.seq.settings.frameRate).toLane(seqFlicks),
	);
};
/** A document with fresh-id differences removed (keys and records written again get new ids). */
const noIds = (x: unknown) =>
	JSON.parse(JSON.stringify(x).replace(/"(kf|snd|fx|trk)_[0-9A-Za-z]+"/g, '"$1"'));
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
			{
				type: 'audio.volumeDip',
				clipIds: [music],
				dips: [{ start: 60 * S, end: 61 * S, depthDb: -6, fadeMs: 0 }],
			},
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
			{
				type: 'audio.autoDuck',
				targetClipIds: [music],
				regions: [[1.8 * S, 4 * S]],
				amountDb: 15,
				fadeMs: 800,
			},
		]);
		const ducked = clone(clipOf(h, music).volumeDb);
		h.ok([
			{
				type: 'audio.volumeDip',
				clipIds: [music],
				dips: [{ start: 2.5 * S, end: 3 * S, depthDb: -24, fadeMs: 30 }],
			},
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
			{
				type: 'audio.volumeDip',
				clipIds: [music],
				dips: [{ start: 3 * S, end: 3.5 * S, depthDb: -12, fadeMs: 0 }],
			},
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
					const lane = {
						toLane: (t: number) => t,
						toSeq: (t: number) => t,
						span: [0, Infinity] as [number, number],
					};
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
						expect(got).toBeLessThanOrEqual(e + 1e-3);
						if (!inWin(t)) expect(got).toBeCloseTo(e, 6);
						else {
							// ≤ the dip curve relative to the window's reference level, = the minimum of both
							const w = r.windows.find(([a, b]) => t >= a && t <= b)!;
							const ref = Math.max(evaluate(anim, w[0]), evaluate(anim, w[1]));
							const dd = Math.min(15, Math.max(-96, ref + dipEnvelopeAt(dips, t)));
							// a hold step between two samples is drawn as a 1-flick ramp: skip its instant
							const step = kfs.some(
								(kf, j) => j > 0 && kfs[j - 1]!.interpolation === 'hold' && Math.abs(kf.time - t) <= 2,
							);
							if (!step) expect(got).toBeCloseTo(Math.min(e, dd), 2);
							expect(got).toBeLessThanOrEqual(dd + 1e-3);
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
			{
				numRuns: 300,
				// counterexamples found while writing it: dips at the very start (the window clipped at 0), a −0 key
				examples: [
					[
						[],
						0,
						[
							{ start: 0, end: 0, depthDb: -0.00132183908045977, fadeMs: 230 },
							{ start: 162288000, end: 162288000, depthDb: -0.0008712121212121213, fadeMs: 211 },
						],
					],
					[
						[],
						0,
						[
							{ start: 0, end: 0, depthDb: -0.0005630071203813279, fadeMs: 400 },
							{ start: 0, end: 0, depthDb: -32.00937386398987, fadeMs: 34 },
						],
					],
					[[{ t: 0, v: -0, hold: false }], -0, [{ start: 0, end: 10 * MS, depthDb: -6, fadeMs: 10 }]],
				],
			},
		);
	});
});

describe('soundDesign.applyStopBefore', () => {
	it('dips the music track lane before the hero; idempotent; cleared → removed exactly; undo / redo', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const dialogue = addAudio(h, 0, 'A2', 'dialogue', 10);
		const cue = heroCue(h, 120, { stopBefore: { seconds: 0.25, depthDb: -24 } });
		const T = 120 * F30;
		const before = h.doc;
		const snap = clone(before);
		const r = h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }], { label: 'Stop Before Cue' });
		expect(r.results[0]).toMatchObject({ cueId: cue, applied: true, removed: 0 });
		expect((r.results[0] as { writes: { target: string; track: string }[] }).writes).toEqual([
			{ target: 'trackVolume', track: 'A1', keyframes: 4 },
		]);
		expect(trackVol(h, 'A1', T - 0.25 * S - 30 * MS)).toBeCloseTo(0, 6);
		expect(trackVol(h, 'A1', T - 0.25 * S)).toBeCloseTo(-24, 6);
		expect(trackVol(h, 'A1', T - 0.1 * S)).toBeCloseTo(-24, 6);
		expect(trackVol(h, 'A1', T - 10 * MS)).toBeCloseTo(-24, 6);
		expect(trackVol(h, 'A1', T + 5 * MS)).toBeCloseTo(-12, 6);
		expect(trackVol(h, 'A1', T + 20 * MS)).toBeCloseTo(0, 6);
		expect(trackVol(h, 'A1', 1 * S)).toBe(0);
		// the dialogue is untouched
		expect(clipOf(h, dialogue).volumeDb.keyframes).toEqual([]);
		expect(track(h, 'A2').volumeDb?.keyframes ?? []).toEqual([]);
		expect(sd(h)!.mix!.cues![cue]!.stopBefore!.writes[0]!.written).toHaveLength(4);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snap);
		// again: the previous dip comes out first — the same curve
		const once = clone(track(h, 'A1').volumeDb);
		const r2 = h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		expect(r2.results[0]).toMatchObject({ applied: true, removed: 1 });
		expect(noIds(track(h, 'A1').volumeDb)).toEqual(noIds(once));
		// redo of the first application
		const after = noIds(h.doc.sequences);
		const h2 = new Harness();
		h2.doc = before;
		void h2;
		// cleared on the cue → the dip is removed exactly (the lane as it was)
		h.ok([{ type: 'soundCue.update', cueId: cue, stopBefore: null }]);
		expect(track(h, 'A1').volumeDb ?? { value: 0, keyframes: [] }).toEqual(
			snap.sequences[h.seqId]!.audioTracks[0]!.volumeDb ?? { value: 0, keyframes: [] },
		);
		expect(sd(h)!.mix?.cues?.[cue]).toBeUndefined();
		void after;
	});

	it('keeps the lane automation outside the dip and gives back what it replaced', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const A1 = track(h, 'A1').id;
		// a recorded fader ride: −6 at 3 s → 0 at 5 s, with a key inside the dip window
		h.ok([
			{
				type: 'mixer.writeAutomation',
				stripId: 'A1',
				lane: 'volume',
				points: [
					[3 * S, -6],
					[3.9 * S, -4],
					[5 * S, 0],
				],
				thinning: { tolerance: 0 },
			},
		]);
		const ride = clone(track(h, 'A1').volumeDb!);
		const cue = heroCue(h, 120, { stopBefore: { seconds: 0.25, depthDb: -24 } });
		h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		const T = 4 * S;
		const E = (t: number) => evaluate(ride as Animatable<number>, t);
		for (const t of [2 * S, 3 * S, 3.5 * S, T - 0.3 * S, T + 0.05 * S, 4.5 * S, 5 * S, 6 * S])
			expect(trackVol(h, 'A1', t)).toBeCloseTo(E(t), 6);
		// on the floor: the local level (the larger edge value) − 24
		const ref = Math.max(E(T - 0.25 * S - 30 * MS), E(T + 20 * MS));
		expect(trackVol(h, 'A1', T - 0.1 * S)).toBeCloseTo(Math.min(E(T - 0.1 * S), ref - 24), 6);
		// keys outside the window are the same keys
		for (const k of ride.keyframes)
			if (Math.abs(k.time - T) > 0.4 * S) expect(track(h, 'A1').volumeDb!.keyframes).toContainEqual(k);
		h.ok([{ type: 'soundCue.update', cueId: cue, stopBefore: null }]);
		expect(h.seq.audioTracks.find((t) => t.id === A1)!.volumeDb).toEqual(ride);
	});

	it('falls back to clip dips when the music shares its track (or its lane is off); follows a moved cue; removed with the cue', () => {
		const h = new Harness();
		const music = addAudio(h, 0, 'A1', 'music');
		const sfx = addAudio(h, 600, 'A1', null, 2);
		void sfx;
		const cue = heroCue(h, 120, { stopBefore: { seconds: 0.5, depthDb: -18 } });
		// the clip on A1 after the music: A1 is still music-only at the cue → the track lane
		const r0 = h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		expect((r0.results[0] as { writes: { target: string }[] }).writes[0]!.target).toBe('trackVolume');
		// a dialogue clip on A1 under the cue: the music clip's Volume instead
		h.ok([{ type: 'soundCue.update', cueId: cue, stopBefore: null }]);
		const m2 = h.registerVideo({ kind: 'audio', seconds: 30 });
		const p = h.ok([{ type: 'clip.place', source: { mediaId: m2 }, at: 0, tracks: { audio: 'A3' } }]);
		const music2 = (p.results[0] as { clipIds: string[] }).clipIds[0]!;
		h.ok([{ type: 'essentialSound.setType', clipIds: [music2], audioType: 'music' }]);
		const dlg = addAudio(h, 100, 'A3', 'dialogue', 1);
		void dlg;
		void music;
		// A3: music2 (0…30 s) overlaps the dialogue? (clips cannot overlap on a track: music2 was cut by the dialogue)
		const a3 = h.clips('A3');
		expect(a3.length).toBeGreaterThanOrEqual(2);
		h.ok([{ type: 'soundCue.update', cueId: cue, stopBefore: { seconds: 0.5, depthDb: -18 } }]);
		const r = h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		const writes = (r.results[0] as { writes: { target: string; track: string }[] }).writes;
		expect(writes.find((w) => w.track === 'A1')!.target).toBe('trackVolume');
		expect(writes.filter((w) => w.track === 'A3').every((w) => w.target === 'clipVolume')).toBe(true);
		const T = 120 * F30;
		const musicOnA3 = a3.find((c) => c.start < 120 && c.start + c.duration > 105 && (c as Clip).essential)!;
		void musicOnA3;
		// moving the cue moves the dip
		h.ok([{ type: 'soundCue.update', cueId: cue, frame: 240 }]);
		expect(trackVol(h, 'A1', T - 0.3 * S)).toBeCloseTo(0, 6);
		expect(trackVol(h, 'A1', 240 * F30 - 0.3 * S)).toBeCloseTo(-18, 6);
		expect(sd(h)!.mix!.cues![cue]!.stopBefore!.frame).toBe(240);
		// muting takes it out, unmuting writes it again
		h.ok([{ type: 'soundCue.update', cueId: cue, muted: true }]);
		expect(trackVol(h, 'A1', 240 * F30 - 0.3 * S)).toBeCloseTo(0, 6);
		h.ok([{ type: 'soundCue.update', cueId: cue, muted: false }]);
		expect(trackVol(h, 'A1', 240 * F30 - 0.3 * S)).toBeCloseTo(0, 6); // a muted record is gone: apply again
		h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		expect(trackVol(h, 'A1', 240 * F30 - 0.3 * S)).toBeCloseTo(-18, 6);
		// deleting the cue removes its dip
		h.ok([{ type: 'soundCue.remove', cueIds: [cue] }]);
		expect(track(h, 'A1').volumeDb?.keyframes ?? []).toEqual([]);
		expect(sd(h)!.mix?.cues?.[cue]).toBeUndefined();
	});

	it('automation Off on the music track → clip dip; no music → not applied; ambience on request; refusals', () => {
		const h = new Harness();
		const music = addAudio(h, 0, 'A1', 'music');
		const amb = addAudio(h, 0, 'A2', 'ambience');
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A1', patch: { automation: 'off' } }]);
		const cue = heroCue(h, 90, { stopBefore: { seconds: 0.25, depthDb: -24 } });
		const r = h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		expect((r.results[0] as { writes: { target: string }[] }).writes).toEqual([
			{ target: 'clipVolume', track: 'A1', clipId: music, keyframes: 4 },
		]);
		expect(clipVol(h, music, 3 * S - 0.1 * S)).toBeCloseTo(-24, 6);
		expect(clipVol(h, amb, 3 * S - 0.1 * S)).toBe(0);
		const r2 = h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue, ambience: true }]);
		expect((r2.results[0] as { writes: unknown[] }).writes).toHaveLength(2);
		expect(trackVol(h, 'A2', 3 * S - 0.1 * S)).toBeCloseTo(-24, 6);
		// the ambience choice is remembered
		const r3 = h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		expect((r3.results[0] as { writes: unknown[] }).writes).toHaveLength(2);
		// no music under a cue
		const lone = heroCue(h, 30 * 30 + 60, { stopBefore: { seconds: 0.25, depthDb: -24 } });
		const r4 = h.ok([{ type: 'soundDesign.applyStopBefore', cueId: lone }]);
		expect(r4.results[0]).toMatchObject({ applied: false, reason: 'no music plays under the cue' });
		// a cue without stopBefore: nothing to do
		const plain = heroCue(h, 200);
		expect(h.ok([{ type: 'soundDesign.applyStopBefore', cueId: plain }]).results[0]).toMatchObject({
			applied: false,
			removed: 0,
			reason: 'the cue has no stop-before',
		});
		// refusals
		expect(
			h.tx([{ type: 'soundDesign.applyStopBefore', cueId: 'cue_0000000000000000' }]).errors?.[0]?.code,
		).toBe('E_NOT_FOUND');
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: true } }]);
		expect(h.tx([{ type: 'soundDesign.applyStopBefore', cueId: cue }]).errors?.[0]?.code).toBe(
			'E_TRACK_LOCKED',
		);
		expect(h.tx([{ type: 'soundDesign.applyStopBefore', cueId: cue, bogus: 1 }]).errors?.[0]?.code).toBe(
			'E_SCHEMA',
		);
	});
});

describe('soundDesign.applyBuild', () => {
	it('one High Pass per music track, reused; the cutoff sweeps and rests; removal takes the filter out', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const c1 = heroCue(h, 150, { build: { seconds: 2, fromHz: 150, toHz: 2000 } });
		const c2 = heroCue(h, 400, { build: { seconds: 1, fromHz: 200, toHz: 4000 } });
		const before = h.doc;
		const snap = clone(before);
		const r = h.ok([
			{ type: 'soundDesign.applyBuild', cueId: c1 },
			{ type: 'soundDesign.applyBuild', cueId: c2 },
		]);
		expect(r.results[0]).toMatchObject({ applied: true, writes: [{ target: 'trackFilter', track: 'A1' }] });
		const fxs = track(h, 'A1').effects ?? [];
		expect(fxs).toHaveLength(1);
		const fx = fxs[0]!;
		expect(fx.effectId).toBe(BUILD_FILTER_EFFECT_ID);
		expect(fx.params.mode!.value).toBe('highPass');
		expect(fx.params.type!.value).toBe('butterworth');
		expect(fx.params.order!.value).toBe(2);
		const cut = fx.params.cutoff as Animatable<number>;
		const T = 150 * F30;
		expect(evaluate(cut, 1 * S)).toBe(20);
		expect(evaluate(cut, T - 2 * S)).toBeCloseTo(150, 4);
		expect(evaluate(cut, T - F30)).toBeCloseTo(2000, 4);
		expect(evaluate(cut, T)).toBe(20);
		// exponential: half-way in time ≈ geometric mean
		expect(evaluate(cut, T - 2 * S + (2 * S - F30) / 2)).toBeCloseTo(Math.sqrt(150 * 2000), -1);
		expect(evaluate(cut, 400 * F30 - F30)).toBeCloseTo(4000, 4);
		expect(evaluate(cut, 8 * S)).toBe(20);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snap);
		// clearing one build keeps the filter for the other
		h.ok([{ type: 'soundCue.update', cueId: c1, build: null }]);
		expect(track(h, 'A1').effects).toHaveLength(1);
		expect(evaluate(track(h, 'A1').effects![0]!.params.cutoff as Animatable<number>, T - F30)).toBe(20);
		// the last one: the filter goes
		h.ok([{ type: 'soundCue.remove', cueIds: [c2] }]);
		expect(track(h, 'A1').effects ?? []).toEqual([]);
		expect(sd(h)!.mix?.buildFilters ?? {}).toEqual({});
	});

	it('music sharing its track gets a clip filter; no music → not applied; refusals', () => {
		const h = new Harness();
		const m = h.registerVideo({ kind: 'audio', seconds: 20 });
		const p = h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
		const music = (p.results[0] as { clipIds: string[] }).clipIds[0]!;
		h.ok([{ type: 'essentialSound.setType', clipIds: [music], audioType: 'music' }]);
		h.ok([{ type: 'clip.trim', clipId: music, edge: 'out', deltaFrames: 120 - 600 }]);
		addAudio(h, 120, 'A1', 'dialogue', 5);
		const cue = heroCue(h, 125, { build: { seconds: 2, fromHz: 150, toHz: 2000 } });
		const r = h.ok([{ type: 'soundDesign.applyBuild', cueId: cue }]);
		expect(r.results[0]).toMatchObject({ applied: true, writes: [{ target: 'clipFilter', clipId: music }] });
		const c = clipOf(h, music);
		const fx = c.effects.find((e) => e.effectId === BUILD_FILTER_EFFECT_ID)!;
		const lane = clipLaneTime(c, h.seq.settings.frameRate);
		expect(evaluate(fx.params.cutoff as Animatable<number>, lane.toLane(125 * F30 - 2 * S))).toBeCloseTo(
			150,
			3,
		);
		expect(track(h, 'A1').effects ?? []).toEqual([]);
		h.ok([{ type: 'soundCue.update', cueId: cue, build: null }]);
		expect(clipOf(h, music).effects.some((e) => e.effectId === BUILD_FILTER_EFFECT_ID)).toBe(false);
		const none = heroCue(h, 2000, { build: { seconds: 2, fromHz: 150, toHz: 2000 } });
		expect(h.ok([{ type: 'soundDesign.applyBuild', cueId: none }]).results[0]).toMatchObject({
			applied: false,
		});
		expect(h.tx([{ type: 'soundDesign.applyBuild', cueId: 'cue_0000000000000000' }]).errors?.[0]?.code).toBe(
			'E_NOT_FOUND',
		);
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: true } }]);
		h.ok([{ type: 'soundCue.update', cueId: cue, build: { seconds: 2, fromHz: 150, toHz: 2000 } }]);
		expect(h.tx([{ type: 'soundDesign.applyBuild', cueId: cue }]).errors?.[0]?.code).toBe('E_TRACK_LOCKED');
	});
});

describe('soundDesign.ensureBus / removeBus (room glue)', () => {
	function setup() {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'dialogue', 10);
		const hit = libMedia(h, ['hit']);
		const click = libMedia(h, ['click', 'ui']);
		const whoosh = libMedia(h, ['whoosh']);
		// A2 effects, A3 interface sounds only, A4 an effect next to music (mixed)
		h.ok([{ type: 'track.add', kind: 'audio', count: 3 }]);
		h.ok([
			{ type: 'soundDesign.place', frame: 60, layers: [{ mediaId: hit, track: 'A2' }] },
			{ type: 'soundDesign.place', frame: 120, layers: [{ mediaId: whoosh, track: 'A2' }] },
			{ type: 'soundDesign.place', frame: 60, layers: [{ mediaId: click, track: 'A3' }] },
			{ type: 'soundDesign.place', frame: 200, layers: [{ mediaId: hit, track: 'A4' }] },
		]);
		addAudio(h, 400, 'A4', 'music', 5);
		return { h, hit, click, whoosh };
	}

	it('adds the SFX Room submix with its reverb and −16 dB post-fader sends by the rules; idempotent; undo / redo', () => {
		const { h } = setup();
		const before = h.doc;
		const snap = clone(before);
		const r = h.ok([{ type: 'soundDesign.ensureBus' }], { label: 'SFX Room Glue' });
		const res = r.results[0] as {
			busId: string;
			label: string;
			created: boolean;
			sends: { track: string; added: boolean }[];
			skipped: { track: string; reason: string }[];
		};
		expect(res.created).toBe(true);
		expect(res.label).toBe('S1');
		expect(res.sends).toEqual([expect.objectContaining({ track: 'A2', added: true })]);
		expect(res.skipped.map((s) => s.track).sort()).toEqual(['A3', 'A4']);
		expect(res.skipped.find((s) => s.track === 'A3')!.reason).toMatch(/interface/);
		expect(res.skipped.find((s) => s.track === 'A4')!.reason).toMatch(/per track/);
		const bus = h.seq.submixTracks!.find((t) => t.id === res.busId)!;
		expect(bus.name).toBe('SFX Room');
		const rv = bus.effects!.find((e) => e.effectId === ROOM_REVERB_EFFECT_ID)!;
		expect([rv.params.decay!.value, rv.params.mix!.value, rv.params.preDelay!.value]).toEqual([0.6, 100, 8]);
		const send = track(h, 'A2').mixer!.sends![0]!;
		expect(send).toMatchObject({ target: bus.id });
		expect(send.levelDb.value).toBe(-16);
		expect(send.preFader).toBeUndefined();
		expect(track(h, 'A3').mixer?.sends ?? []).toEqual([]);
		expect(sd(h)!.settings!.roomBus).toBe(bus.id);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snap);
		// idempotent: nothing changes
		const once = clone(h.doc.sequences);
		const r2 = h.ok([{ type: 'soundDesign.ensureBus' }]);
		expect((r2.results[0] as { created: boolean; sends: { added: boolean }[] }).sends[0]!.added).toBe(false);
		expect(clone(h.doc.sequences)).toEqual(once);
		// new settings: the reverb and send levels follow
		h.ok([{ type: 'soundDesign.ensureBus', roomGlue: { sendDb: -12, decay: 1.2 } }]);
		expect(track(h, 'A2').mixer!.sends![0]!.levelDb.value).toBe(-12);
		expect(h.seq.submixTracks![0]!.effects![0]!.params.decay!.value).toBe(1.2);
		expect(sd(h)!.mix!.room).toMatchObject({ sendDb: -12, decay: 1.2, mix: 100, preDelayMs: 8 });
		// explicit tracks: A4 sends although it plays music too; A3 stays dry (interface only); A2's send goes
		const r3 = h.ok([{ type: 'soundDesign.ensureBus', sfxTracks: ['A3', 'A4'] }]);
		expect((r3.results[0] as { removed: string[] }).removed).toEqual([track(h, 'A2').id]);
		expect(track(h, 'A2').mixer!.sends ?? []).toEqual([]);
		expect(track(h, 'A4').mixer!.sends![0]!.levelDb.value).toBe(-12);
		// remove: sends and the bus it made go; settings.roomBus null
		h.ok([{ type: 'soundDesign.removeBus' }]);
		expect(h.seq.submixTracks ?? []).toEqual([]);
		expect(track(h, 'A4').mixer!.sends ?? []).toEqual([]);
		expect(sd(h)!.settings!.roomBus).toBeNull();
		expect(sd(h)!.mix?.room).toBeUndefined();
		// remove again: nothing to do
		expect(h.ok([{ type: 'soundDesign.removeBus' }]).results[0]).toEqual({
			busId: null,
			removedBus: false,
			removedSends: 0,
		});
	});

	it('placing a sound on a new SFX track adds its send; an adopted submix stays on removal; refusals', () => {
		const { h, whoosh, click } = setup();
		h.ok([{ type: 'mixer.addSubmix', name: 'SFX Room' }]);
		const adopted = h.seq.submixTracks![0]!.id;
		h.ok([{ type: 'soundDesign.ensureBus' }]);
		expect(sd(h)!.mix!.room!.busId).toBe(adopted);
		expect(sd(h)!.mix!.room!.createdBus).toBe(false);
		// a placement that creates a new SFX track
		const p = h.ok([{ type: 'soundDesign.place', frame: 60, layers: [{ mediaId: whoosh, track: 'auto' }] }]);
		const placed = (p.results[0] as { clips: { trackId: string; trackCreated: boolean }[] }).clips[0]!;
		const t = h.seq.audioTracks.find((x) => x.id === placed.trackId)!;
		expect(t.mixer?.sends?.[0]).toMatchObject({ target: adopted });
		expect(sd(h)!.mix!.room!.sends.map((s) => s.trackId)).toContain(t.id);
		// an interface sound alone on a new track: dry
		const p2 = h.ok([{ type: 'soundDesign.place', frame: 60, layers: [{ mediaId: click, track: 'auto' }] }]);
		const t2 = (p2.results[0] as { clips: { trackId: string }[] }).clips[0]!.trackId;
		expect(h.seq.audioTracks.find((x) => x.id === t2)!.mixer?.sends ?? []).toEqual([]);
		h.ok([{ type: 'soundDesign.removeBus' }]);
		expect(h.seq.submixTracks!.map((x) => x.id)).toEqual([adopted]);
		expect(h.seq.audioTracks.every((x) => (x.mixer?.sends ?? []).length === 0)).toBe(true);
		expect(h.tx([{ type: 'soundDesign.ensureBus', sfxTracks: ['A9'] }]).errors?.[0]?.code).toBe(
			'E_NOT_FOUND',
		);
		expect(h.tx([{ type: 'soundDesign.ensureBus', sfxTracks: ['V1'] }]).errors?.[0]?.code).toBe(
			'E_TRACK_KIND',
		);
		expect(h.tx([{ type: 'soundDesign.ensureBus', roomGlue: { decay: 99 } }]).errors?.[0]?.code).toBe(
			'E_SCHEMA',
		);
		expect(h.tx([{ type: 'soundDesign.ensureBus', sequenceId: 'seq_nope' }]).errors?.[0]?.code).toBe(
			'E_NOT_FOUND',
		);
	});
});

describe('soundDesign.applyDelivery', () => {
	it('sets the delivery, the Mix loudness, Auto-Match by type, ducking (re-dipping), default levels; undo / redo', () => {
		const h = new Harness();
		const dlg = addAudio(h, 0, 'A1', 'dialogue', 10);
		const music = addAudio(h, 0, 'A2', 'music', 20);
		const amb = addAudio(h, 0, 'A3', 'ambience', 20);
		const hitM = libMedia(h, ['hit']);
		h.ok([{ type: 'track.add', kind: 'audio', count: 1 }]);
		const pr = h.ok([{ type: 'soundDesign.place', frame: 300, layers: [{ mediaId: hitM, track: 'A4' }] }]);
		const hit = (pr.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		expect(clipOf(h, hit).gainDb).toBe(-2); // web support default: −22 − (−20)
		// a stop-before dip on the music, written on its clip (the lane is off)
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A2', patch: { automation: 'off' } }]);
		const cue = heroCue(h, 450, { stopBefore: { seconds: 0.25, depthDb: -24 } });
		h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		const before = h.doc;
		const snap = clone(before);
		const cmd = {
			type: 'soundDesign.applyDelivery',
			delivery: 'broadcast-r128',
			measuredLufs: { [dlg]: -20, [music]: -10, [amb]: -30, [hit]: -12 },
			ducking: [{ clipIds: [music, amb], regions: [[1 * S, 4 * S]] }],
			analysis: {
				integratedLufs: -21,
				truePeakDbtp: -3,
				lra: 5,
				mixHash: 'x',
				analyzedAt: '2026-10-16T00:00:00.000Z',
			},
		};
		const r = h.ok([cmd], { label: 'Apply Delivery Preset' });
		const res = r.results[0] as {
			matched: Record<string, { targetLufs?: number; gainDb?: number; skipped?: string }>;
			ducked: Record<string, number>;
			redipped: string[];
			levels: string[];
		};
		expect(sd(h)!.settings!.delivery).toBe('broadcast-r128');
		expect(h.seq.master.loudness).toMatchObject({
			enabled: true,
			targetLufs: -23,
			truePeakDb: -1,
			analysis: { integratedLufs: -21 },
		});
		expect(res.matched[dlg]).toMatchObject({ targetLufs: -23, gainDb: -3 });
		expect(res.matched[music]).toMatchObject({ targetLufs: -31, gainDb: -21 });
		expect(res.matched[amb]).toMatchObject({ targetLufs: -33, gainDb: -3 });
		expect(res.matched[hit]).toEqual({ skipped: 'sound effects are balanced by the masking solver' });
		expect(Object.keys(res.ducked).sort()).toEqual([music, amb].sort());
		// ducked by each clip's own amount (music −15, ambience −10), and the music's dip written again on the ducked curve
		expect(clipVol(h, music, 2.5 * S)).toBeCloseTo(-15, 6);
		expect(clipVol(h, amb, 2.5 * S)).toBeCloseTo(-10, 6);
		expect(res.redipped).toEqual([cue]);
		expect(clipVol(h, music, 15 * S - 0.1 * S)).toBeCloseTo(-24, 6);
		// the default-level sound follows the preset: R128 support −31 − (−20) = −11
		expect(res.levels).toEqual([hit]);
		expect(clipOf(h, hit).gainDb).toBe(-11);
		expect(sfxGainOwner(clipOf(h, hit))).toBe('default');
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snap);
		const after = noIds(h.doc.sequences);
		h.doc = before;
		h.ok([cmd]);
		expect(noIds(h.doc.sequences)).toEqual(after);
		// presets
		expect(DELIVERY_PRESETS['atsc-a85']).toMatchObject({ integratedLufs: -24, truePeakDb: -2 });
	});

	it('without dialogue the music is the programme; loudness false leaves the Mix; refusals', () => {
		const h = new Harness();
		const music = addAudio(h, 0, 'A1', 'music', 5);
		const untyped = addAudio(h, 0, 'A2', null, 5);
		const r = h.ok([
			{
				type: 'soundDesign.applyDelivery',
				delivery: 'podcast',
				loudness: false,
				measuredLufs: { [music]: -20, [untyped]: -20 },
			},
		]);
		const res = r.results[0] as { matched: Record<string, unknown> };
		expect(res.matched[music]).toMatchObject({ targetLufs: -16 });
		expect(res.matched[untyped]).toEqual({ skipped: 'no audio type' });
		expect(h.seq.master.loudness?.enabled ?? false).toBe(false);
		expect(
			h.tx([{ type: 'soundDesign.applyDelivery', delivery: 'podcast', measuredLufs: { clp_nope: -20 } }])
				.errors?.[0]?.code,
		).toBe('E_NOT_FOUND');
		expect(
			h.tx([
				{
					type: 'soundDesign.applyDelivery',
					delivery: 'podcast',
					ducking: [{ clipIds: [untyped], regions: [] }],
				},
			]).errors?.[0]?.code,
		).toBe('E_INVALID_PARAM');
		expect(h.tx([{ type: 'soundDesign.applyDelivery', delivery: 'cinema' }]).errors?.[0]?.code).toBe(
			'E_SCHEMA',
		);
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: true } }]);
		expect(
			h.tx([{ type: 'soundDesign.applyDelivery', delivery: 'web', measuredLufs: { [music]: -20 } }])
				.errors?.[0]?.code,
		).toBe('E_TRACK_LOCKED');
	});
});

describe('mix records: load and repair', () => {
	it('valid records survive a load; unreadable ones are dropped field by field; a gone bus drops the glue', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const hitM = libMedia(h, ['hit']);
		h.ok([{ type: 'soundDesign.place', frame: 60, layers: [{ mediaId: hitM, track: 'A2' }] }]);
		const cue = heroCue(h, 120, {
			stopBefore: { seconds: 0.25, depthDb: -24 },
			build: { seconds: 2, fromHz: 150, toHz: 2000 },
		});
		h.ok([
			{ type: 'soundDesign.applyStopBefore', cueId: cue },
			{ type: 'soundDesign.applyBuild', cueId: cue },
			{ type: 'soundDesign.ensureBus' },
		]);
		const loaded = loadProject(clone(h.doc), { ids: createCounterIdSource(900) });
		expect((loaded.document.sequences[h.seqId]!.soundDesign as SoundDesign).mix).toEqual(sd(h)!.mix);
		expect(repairDocument(loaded.document, createCounterIdSource(5000)).report).toEqual([]);
		// damage: a bad write record and a bad room glue
		const bad = clone(sd(h)!);
		(bad.mix!.cues![cue]!.stopBefore as unknown as { writes: unknown }).writes = 'nope';
		(bad.mix!.room as unknown as { sendDb: unknown }).sendDb = 'loud';
		const read = readSoundDesign(bad)!;
		expect(read.mix!.cues![cue]!.stopBefore).toBeUndefined();
		expect(read.mix!.cues![cue]!.build).toEqual(sd(h)!.mix!.cues![cue]!.build);
		expect(read.mix!.room).toBeUndefined();
		// the bus removed by hand: repair drops the glue record
		const doc = clone(h.doc);
		const seq = doc.sequences[h.seqId]!;
		seq.submixTracks = [];
		for (const t of seq.audioTracks) if (t.mixer) t.mixer.sends = [];
		const fixed = repairDocument(doc, createCounterIdSource(6000));
		const sd2 = fixed.document.sequences[h.seqId]!.soundDesign as SoundDesign;
		expect(sd2.mix!.room).toBeUndefined();
		expect(sd2.settings!.roomBus).toBeNull();
		expect(fixed.report.map((r) => r.action)).toContain('drop-room-glue');
		expect(repairDocument(fixed.document, createCounterIdSource(7000)).report).toEqual([]);
		// a duplicated sequence keeps the automation, not the records
		const d = h.ok([{ type: 'sequence.duplicate', sequenceId: h.seqId }]);
		const copyId = (d.results[0] as { sequenceId: string }).sequenceId;
		const copy = h.doc.sequences[copyId]!.soundDesign as SoundDesign;
		expect(copy.mix).toBeUndefined();
		// the copy has its own room submix (new ids), its sends point at it, and the settings follow
		const cs = h.doc.sequences[copyId]!;
		expect(cs.submixTracks).toHaveLength(1);
		expect(cs.submixTracks![0]!.id).not.toBe(h.seq.submixTracks![0]!.id);
		expect(copy.settings!.roomBus).toBe(cs.submixTracks![0]!.id);
		expect(cs.audioTracks[1]!.mixer!.sends![0]!.target).toBe(cs.submixTracks![0]!.id);
		expect(checkInvariants(h.doc)).toEqual([]);
		// ensureBus on the copy adopts its room
		h.ok([{ type: 'soundDesign.ensureBus', sequenceId: copyId }]);
		expect((h.doc.sequences[copyId]!.soundDesign as SoundDesign).mix!.room!.busId).toBe(
			cs.submixTracks![0]!.id,
		);
	});
});

describe('stop-before and build follow the filled cue', () => {
	it('filling a cue with a stored stop-before / build writes them; the cue menu toggle on a filled cue too', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const hitM = libMedia(h, ['hit']);
		h.ok([{ type: 'track.add', kind: 'audio', count: 1 }]);
		const cue = heroCue(h, 150, {
			stopBefore: { seconds: 0.25, depthDb: -24 },
			build: { seconds: 2, fromHz: 150, toHz: 2000 },
		});
		// unfilled: stored only
		expect(track(h, 'A1').volumeDb?.keyframes ?? []).toEqual([]);
		h.ok([{ type: 'soundDesign.place', cueId: cue, layers: [{ mediaId: hitM, track: 'A2' }] }]);
		const T = 150 * F30;
		expect(trackVol(h, 'A1', T - 0.1 * S)).toBeCloseTo(-24, 6);
		expect(track(h, 'A1').effects?.[0]?.effectId).toBe(BUILD_FILTER_EFFECT_ID);
		expect(sd(h)!.mix!.cues![cue]).toMatchObject({ stopBefore: { frame: 150 }, build: { frame: 150 } });
		// "Stop Before Next" on another, filled cue: written at once
		const p = h.ok([{ type: 'soundDesign.place', frame: 450, layers: [{ mediaId: hitM, track: 'A2' }] }]);
		void p;
		const cue2 = heroCue(h, 450);
		h.ok([{ type: 'soundCue.remove', cueIds: [cue2] }]);
		const c3 = heroCue(h, 400);
		h.ok([{ type: 'soundDesign.place', cueId: c3, layers: [{ mediaId: hitM, track: 'A2' }] }]);
		expect(trackVol(h, 'A1', 400 * F30 - 0.1 * S)).toBe(0);
		h.ok([{ type: 'soundCue.update', cueId: c3, stopBefore: { seconds: 0.25, depthDb: -24 } }]);
		expect(trackVol(h, 'A1', 400 * F30 - 0.1 * S)).toBeCloseTo(-24, 6);
		// a locked music track does not block placing: the dip is skipped there
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: true } }]);
		const c4 = heroCue(h, 600, { stopBefore: { seconds: 0.25, depthDb: -24 } });
		h.ok([{ type: 'soundDesign.place', cueId: c4, layers: [{ mediaId: hitM, track: 'A2' }] }]);
		expect(trackVol(h, 'A1', 600 * F30 - 0.1 * S)).toBe(0);
		expect(sd(h)!.mix!.cues![c4]).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('a locked music track never makes a cue edit fail', () => {
	it('moving or deleting a cue whose dip sits on a locked track: the track keeps it', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const cue = heroCue(h, 120, { stopBefore: { seconds: 0.25, depthDb: -24 } });
		h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		const written = clone(track(h, 'A1').volumeDb);
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: true } }]);
		// moved: the cue moves, the locked lane stays as it was (and its record too, for later)
		h.ok([{ type: 'soundCue.update', cueId: cue, frame: 200 }]);
		expect(track(h, 'A1').volumeDb).toEqual(written);
		expect(sd(h)!.mix!.cues![cue]!.stopBefore!.frame).toBe(120);
		// explicit re-apply is refused while locked
		expect(h.tx([{ type: 'soundDesign.applyStopBefore', cueId: cue }]).errors?.[0]?.code).toBe('E_TRACK_LOCKED');
		// unlocked, the next edit catches up (the dip follows the cue to 200)
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: false } }]);
		h.ok([{ type: 'soundCue.update', cueId: cue, frame: 210 }]);
		expect(trackVol(h, 'A1', 120 * F30 - 0.1 * S)).toBeCloseTo(0, 6);
		expect(trackVol(h, 'A1', 210 * F30 - 0.1 * S)).toBeCloseTo(-24, 6);
		// deleted while locked: the cue goes, the lane keeps its keys, the record is dropped
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: true } }]);
		const kept = clone(track(h, 'A1').volumeDb);
		h.ok([{ type: 'soundCue.remove', cueIds: [cue] }]);
		expect(track(h, 'A1').volumeDb).toEqual(kept);
		expect(sd(h)!.mix?.cues?.[cue]).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
