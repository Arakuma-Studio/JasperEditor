// Phase 4 verification (model): regressions for the mix realisations (spec 12 §2.4; wp-note "Phase 4 → WP4.2a"):
// overlapping stop-befores / builds removed in any order give the lane back exactly (a stack per lane; property),
// Bézier volume curves are kept outside the dips (no swell clipped, eases kept, no E_LIMIT from the widening), a split
// music clip keeps both parts in the records, a duplicated sequence keeps working records, locked tracks never fail a
// cue edit and never strand keys (orphans settled on unlock), mute / unmute restore exactly, builds that a clip cuts do
// not sweep down, no build keys before the sequence start, room glue exactness, delivery ducking depth, Auto gain and
// applyGains on manual clips.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	type AudioClip,
	BUILD_FILTER_EFFECT_ID,
	type ClipSfx,
	checkInvariants,
	clipLaneTime,
	createCounterIdSource,
	type Dip,
	dipEnvelopeAt,
	evaluate,
	FLICKS_PER_SECOND,
	type Keyframe,
	type LibraryProvenance,
	mergeDips,
	repairDocument,
	SEQUENCE_LANE,
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
type Clip = AudioClip & { sfx?: ClipSfx };

function addAudio(h: Harness, at: number, trackLabel: string, type: string | null, seconds = 20) {
	const m = h.registerVideo({ kind: 'audio', seconds });
	const r = h.ok([{ type: 'clip.place', source: { mediaId: m }, at, tracks: { audio: trackLabel } }]);
	const id = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
	if (type) h.ok([{ type: 'essentialSound.setType', clipIds: [id], audioType: type }]);
	return id;
}
const txr = (h: Harness, commands: unknown[]) =>
	h.tx(commands) as {
		ok: boolean;
		errors?: { code: string }[];
		warnings?: { code: string; message: string }[];
	};
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
const sd = (h: Harness) => h.seq.soundDesign as SoundDesign | undefined;
/** Fresh-id differences removed. */
const noIds = (x: unknown) =>
	JSON.parse(JSON.stringify(x).replace(/"(kf|snd|fx|trk|cue)_[0-9A-Za-z]+"/g, '"$1"'));

let n = 0;
function libMedia(h: Harness, types: string[] = ['hit']) {
	const soundId = `snd_${(0xc000 + ++n).toString(16).padStart(16, '0')}`;
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
		{ type: 'soundCue.add', cues: [{ frame, kind: 'land', weight: 'hero', source: 'user', ...extra }] },
	]);
	return (r.results[0] as { cueIds: string[] }).cueIds[0]!;
}

const SB = { seconds: 0.25, depthDb: -24 };
const BUILD = { seconds: 2, fromHz: 150, toHz: 2000 };

/** Music on A1 with a recorded fader ride (−6 at 3 s → −4 at 3.9 s → 0 at 5 s). */
function rideSetup() {
	const h = new Harness();
	const music = addAudio(h, 0, 'A1', 'music');
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
	return { h, music, ride: clone(track(h, 'A1').volumeDb!) };
}

/** Sets keys on an animatable of the harness document directly (bezier keys have no dedicated command). */
function setKeys(h: Harness, edit: (seq: (typeof h.doc.sequences)[string]) => void) {
	const doc = clone(h.doc);
	edit(doc.sequences[h.seqId]!);
	h.doc = doc;
	expect(checkInvariants(h.doc)).toEqual([]);
}
const key = (
	id: string,
	time: number,
	value: number,
	interpolation: Keyframe<number>['interpolation'] = 'linear',
	ease = { influence: 1 / 3, slope: 1 },
): Keyframe<number> => ({ id, time, value, interpolation, easeIn: { ...ease }, easeOut: { ...ease } });

describe('bug 1: overlapping realisations are a stack per lane', () => {
	it('clearing A then B (overlapping stop-befores) gives the fader ride back exactly', () => {
		const { h, ride } = rideSetup();
		const E = (t: number) => evaluate(ride as Animatable<number>, t);
		const a = heroCue(h, 117, { stopBefore: SB });
		const b = heroCue(h, 123, { stopBefore: SB });
		h.ok([
			{ type: 'soundDesign.applyStopBefore', cueId: a },
			{ type: 'soundDesign.applyStopBefore', cueId: b },
		]);
		h.ok([{ type: 'soundCue.update', cueId: a, stopBefore: null }]);
		// A's floor (3.8 s) is outside B's window: the ride again (−4.22 dB)
		expect(trackVol(h, 'A1', 3.8 * S)).toBeCloseTo(E(3.8 * S), 6);
		// B still dips relative to its local level
		const refB = Math.max(E(123 * F30 - 0.25 * S - 30 * MS), E(123 * F30 + 20 * MS));
		expect(trackVol(h, 'A1', 123 * F30 - 0.1 * S)).toBeCloseTo(refB - 24, 6);
		h.ok([{ type: 'soundCue.update', cueId: b, stopBefore: null }]);
		expect(track(h, 'A1').volumeDb).toEqual(ride);
		expect(sd(h)!.mix?.cues ?? {}).toEqual({});
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('moving A then removing both leaves no ghost dip', () => {
		const { h, ride } = rideSetup();
		const a = heroCue(h, 117, { stopBefore: SB });
		const b = heroCue(h, 123, { stopBefore: SB });
		h.ok([
			{ type: 'soundDesign.applyStopBefore', cueId: a },
			{ type: 'soundDesign.applyStopBefore', cueId: b },
		]);
		h.ok([{ type: 'soundCue.update', cueId: a, frame: 119 }]);
		h.ok([{ type: 'soundCue.remove', cueIds: [a] }]);
		h.ok([{ type: 'soundCue.remove', cueIds: [b] }]);
		let low = 0;
		for (let t = 3.5 * S; t < 4.3 * S; t += 5 * MS)
			low = Math.min(low, trackVol(h, 'A1', t) - evaluate(ride as Animatable<number>, t));
		expect(low).toBeCloseTo(0, 6);
		expect(track(h, 'A1').volumeDb).toEqual(ride);
	});

	it('two overlapping builds on one filter: removing the first then the second leaves no keys and no filter', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const a = heroCue(h, 150, { build: BUILD });
		const b = heroCue(h, 165, { build: BUILD });
		h.ok([
			{ type: 'soundDesign.applyBuild', cueId: a },
			{ type: 'soundDesign.applyBuild', cueId: b },
		]);
		h.ok([{ type: 'soundCue.update', cueId: a, build: null }]);
		// b's sweep is intact (its top just before its hero)
		const cut = track(h, 'A1').effects![0]!.params.cutoff as Animatable<number>;
		expect(evaluate(cut, 165 * F30 - F30)).toBeCloseTo(2000, 4);
		expect(evaluate(cut, 150 * F30 - F30)).toBeLessThan(2000);
		h.ok([{ type: 'soundCue.remove', cueIds: [b] }]);
		expect(track(h, 'A1').effects ?? []).toEqual([]);
		expect(sd(h)!.mix?.buildFilters ?? {}).toEqual({});
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('property: overlapping stop-befores and builds added, moved and removed in any order give the lanes back exactly', () => {
		const op = fc.record({
			frame: fc.integer({ min: 100, max: 150 }),
			kind: fc.constantFrom('stopBefore', 'build', 'both'),
			seconds: fc.constantFrom(0.1, 0.25, 0.5, 1),
			depth: fc.constantFrom(-6, -24, -40),
			shared: fc.boolean(),
		});
		fc.assert(
			fc.property(
				fc.array(op, { minLength: 2, maxLength: 4 }),
				fc.array(fc.nat(), { minLength: 4, maxLength: 4 }),
				fc.option(fc.record({ which: fc.nat(), to: fc.integer({ min: 100, max: 150 }) })),
				(ops, order, move) => {
					const { h, music, ride } = rideSetup();
					// a clip on A2 shares nothing; music on A3 shares its track with dialogue → clip lanes
					const m3 = addAudio(h, 0, 'A3', 'music', 20);
					addAudio(h, 160, 'A3', 'dialogue', 2);
					void music;
					const vol3 = clone(clipOf(h, m3).volumeDb);
					const fx3 = clone(clipOf(h, m3).effects);
					const ids = ops.map((o) =>
						heroCue(h, o.frame, {
							...(o.kind !== 'build' ? { stopBefore: { seconds: o.seconds, depthDb: o.depth } } : {}),
							...(o.kind !== 'stopBefore'
								? { build: { seconds: o.seconds * 2, fromHz: 150, toHz: 2000 } }
								: {}),
						}),
					);
					h.ok(
						ids.flatMap((id, i) => [
							...(ops[i]!.kind !== 'build' ? [{ type: 'soundDesign.applyStopBefore', cueId: id }] : []),
							...(ops[i]!.kind !== 'stopBefore' ? [{ type: 'soundDesign.applyBuild', cueId: id }] : []),
						]),
					);
					if (move) h.ok([{ type: 'soundCue.update', cueId: ids[move.which % ids.length]!, frame: move.to }]);
					// remove in a permuted order (some cleared, some deleted)
					const left = [...ids];
					let k = 0;
					while (left.length) {
						const id = left.splice(order[k % order.length]! % left.length, 1)[0]!;
						if (k % 2) h.ok([{ type: 'soundCue.remove', cueIds: [id] }]);
						else h.ok([{ type: 'soundCue.update', cueId: id, stopBefore: null, build: null }]);
						k++;
					}
					expect(track(h, 'A1').volumeDb).toEqual(ride);
					expect(track(h, 'A1').effects ?? []).toEqual([]);
					expect(track(h, 'A3').volumeDb?.keyframes ?? []).toEqual([]);
					expect(clipOf(h, m3).volumeDb).toEqual(vol3);
					expect(clipOf(h, m3).effects).toEqual(fx3);
					expect(sd(h)!.mix?.cues ?? {}).toEqual({});
					expect(sd(h)!.mix?.buildFilters ?? {}).toEqual({});
					expect(checkInvariants(h.doc)).toEqual([]);
				},
			),
			{ numRuns: 40 },
		);
	}, 300_000);
});

describe('bug 2: Bézier volume curves', () => {
	/** A1 music with a Bézier lane: −6 at 2 s, 0 at 4.5 s (a swell after the hero at 4 s), −6 at 6 s. */
	function bezierSetup() {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const easy = { influence: 1 / 3, slope: 0 };
		setKeys(h, (seq) => {
			seq.audioTracks[0]!.volumeDb = {
				value: 0,
				keyframes: [
					key(h.ids.next('kf'), 2 * S, -6, 'bezier', easy),
					key(h.ids.next('kf'), 4.5 * S, 0, 'bezier', easy),
					key(h.ids.next('kf'), 6 * S, -6, 'bezier', easy),
				],
			} as never;
		});
		return { h, lane: clone(track(h, 'A1').volumeDb!) };
	}

	it('outside the dip the Bézier curve is unchanged (no swell clipped), eases kept, removed exactly', () => {
		const { h, lane } = bezierSetup();
		const E = (t: number) => evaluate(lane as Animatable<number>, t);
		const cue = heroCue(h, 120, { stopBefore: SB });
		h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		// (a) after the hero: the swell to 0 dB at 4.5 s is there
		for (const t of [4.05, 4.2, 4.4, 4.5, 1.5, 2.5, 3.5])
			expect(Math.abs(trackVol(h, 'A1', t * S) - E(t * S))).toBeLessThan(2e-3);
		// (b) outside the widened window (the segment after 4.5 s): exact
		for (const t of [5, 5.5, 6, 7]) expect(trackVol(h, 'A1', t * S)).toBeCloseTo(E(t * S), 9);
		// on the floor: the local level − 24
		const T = 4 * S;
		const ref = Math.max(E(T - 0.25 * S - 30 * MS), E(T + 20 * MS));
		expect(trackVol(h, 'A1', T - 0.1 * S)).toBeLessThanOrEqual(ref - 24 + 1e-6);
		h.ok([{ type: 'soundCue.update', cueId: cue, stopBefore: null }]);
		expect(track(h, 'A1').volumeDb).toEqual(lane);
	});

	it('two Bézier keys 6 s apart on a shared music clip: applying and placing work (no E_LIMIT), the clip curve is kept', () => {
		const h = new Harness();
		const music = addAudio(h, 0, 'A1', 'music', 20);
		addAudio(h, 119, 'A1', 'dialogue', 1);
		const easy = { influence: 1 / 3, slope: 0 };
		setKeys(h, (seq) => {
			(seq.clips[music] as AudioClip).volumeDb = {
				value: 0,
				keyframes: [
					key(h.ids.next('kf'), 1 * S, -1, 'bezier', easy),
					key(h.ids.next('kf'), 7 * S, -6, 'bezier', easy),
				],
			} as never;
		});
		const vol = clone(clipOf(h, music).volumeDb);
		const E = (t: number) => evaluate(vol as Animatable<number>, t);
		const cue = heroCue(h, 120, { stopBefore: SB });
		const r = h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		expect((r.results[0] as { writes: { target: string }[] }).writes[0]!.target).toBe('clipVolume');
		for (const t of [0.5, 1.5, 3, 3.6])
			expect(Math.abs(clipVol(h, music, t * S) - E(t * S))).toBeLessThan(2e-3);
		h.ok([{ type: 'soundCue.update', cueId: cue, stopBefore: null }]);
		expect(clipOf(h, music).volumeDb).toEqual(vol);
		// a filled cue placed over it
		const hit = libMedia(h);
		h.ok([{ type: 'track.add', kind: 'audio', count: 1 }]);
		h.ok([{ type: 'soundCue.update', cueId: cue, stopBefore: SB }]);
		const p = txr(h, [{ type: 'soundDesign.place', cueId: cue, layers: [{ mediaId: hit, track: 'A2' }] }]);
		expect(p.ok).toBe(true);
		expect(sd(h)!.mix!.cues![cue]!.stopBefore!.writes).toHaveLength(1);
	});

	it('automation too dense to record: explicit apply refuses E_LIMIT, placing skips it with a warning', () => {
		const h = new Harness();
		const music = addAudio(h, 0, 'A1', 'music', 20);
		addAudio(h, 119, 'A1', 'dialogue', 1);
		setKeys(h, (seq) => {
			const kfs: Keyframe<number>[] = [];
			for (let i = 0; i < 1200; i++)
				kfs.push(key(h.ids.next('kf'), Math.round(3.65 * S + i * 0.25 * MS), -((i % 7) + 1)));
			(seq.clips[music] as AudioClip).volumeDb = { value: 0, keyframes: kfs } as never;
		});
		const cue = heroCue(h, 120, { stopBefore: SB });
		expect(txr(h, [{ type: 'soundDesign.applyStopBefore', cueId: cue }]).errors?.[0]?.code).toBe('E_LIMIT');
		const vol = clone(clipOf(h, music).volumeDb);
		h.ok([{ type: 'track.add', kind: 'audio', count: 1 }]);
		const p = txr(h, [
			{ type: 'soundDesign.place', cueId: cue, layers: [{ mediaId: libMedia(h), track: 'A2' }] },
		]);
		expect(p.ok).toBe(true);
		expect(p.warnings?.some((w) => w.code === 'W_MIX_SKIPPED')).toBe(true);
		expect(clipOf(h, music).volumeDb).toEqual(vol);
	});
});

describe('bug 2: mergeDips on curved lanes (property)', () => {
	const keyArb = fc.record({
		t: fc.integer({ min: 0, max: 40 }),
		v: fc.double({ min: -40, max: 10, noNaN: true }),
		interp: fc.constantFrom('linear', 'hold', 'bezier', 'auto-bezier', 'continuous-bezier'),
		inf: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
		slope: fc.double({ min: 0, max: 2, noNaN: true }),
	});
	const dipArb = fc
		.record({
			s: fc.integer({ min: 0, max: 380 }),
			len: fc.integer({ min: 0, max: 60 }),
			depth: fc.double({ min: -60, max: -0.5, noNaN: true }),
			fade: fc.integer({ min: 0, max: 400 }),
		})
		.map((d) => ({ start: d.s * 10 * MS, end: (d.s + d.len) * 10 * MS, depthDb: d.depth, fadeMs: d.fade }));
	const lanes = [
		{ name: 'sequence', lane: SEQUENCE_LANE },
		{
			name: 'clip ×2 reversed',
			lane: clipLaneTime(
				{ start: 0, duration: 30 * 30, sourceIn: 0, speed: { rate: 2, reverse: true } },
				{ num: 30, den: 1 },
			),
		},
	];
	it('outside the dips the curve is kept (to 0.05 dB on rebuilt curves), inside = min(curve, dip), keys outside kept, exact unwrite', () => {
		let maxCurved = 0;
		fc.assert(
			fc.property(
				fc.array(keyArb, { maxLength: 8 }),
				fc.array(dipArb, { minLength: 1, maxLength: 3 }),
				fc.constantFrom(0, 1),
				(keys, dips: Dip[], li) => {
					const { lane } = lanes[li]!;
					const seen = new Set<number>();
					const kfs: Keyframe<number>[] = [];
					for (const k of keys) {
						const time = k.t * 100 * MS * (li === 1 ? 2 : 1);
						if (seen.has(time)) continue;
						seen.add(time);
						kfs.push({
							id: `kf_${kfs.length}`,
							time,
							value: k.v,
							interpolation: k.interp as Keyframe<number>['interpolation'],
							easeIn: { influence: k.inf, slope: k.slope },
							easeOut: { influence: 1 - k.inf, slope: k.slope },
						});
					}
					kfs.sort((a, b) => a.time - b.time);
					const anim: Animatable<number> = { value: -3, keyframes: kfs };
					let i = 0;
					const r = mergeDips(anim, lane, dips, { newId: () => `new_${i++}`, clamp: [-96, 15] });
					if (!r) return;
					const res: Animatable<number> = { value: -3, keyframes: r.keyframes };
					const E = (t: number) => evaluate(anim, lane.toLane(t));
					const G = (t: number) => evaluate(res, lane.toLane(t));
					// the un-widened dip windows (as mergeDips merges them) and their reference levels
					// (sorted by window start: dips with longer fades start earlier than their start — sorting by dip start
					// merged [1299, 1301] ms with [917, 1703] ms into [1299, 1703] ms, seed 2097034364)
					const w0: [number, number][] = [];
					const ws = dips
						.map((d): [number, number] => {
							const f = Math.max(1, d.fadeMs) * MS;
							return [Math.max(lane.span[0], d.start - f), Math.min(lane.span[1], d.end + f)];
						})
						.filter((w) => w[1] > w[0])
						.sort((a, b) => a[0] - b[0]);
					for (const w of ws) {
						const last = w0[w0.length - 1];
						if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
						else w0.push([w[0], w[1]]);
					}
					const curved = kfs.some((k) => k.interpolation !== 'linear' && k.interpolation !== 'hold');
					// rebuilt curves: within sampling (1 ms samples at most 0.001 dB off; steeper bends a little more);
					// straight ones: exact (to rounding)
					const tolOut = curved ? 0.05 : 1e-6;
					const tol = curved ? 0.05 : 1e-5;
					const nearStep = (t: number) =>
						kfs.some((kf, j) => j > 0 && Math.abs(lane.toSeq(kf.time) - t) <= 2 * (li === 1 ? 1 : 1) + 1);
					const end = Math.min(lane.span[1], 4.5 * S);
					for (let k = 0; k <= 300; k++) {
						const t = (k / 300) * end;
						if (nearStep(t)) continue;
						const e = E(t);
						const got = G(t);
						expect(got).toBeLessThanOrEqual(e + tol);
						const env = dipEnvelopeAt(dips, t);
						if (env === 0) {
							expect(Math.abs(got - e)).toBeLessThanOrEqual(tolOut);
							maxCurved = curved ? Math.max(maxCurved, Math.abs(got - e)) : maxCurved;
							continue;
						}
						const w = w0.find(([a, b]) => t >= a && t <= b);
						if (!w) continue;
						const ref = Math.max(E(w[0]), E(w[1]));
						expect(Math.abs(got - Math.min(e, Math.min(15, Math.max(-96, ref + env))))).toBeLessThanOrEqual(
							tol,
						);
					}
					// keys outside the rewritten ranges are the same keys
					for (const k of kfs) {
						const ts = lane.toSeq(k.time);
						if (!r.windows.some(([a, b]) => ts >= a - 1 && ts <= b + 1))
							expect(r.keyframes).toContainEqual(k);
					}
					const back = unwriteCurve(r.keyframes, r);
					expect(back.exact).toBe(true);
					expect(back.keyframes).toEqual(kfs);
				},
			),
			{
				numRuns: 300,
				// the counterexample that found the model's window-merge bug (keys 0 → 1.3 s; dips at 1.31 s with 393 ms
				// fades and at 1.3 s with none)
				examples: [
					[
						[
							{ t: 0, v: 0.00003403141361112716, interp: 'linear', inf: 0.05, slope: 0 },
							{ t: 13, v: 0, interp: 'linear', inf: 0.05, slope: 0 },
						],
						[
							{ start: 924336000, end: 924336000, depthDb: -4.832902467924639, fadeMs: 393 },
							{ start: 917280000, end: 917280000, depthDb: -0.5, fadeMs: 0 },
						],
						0,
					],
				],
			},
		);
		// the largest deviation of a rebuilt curve outside the dips in these runs
		expect(maxCurved).toBeLessThan(0.05);
	}, 300_000);
});

describe('bug 3: splitting a dipped music clip', () => {
	it('both parts are in the records: clearing the stop-before / build restores both', () => {
		const h = new Harness();
		const music = addAudio(h, 0, 'A1', 'music', 20);
		addAudio(h, 119, 'A1', 'dialogue', 1);
		const vol = clone(clipOf(h, music).volumeDb);
		const cue = heroCue(h, 120, { stopBefore: { seconds: 1, depthDb: -24 }, build: BUILD });
		h.ok([
			{ type: 'soundDesign.applyStopBefore', cueId: cue },
			{ type: 'soundDesign.applyBuild', cueId: cue },
		]);
		h.ok([{ type: 'clip.split', clipIds: [music], at: 110 }]);
		const right = h.clips('A1').find((c) => c.start === 110)!.id;
		expect(clipVol(h, right, 115 * F30)).toBeCloseTo(-24, 6);
		expect(sd(h)!.mix!.buildFilters![right]).toBeTruthy();
		expect(checkInvariants(h.doc)).toEqual([]);
		h.ok([{ type: 'soundCue.update', cueId: cue, stopBefore: null, build: null }]);
		expect(clipVol(h, right, 115 * F30)).toBeCloseTo(0, 6);
		expect(clipOf(h, right).volumeDb.keyframes).toEqual([]);
		expect(clipOf(h, right).effects.some((e) => e.effectId === BUILD_FILTER_EFFECT_ID)).toBe(false);
		expect(clipOf(h, music).volumeDb).toEqual(vol);
		expect(sd(h)!.mix?.cues ?? {}).toEqual({});
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('bug 4: duplicated sequences and repair keep working records', () => {
	it('on the copy, clearing the stop-before removes the dip; the original keeps its own', () => {
		const { h, ride } = rideSetup();
		const cue = heroCue(h, 120, { stopBefore: SB, build: BUILD });
		h.ok([
			{ type: 'soundDesign.applyStopBefore', cueId: cue },
			{ type: 'soundDesign.applyBuild', cueId: cue },
		]);
		const d = h.ok([{ type: 'sequence.duplicate', sequenceId: h.seqId }]);
		const copyId = (d.results[0] as { sequenceId: string }).sequenceId;
		expect(checkInvariants(h.doc)).toEqual([]);
		const copy = () => h.doc.sequences[copyId]!;
		const copyCue = Object.keys((copy().soundDesign as SoundDesign).cues)[0]!;
		expect(Object.keys((copy().soundDesign as SoundDesign).mix!.cues!)).toEqual([copyCue]);
		h.ok([{ type: 'soundCue.update', cueId: copyCue, stopBefore: null, build: null }], {});
		expect(noIds(copy().audioTracks[0]!.volumeDb)).toEqual(noIds(ride));
		expect(copy().audioTracks[0]!.effects ?? []).toEqual([]);
		// the original still has its dip
		expect(trackVol(h, 'A1', 120 * F30 - 0.1 * S)).toBeLessThan(-20);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('repair renames mix.cues with a re-identified cue and prunes stale records; idempotent', () => {
		const { h } = rideSetup();
		const cue = heroCue(h, 120, { stopBefore: SB, build: BUILD });
		h.ok([
			{ type: 'soundDesign.applyStopBefore', cueId: cue },
			{ type: 'soundDesign.applyBuild', cueId: cue },
		]);
		const doc = clone(h.doc);
		const seq = doc.sequences[h.seqId]!;
		const s = seq.soundDesign as SoundDesign;
		// a malformed cue id (re-identified by repair) and a stale record of a cue that is gone
		const bad = 'cue_bad';
		s.cues[bad] = { ...s.cues[cue]!, id: bad };
		delete s.cues[cue];
		s.mix!.cues![bad] = s.mix!.cues![cue]!;
		delete s.mix!.cues![cue];
		s.mix!.cues!.cue_00000000000057A1 = clone(s.mix!.cues![bad]!);
		s.mix!.buildFilters!.clp_00000000000ghost = 'fx_0000000000000GH0';
		const fixed = repairDocument(doc, createCounterIdSource(8000));
		const s2 = fixed.document.sequences[h.seqId]!.soundDesign as SoundDesign;
		const newId = Object.keys(s2.cues)[0]!;
		expect(newId).not.toBe(bad);
		expect(Object.keys(s2.mix!.cues!)).toEqual([newId]);
		expect(Object.keys(s2.mix!.buildFilters!)).toEqual([track(h, 'A1').id]);
		expect(repairDocument(fixed.document, createCounterIdSource(9000)).report).toEqual([]);
	});
});

describe('bug 5: locked music tracks', () => {
	it('moving a realised cue over music on a locked track does not fail the edit', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music', 5);
		addAudio(h, 300, 'A2', 'music', 10);
		const cue = heroCue(h, 120, { stopBefore: SB, build: BUILD });
		h.ok([
			{ type: 'soundDesign.applyStopBefore', cueId: cue },
			{ type: 'soundDesign.applyBuild', cueId: cue },
		]);
		h.ok([{ type: 'track.update', trackId: track(h, 'A2').id, patch: { locked: true } }]);
		const r = txr(h, [{ type: 'soundCue.update', cueId: cue, frame: 400 }]);
		expect(r.ok).toBe(true);
		expect(trackVol(h, 'A1', 120 * F30 - 0.1 * S)).toBeCloseTo(0, 6);
		const r2 = txr(h, [{ type: 'soundCue.resync' }]);
		expect(r2.ok).toBe(true);
	});

	it('deleting a cue whose dip sits on a locked track keeps an orphan record, settled exactly on unlock', () => {
		const { h, ride } = rideSetup();
		const cue = heroCue(h, 120, { stopBefore: SB, build: BUILD });
		h.ok([
			{ type: 'soundDesign.applyStopBefore', cueId: cue },
			{ type: 'soundDesign.applyBuild', cueId: cue },
		]);
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: true } }]);
		const kept = clone(track(h, 'A1').volumeDb);
		h.ok([{ type: 'soundCue.remove', cueIds: [cue] }]);
		expect(track(h, 'A1').volumeDb).toEqual(kept);
		expect((sd(h)!.mix as { orphans?: Record<string, unknown> }).orphans?.[cue]).toBeTruthy();
		expect(checkInvariants(h.doc)).toEqual([]);
		const before = h.doc;
		h.ok([{ type: 'track.update', trackId: track(h, 'A1').id, patch: { locked: false } }]);
		expect(track(h, 'A1').volumeDb).toEqual(ride);
		expect(track(h, 'A1').effects ?? []).toEqual([]);
		expect((sd(h)!.mix as { orphans?: Record<string, unknown> } | undefined)?.orphans ?? {}).toEqual({});
		// undo: the document before the unlock (untouched)
		expect(before.sequences[h.seqId]!.audioTracks[0]!.volumeDb).toEqual(kept);
	});
});

describe('bug 6: delivery leaves locked default-owned sound effects alone', () => {
	it('a default-level SFX on a locked track keeps its gain and is reported', () => {
		const h = new Harness();
		const hitM = libMedia(h);
		h.ok([{ type: 'track.add', kind: 'audio', count: 1 }]);
		const pr = h.ok([{ type: 'soundDesign.place', frame: 300, layers: [{ mediaId: hitM, track: 'A2' }] }]);
		const hit = (pr.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		const gain = clipOf(h, hit).gainDb;
		h.ok([{ type: 'track.update', trackId: track(h, 'A2').id, patch: { locked: true } }]);
		const r = h.ok([{ type: 'soundDesign.applyDelivery', delivery: 'broadcast-r128', loudness: false }]);
		expect(clipOf(h, hit).gainDb).toBe(gain);
		expect((r.results[0] as { levelsSkipped?: { clipId: string }[] }).levelsSkipped).toEqual([
			{ clipId: hit, reason: 'its track is locked' },
		]);
	});
});

describe('bug 7: a build cut by the end of its music clip', () => {
	it('does not sweep back down at the clip end', () => {
		const h = new Harness();
		const music = addAudio(h, 0, 'A1', 'music', 20);
		h.ok([{ type: 'clip.trim', clipId: music, edge: 'out', deltaFrames: 140 - 600 }]);
		addAudio(h, 140, 'A1', 'dialogue', 5);
		const cue = heroCue(h, 150, { build: BUILD });
		h.ok([{ type: 'soundDesign.applyBuild', cueId: cue }]);
		const c = clipOf(h, music);
		const fx = c.effects.find((e) => e.effectId === BUILD_FILTER_EFFECT_ID)!;
		const lane = clipLaneTime(c, h.seq.settings.frameRate);
		const cut = fx.params.cutoff as Animatable<number>;
		const atEnd = evaluate(cut, lane.toLane(140 * F30 - 1));
		const before = evaluate(cut, lane.toLane(135 * F30));
		expect(atEnd).toBeGreaterThan(before);
		expect(atEnd).toBeGreaterThan(500);
	});
});

describe('bug 8: mute / unmute restore the mix exactly', () => {
	it('a filled cue with ambience: mute → the lanes before, unmute → the realised lanes (ambience kept); undo / redo', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		addAudio(h, 0, 'A2', 'ambience');
		h.ok([{ type: 'track.add', kind: 'audio', count: 1 }]);
		const pre = clone(h.doc.sequences[h.seqId]!.audioTracks);
		const cue = heroCue(h, 120, { stopBefore: SB });
		h.ok([{ type: 'soundDesign.place', cueId: cue, layers: [{ mediaId: libMedia(h), track: 'A3' }] }]);
		h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue, ambience: true }]);
		const realised = clone(h.seq.audioTracks);
		expect(trackVol(h, 'A2', 120 * F30 - 0.1 * S)).toBeCloseTo(-24, 6);
		const beforeMute = h.doc;
		h.ok([{ type: 'soundCue.update', cueId: cue, muted: true }]);
		expect(noIds(h.seq.audioTracks.map((t) => t.volumeDb ?? null))).toEqual(
			noIds(pre.map((t) => t.volumeDb ?? null)),
		);
		const rec = sd(h)!.mix!.cues![cue]!.stopBefore as {
			suspended?: boolean;
			writes: unknown[];
			ambience?: boolean;
		};
		expect(rec).toMatchObject({ suspended: true, writes: [], ambience: true });
		const muted = clone(h.doc.sequences);
		h.ok([{ type: 'soundCue.update', cueId: cue, muted: false }]);
		expect(noIds(h.seq.audioTracks)).toEqual(noIds(realised));
		// undo / redo: each edit is pure (the document before is untouched), and applying it again from the same
		// document gives the same document (up to fresh ids)
		const afterUnmute = h.doc;
		const unmuted = clone(h.doc.sequences);
		h.doc = beforeMute;
		h.ok([{ type: 'soundCue.update', cueId: cue, muted: true }]);
		expect(noIds(h.doc.sequences)).toEqual(noIds(muted));
		h.ok([{ type: 'soundCue.update', cueId: cue, muted: false }]);
		expect(noIds(h.doc.sequences)).toEqual(noIds(unmuted));
		expect(noIds(afterUnmute.sequences)).toEqual(noIds(unmuted));
		h.doc = afterUnmute;
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('an unfilled cue applied by hand comes back after unmuting', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const cue = heroCue(h, 120, { stopBefore: SB });
		h.ok([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		const realised = clone(track(h, 'A1').volumeDb);
		h.ok([{ type: 'soundCue.update', cueId: cue, muted: true }]);
		expect(track(h, 'A1').volumeDb?.keyframes ?? []).toEqual([]);
		h.ok([{ type: 'soundCue.update', cueId: cue, muted: false }]);
		expect(noIds(track(h, 'A1').volumeDb)).toEqual(noIds(realised));
	});
});

describe('bug 9: Auto gain on owns the gain again', () => {
	it('on after a manual gain change sets the recorded level; a clip without a level is skipped', () => {
		const h = new Harness();
		const m = libMedia(h);
		const pr = h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] }]);
		const a = (pr.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		const level = clipOf(h, a).sfx!.level!.gainDb;
		h.ok([{ type: 'audio.setGain', clipIds: [a], mode: 'set', db: 2 }]);
		expect(sfxGainOwner(clipOf(h, a))).toBe('user');
		const r = h.ok([{ type: 'soundDesign.setAutoGain', clipIds: [a], auto: true }]);
		expect(r.results[0]).toEqual({ clips: [{ clipId: a, owner: 'default' }] });
		expect(clipOf(h, a).gainDb).toBe(level);
	});
});

describe('bug 10: builds near the sequence start', () => {
	it('never write keys at negative times', () => {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'music');
		const cue = heroCue(h, 30, { build: BUILD });
		h.ok([{ type: 'soundDesign.applyBuild', cueId: cue }]);
		const cut = track(h, 'A1').effects![0]!.params.cutoff as Animatable<number>;
		expect(Math.min(...cut.keyframes.map((k) => k.time))).toBeGreaterThanOrEqual(0);
		expect(evaluate(cut, 30 * F30 - F30)).toBeCloseTo(2000, 4);
	});
});

describe('bug 11: room glue exactness', () => {
	function setup() {
		const h = new Harness();
		addAudio(h, 0, 'A1', 'dialogue', 10);
		h.ok([{ type: 'track.add', kind: 'audio', count: 1 }]);
		addAudio(h, 60, 'A2', 'sfx', 1);
		return h;
	}
	it('removeBus gives back the document before ensureBus', () => {
		const h = setup();
		expect(h.seq.soundDesign).toBeUndefined();
		const before = clone(h.doc.sequences);
		h.ok([{ type: 'soundDesign.ensureBus' }]);
		h.ok([{ type: 'soundDesign.removeBus' }]);
		expect(clone(h.doc.sequences)).toEqual(before);
	});
	it('ensureBus again keeps hand-tuned send levels and send automation; a retargeted send stays on removeBus', () => {
		const h = setup();
		h.ok([{ type: 'soundDesign.ensureBus' }]);
		const send = track(h, 'A2').mixer!.sends![0]!;
		h.ok([{ type: 'mixer.updateSend', stripId: 'A2', sendId: send.id, patch: { levelDb: -9 } }]);
		h.ok([{ type: 'soundDesign.ensureBus' }]);
		expect((track(h, 'A2').mixer!.sends![0]!.levelDb as Animatable<number>).value).toBe(-9);
		const auto = {
			value: -16,
			keyframes: [key(h.ids.next('kf'), 1 * S, -16), key(h.ids.next('kf'), 2 * S, -6)],
		};
		h.ok([{ type: 'mixer.updateSend', stripId: 'A2', sendId: send.id, patch: { levelDb: auto } }]);
		h.ok([{ type: 'soundDesign.ensureBus', roomGlue: { sendDb: -12 } }]);
		expect((track(h, 'A2').mixer!.sends![0]!.levelDb as Animatable<number>).keyframes).toHaveLength(2);
		// retargeted by hand to another submix: removeBus leaves it
		h.ok([{ type: 'mixer.addSubmix', name: 'Other', channelFormat: 'stereo' }]);
		const other = h.seq.submixTracks!.find((t) => t.name === 'Other')!.id;
		h.ok([{ type: 'mixer.updateSend', stripId: 'A2', sendId: send.id, patch: { target: other } }]);
		h.ok([{ type: 'soundDesign.removeBus' }]);
		expect(track(h, 'A2').mixer!.sends!.map((s) => s.target)).toEqual([other]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('bug 12: delivery ducking depth', () => {
	it('a type-default ducking depth is set by the delivery (music 14 LU under the voice); a user depth is kept', () => {
		const h = new Harness();
		const dlg = addAudio(h, 0, 'A1', 'dialogue', 10);
		const music = addAudio(h, 0, 'A2', 'music', 20);
		const amb = addAudio(h, 0, 'A3', 'ambience', 20);
		h.ok([{ type: 'essentialSound.set', clipIds: [amb], values: { 'ducking.reduceDb': -12 } }]);
		const r = h.ok([
			{
				type: 'soundDesign.applyDelivery',
				delivery: 'broadcast-r128',
				loudness: false,
				measuredLufs: { [dlg]: -23, [music]: -31, [amb]: -33 },
				ducking: [{ clipIds: [music, amb], regions: [[1 * S, 4 * S]] }],
			},
		]);
		void r;
		expect(clipVol(h, music, 2.5 * S)).toBeCloseTo(-6, 6);
		expect(clipVol(h, amb, 2.5 * S)).toBeCloseTo(-12, 6);
		const es = (clipOf(h, music) as { essential?: { ducking?: { reduceDb?: number; depthBy?: string } } })
			.essential!.ducking!;
		expect(es).toMatchObject({ reduceDb: -6, depthBy: 'delivery' });
	});
});

describe('applyGains on a manual (Auto gain off) clip', () => {
	it('is skipped unless override is set', () => {
		const h = new Harness();
		const m = libMedia(h);
		const pr = h.ok([{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId: m }] }]);
		const a = (pr.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		h.ok([{ type: 'soundDesign.setAutoGain', clipIds: [a], auto: false }]);
		const g = clipOf(h, a).gainDb;
		const r = h.ok([{ type: 'soundDesign.applyGains', gains: { [a]: -9 } }]);
		expect(clipOf(h, a).gainDb).toBe(g);
		expect(r.results[0]).toMatchObject({ clips: [], skipped: [{ clipId: a }] });
		h.ok([{ type: 'soundDesign.applyGains', gains: { [a]: -9 }, override: true }]);
		expect(clipOf(h, a).gainDb).toBe(-9);
	});
});
