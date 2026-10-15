// soundDesign.place / swap / setPalette / setSettings (spec 12 §2.3, §2.9; P2-R2, P2-R4, P2-R5): peak-exact placement
// of padded library sounds, layers, pitch, pan, auto tracks, refusals, undo / redo.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	ALLOWED_SEQUENCE_RATES,
	type AudioClip,
	type ClipSfx,
	checkInvariants,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type LibraryProvenance,
	pickVariant,
	type Rational,
	type SoundDesign,
	variationOf,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

type SfxClip = AudioClip & { sfx?: ClipSfx };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** The document as JSON with ids numbered in order of appearance (redo makes the same edit with fresh ids). */
function normalizeIds(doc: unknown): string {
	const map = new Map<string, string>();
	return JSON.stringify(doc).replace(/\b([a-z]{2,3})_[0-9A-Z]{16}\b/g, (id, p) => {
		if (!map.has(id)) map.set(id, `${p}#${map.size}`);
		return map.get(id)!;
	});
}

let n = 0;
/** A registered library sound: padded with 50 ms of lead silence (its descriptors include it). */
function libMedia(
	h: Harness,
	o: {
		peakSec?: number;
		onsetSec?: number;
		durationSec?: number;
		types?: string[];
		headQuietSec?: number;
	} = {},
): string {
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
			onsetSec: o.onsetSec ?? 0.06,
			headQuietSec: o.headQuietSec ?? 0.05,
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

/** Sequence flicks at which a placed clip's aligned point plays. */
function alignedAt(c: SfxClip, F: number): number {
	return c.start * F + (c.sfx!.placement.peakFlicks - c.sourceIn) / c.speed.rate;
}

function err(r: ReturnType<Harness['tx']>) {
	return r.ok ? null : r.errors[0]!;
}

function addCue(h: Harness, cue: Record<string, unknown>): string {
	const r = h.ok([
		{ type: 'soundCue.add', cues: [{ kind: 'land', weight: 'hero', source: 'user', ...cue }] },
	]);
	return (r.results[0] as { cueIds: string[] }).cueIds[0]!;
}

describe('soundDesign.place', () => {
	it('places a padded library sound with its peak exactly on the frame, as SFX on a new "SFX 1" track; undo / redo', () => {
		const h = new Harness();
		const m = libMedia(h);
		const before = h.doc;
		const snapshot = clone(before);
		const r = h.ok([{ type: 'soundDesign.place', frame: 45, layers: [{ mediaId: m }] }]);
		const res = r.results[0] as { clips: { clipId: string; errorFlicks: number; trackCreated: boolean }[] };
		const c = clip(h, res.clips[0]!.clipId);
		const F = flicksPerFrame(h.seq.settings.frameRate);
		expect(alignedAt(c, F)).toBeCloseTo(45 * F, 0);
		expect(Math.abs(alignedAt(c, F) - 45 * F)).toBeLessThanOrEqual(1);
		expect(res.clips[0]!.errorFlicks).toBe(0);
		expect(res.clips[0]!.trackCreated).toBe(true);
		const track = h.seq.audioTracks.find((t) => t.id === c.trackId)!;
		expect(track.name).toBe('SFX 1');
		expect((c.essential as { type?: string }).type).toBe('sfx');
		expect(c.sfx).toEqual({
			cueId: null,
			soundId: (h.doc.media[m]!.library as LibraryProvenance).soundId,
			layer: 0,
			role: 'support',
			placement: { align: 'peak', peakFlicks: Math.round(0.0705 * FLICKS_PER_SECOND), errorFlicks: 0 },
		});
		expect(checkInvariants(h.doc)).toEqual([]);
		// undo = the untouched document; redo = the same transaction gives the same document
		expect(before).toEqual(snapshot);
		const after = h.doc;
		h.doc = before;
		h.ok([{ type: 'soundDesign.place', frame: 45, layers: [{ mediaId: m }] }]);
		expect(normalizeIds(h.doc)).toEqual(normalizeIds(after));
	});

	it('fills a cue with three layers: peaks on the cue frame, separate SFX tracks, grouped, cue links both ways', () => {
		const h = new Harness();
		const ms = [libMedia(h), libMedia(h, { peakSec: 0.12, durationSec: 1.2 }), libMedia(h, { peakSec: 0.3 })];
		const cueId = addCue(h, { frame: 90, pitchSt: 0 });
		const r = h.ok([
			{
				type: 'soundDesign.place',
				cueId,
				layers: ms.map((mediaId) => ({ mediaId })),
				alternatives: ['snd_00000000000000aa'],
			},
		]);
		const res = r.results[0] as {
			groupId: string;
			clips: { clipId: string; role: string; trackId: string }[];
		};
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const tracks = new Set(res.clips.map((c) => c.trackId));
		expect(tracks.size).toBe(3);
		expect(res.clips.map((c) => c.role)).toEqual(['hero', 'layer', 'layer']);
		for (const { clipId } of res.clips) {
			const c = clip(h, clipId);
			expect(Math.abs(alignedAt(c, F) - 90 * F)).toBeLessThanOrEqual(1);
			expect(c.groupId).toBe(res.groupId);
			expect(c.sfx!.cueId).toBe(cueId);
		}
		expect(clip(h, res.clips[0]!.clipId).sfx!.alternatives).toEqual(['snd_00000000000000aa']);
		const cue = (h.seq.soundDesign as SoundDesign).cues[cueId]!;
		expect(cue.placedClipIds).toEqual(res.clips.map((c) => c.clipId));
		expect(cue.soundIds).toEqual(ms.map((m) => (h.doc.media[m]!.library as LibraryProvenance).soundId));
		expect([...h.seq.groups[res.groupId]!.members].sort()).toEqual(res.clips.map((c) => c.clipId).sort());
		// a cue holds at most 6 layers
		const more = h.tx([
			{ type: 'soundDesign.place', cueId, layers: [1, 2, 3, 4].map(() => ({ mediaId: ms[0] })) },
		]);
		expect(err(more)?.code).toBe('E_INVALID_PARAM');
	});

	it('auto never overwrites: the next free SFX track, then a new one; explicit tracks are refused when busy', () => {
		const h = new Harness();
		const m = libMedia(h);
		const first = h.ok([{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: m }] }]);
		const t1 = (first.results[0] as { clips: { trackId: string }[] }).clips[0]!.trackId;
		const second = h.ok([{ type: 'soundDesign.place', frame: 31, layers: [{ mediaId: m }] }]);
		const t2 = (second.results[0] as { clips: { trackId: string; trackCreated: boolean }[] }).clips[0]!;
		expect(t2.trackId).not.toBe(t1);
		expect(t2.trackCreated).toBe(true);
		// later in time the first SFX track is free again
		const third = h.ok([{ type: 'soundDesign.place', frame: 300, layers: [{ mediaId: m }] }]);
		expect((third.results[0] as { clips: { trackId: string }[] }).clips[0]!.trackId).toBe(t1);
		// preferTrackIds wins when free (the drop target)
		const fourth = h.ok([
			{ type: 'soundDesign.place', frame: 500, layers: [{ mediaId: m }], preferTrackIds: ['A2'] },
		]);
		expect((fourth.results[0] as { clips: { trackId: string }[] }).clips[0]!.trackId).toBe(
			h.seq.audioTracks[1]!.id,
		);
		// explicit: busy → E_OVERLAP with the blocking clip, video → E_TRACK_KIND, missing → E_NOT_FOUND, locked
		const busy = err(h.tx([{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: m, track: t1 }] }]));
		expect(busy?.code).toBe('E_OVERLAP');
		expect(busy?.blocking?.length).toBe(1);
		expect(
			err(h.tx([{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: m, track: 'V1' }] }]))?.code,
		).toBe('E_TRACK_KIND');
		expect(
			err(h.tx([{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: m, track: 'A9' }] }]))?.code,
		).toBe('E_NOT_FOUND');
		h.ok([{ type: 'track.update', trackId: 'A1', patch: { locked: true } }]);
		expect(
			err(h.tx([{ type: 'soundDesign.place', frame: 700, layers: [{ mediaId: m, track: 'A1' }] }]))?.code,
		).toBe('E_TRACK_LOCKED');
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refuses impossible placements with typed errors and changes nothing', () => {
		const h = new Harness();
		const m = libMedia(h, { peakSec: 0.5, durationSec: 1 });
		const plain = h.registerVideo({ kind: 'audio', seconds: 2 });
		const still = h.registerVideo({ kind: 'image' });
		const doc = h.doc;
		const cases: [unknown, string][] = [
			// the peak 0.5 s in, aligned at frame 3: it would start before frame 0
			[{ type: 'soundDesign.place', frame: 3, layers: [{ mediaId: m }] }, 'E_INVALID_PARAM'],
			[
				{ type: 'soundDesign.place', frame: 3, cueId: 'cue_0000000000000001', layers: [{ mediaId: m }] },
				'E_INVALID_PARAM',
			],
			[{ type: 'soundDesign.place', layers: [{ mediaId: m }] }, 'E_INVALID_PARAM'],
			// project audio has no peak: align it by its start or end
			[{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: plain }] }, 'E_INVALID_PARAM'],
			[{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: still }] }, 'E_INVALID_PARAM'],
			[
				{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: 'med_0000000000000099' }] },
				'E_NOT_FOUND',
			],
			[{ type: 'soundDesign.place', cueId: 'cue_0000000000000099', layers: [{ mediaId: m }] }, 'E_NOT_FOUND'],
			[{ type: 'soundDesign.place', frame: 30, layers: [] }, 'E_SCHEMA'],
			[{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: m, pitchSt: 13 }] }, 'E_SCHEMA'],
			[{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: m, nope: 1 }] }, 'E_SCHEMA'],
			[
				{
					type: 'soundDesign.place',
					frame: 30,
					layers: [
						{
							mediaId: m,
							pan: {
								keyframes: [
									{ offset: 2, value: 0 },
									{ offset: 1, value: 10 },
								],
							},
						},
					],
				},
				'E_INVALID_PARAM',
			],
		];
		for (const [c, code] of cases) {
			const r = h.tx([c]);
			expect(err(r)?.code, JSON.stringify(c)).toBe(code);
			expect(h.doc).toBe(doc);
		}
		// clampStart starts it at 0 and trims the head: the peak still lands on frame 3
		const ok = h.ok([{ type: 'soundDesign.place', frame: 3, clampStart: true, layers: [{ mediaId: m }] }]);
		const c = clip(h, (ok.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId);
		expect(c.start).toBe(0);
		expect(
			Math.abs(
				alignedAt(c, flicksPerFrame(h.seq.settings.frameRate)) - 3 * flicksPerFrame(h.seq.settings.frameRate),
			),
		).toBeLessThanOrEqual(1);
		// project audio aligned by its start (sourceIn 0, exact on a frame)
		const s = h.ok([{ type: 'soundDesign.place', frame: 60, layers: [{ mediaId: plain, align: 'start' }] }]);
		const pc = clip(h, (s.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId);
		expect(pc.start).toBe(60);
		expect(pc.sfx!.soundId).toBeNull();
	});

	it('pitch: ±3 semitones by varispeed (peak still exact), larger shifts by the Pitch Shifter; rate variation', () => {
		const h = new Harness({ preset: 'hd-1080p-23.976' });
		const m = libMedia(h);
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const r = h.ok([
			{
				type: 'soundDesign.place',
				frame: 100,
				layers: [
					{ mediaId: m, pitchSt: 2 },
					{ mediaId: m, pitchSt: -5.5 },
					{ mediaId: m, rate: 1.02, gainDb: -0.7 },
				],
				group: false,
			},
		]);
		const [a, b, c] = (
			r.results[0] as { clips: { clipId: string; errorFlicks: number }[]; groupId: null }
		).clips.map((x) => clip(h, x.clipId));
		expect(a!.speed.rate).toBeCloseTo(2 ** (2 / 12), 12);
		expect(a!.speed.maintainPitch).toBe(false);
		expect(a!.effects.some((fx) => fx.effectId === 'jasper.audio.pitch-shifter')).toBe(false);
		expect(b!.speed.rate).toBe(1);
		const shifter = b!.effects.find((fx) => fx.effectId === 'jasper.audio.pitch-shifter')!;
		expect(shifter.params.semitones!.value).toBe(-5);
		expect(shifter.params.cents!.value).toBe(-50);
		expect(c!.speed.rate).toBe(1.02);
		expect(c!.gainDb).toBe(-0.7);
		for (const x of [a!, b!, c!]) {
			expect(Math.abs(alignedAt(x, F) - 100 * F)).toBeLessThanOrEqual(1);
			expect(x.sfx!.placement.errorFlicks).toBe(0);
			expect(x.groupId).toBeNull();
		}
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('pan: static from the layer or the cue; keyframes relative to the cue frame (a whoosh sweep)', () => {
		const h = new Harness();
		const m = libMedia(h, { types: ['whoosh'], durationSec: 1, peakSec: 0.4 });
		const cueId = addCue(h, { frame: 60, pan: -40 });
		const r = h.ok([{ type: 'soundDesign.place', cueId, layers: [{ mediaId: m }] }]);
		const a = clip(h, (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId);
		expect(a.pan).toEqual({ value: -40, keyframes: [] });
		const r2 = h.ok([
			{
				type: 'soundDesign.place',
				frame: 200,
				layers: [
					{
						mediaId: m,
						pan: {
							keyframes: [
								{ offset: -6, value: -60 },
								{ offset: 6, value: 60 },
							],
						},
					},
				],
			},
		]);
		const b = clip(h, (r2.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId);
		const F = flicksPerFrame(h.seq.settings.frameRate);
		expect(b.pan.keyframes.map((k) => k.value)).toEqual([-60, 60]);
		expect(b.pan.keyframes.map((k) => Math.round((b.start * F + k.time - b.sourceIn) / F))).toEqual([
			194, 206,
		]);
	});

	it('peak placement is exact for every sequence rate and sample-position peak (property)', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...ALLOWED_SEQUENCE_RATES),
				fc.integer({ min: 60, max: 5000 }),
				fc.integer({ min: 0, max: 40_000 }),
				fc.constantFrom(-2, 0, 1, 3),
				(fps: Rational, cue, peakSample, pitch) => {
					const h = new Harness();
					h.ok([{ type: 'sequence.updateSettings', sequenceId: h.seqId, settings: { frameRate: fps } }]);
					// padded: the peak is 50 ms + a sample position in, the head is quiet for the 50 ms
					const peakSec = 0.05 + peakSample / 48000;
					const m = libMedia(h, { peakSec, durationSec: peakSec + 0.5 });
					const r = h.tx([
						{ type: 'soundDesign.place', frame: cue, layers: [{ mediaId: m, pitchSt: pitch }] },
					]);
					expect(r.ok).toBe(true);
					if (!r.ok) return;
					const c = clip(h, (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId);
					const F = flicksPerFrame(h.seq.settings.frameRate);
					expect(c.sourceIn).toBeGreaterThanOrEqual(0);
					// exact to the flick (varispeed rounding: ≤ 1 flick, 1/14 700 of a 48 kHz sample)
					expect(c.sfx!.placement.errorFlicks).toBeLessThanOrEqual(pitch === 0 ? 0 : 1);
					expect(Math.abs(alignedAt(c, F) - cue * F)).toBeLessThanOrEqual(1);
				},
			),
			{ numRuns: 150 },
		);
	});
});

describe('soundDesign.swap', () => {
	it('keeps the aligned frame, track, gain, pan, group and cue link; updates the sound; undo / redo', () => {
		const h = new Harness();
		const a = libMedia(h);
		const b = libMedia(h, { peakSec: 0.25, durationSec: 0.9 });
		const cueId = addCue(h, { frame: 120 });
		const r = h.ok([
			{ type: 'soundDesign.place', cueId, layers: [{ mediaId: a, gainDb: -3, pan: 20 }, { mediaId: a }] },
		]);
		const ids = (r.results[0] as { clips: { clipId: string }[] }).clips.map((c) => c.clipId);
		const old = clone(clip(h, ids[0]!));
		const before = h.doc;
		const s = h.ok([{ type: 'soundDesign.swap', clipId: ids[0], mediaId: b }]);
		const c = clip(h, ids[0]!);
		const F = flicksPerFrame(h.seq.settings.frameRate);
		expect(Math.abs(alignedAt(c, F) - 120 * F)).toBeLessThanOrEqual(1);
		expect(c.mediaId).toBe(b);
		expect(c.trackId).toBe(old.trackId);
		expect(c.gainDb).toBe(-3);
		expect(c.pan.value).toBe(20);
		expect(c.groupId).toBe(old.groupId);
		expect(c.sfx!.cueId).toBe(cueId);
		expect(c.sfx!.role).toBe('hero');
		expect(c.sfx!.soundId).toBe((h.doc.media[b]!.library as LibraryProvenance).soundId);
		expect((s.results[0] as { alignedFrame: number }).alignedFrame).toBe(120);
		expect((h.seq.soundDesign as SoundDesign).cues[cueId]!.soundIds![0]).toBe(c.sfx!.soundId);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before.sequences[h.seqId]!.clips[ids[0]!]).toEqual(old);
		// refusals
		expect(err(h.tx([{ type: 'soundDesign.swap', clipId: 'clp_0000000000000999', mediaId: b }]))?.code).toBe(
			'E_NOT_FOUND',
		);
		expect(
			err(h.tx([{ type: 'soundDesign.swap', clipId: ids[0], mediaId: 'med_0000000000000999' }]))?.code,
		).toBe('E_NOT_FOUND');
		const long = libMedia(h, { peakSec: 0.06, durationSec: 30 });
		h.ok([{ type: 'soundDesign.place', frame: 200, layers: [{ mediaId: a, track: c.trackId }] }]);
		expect(err(h.tx([{ type: 'soundDesign.swap', clipId: ids[0], mediaId: long }]))?.code).toBe('E_OVERLAP');
		h.ok([{ type: 'track.update', trackId: c.trackId, patch: { locked: true } }]);
		expect(err(h.tx([{ type: 'soundDesign.swap', clipId: ids[0], mediaId: a }]))?.code).toBe(
			'E_TRACK_LOCKED',
		);
	});

	it('pan keyframes keep their sequence times when the In point changes', () => {
		const h = new Harness();
		const a = libMedia(h, { types: ['whoosh'], peakSec: 0.3, durationSec: 1 });
		const b = libMedia(h, { types: ['whoosh'], peakSec: 0.6, durationSec: 1.4 });
		const r = h.ok([
			{
				type: 'soundDesign.place',
				frame: 90,
				layers: [
					{
						mediaId: a,
						pan: {
							keyframes: [
								{ offset: -3, value: -50 },
								{ offset: 3, value: 50 },
							],
						},
					},
				],
			},
		]);
		const id = (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const seqTimes = () => {
			const c = clip(h, id);
			return c.pan.keyframes.map((k) => c.start * F + (k.time - c.sourceIn) / c.speed.rate);
		};
		const t0 = seqTimes();
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: b }]);
		const t1 = seqTimes();
		for (const [i, t] of t1.entries()) expect(Math.abs(t - t0[i]!)).toBeLessThanOrEqual(1);
	});
});

describe('soundDesign.swap alternatives (the variation ring of stateless cycling)', () => {
	it('stores the ring on a clip placed without one (deduplicated); undo; bad ids are refused', () => {
		const h = new Harness();
		const a = libMedia(h);
		const b = libMedia(h, { peakSec: 0.2, durationSec: 0.8 });
		const r = h.ok([{ type: 'soundDesign.place', frame: 60, layers: [{ mediaId: a }] }]);
		const id = (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		expect(clip(h, id).sfx!.alternatives).toBeUndefined();
		const original = clip(h, id).sfx!.soundId!;
		const before = h.doc;
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: b, alternatives: [original, original] }]);
		expect(clip(h, id).sfx!.alternatives).toEqual([original]);
		expect(clip(h, id).mediaId).toBe(b);
		expect(checkInvariants(h.doc)).toEqual([]);
		// undo = the untouched document
		expect((before.sequences[h.seqId]!.clips[id] as SfxClip).sfx!.alternatives).toBeUndefined();
		h.doc = before;
		// without alternatives the ring is kept as it is
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: b, alternatives: [original] }]);
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: a }]);
		expect(clip(h, id).sfx!.alternatives).toEqual([original]);
		expect(
			err(h.tx([{ type: 'soundDesign.swap', clipId: id, mediaId: b, alternatives: ['nope'] }]))?.code,
		).toBe('E_SCHEMA');
		expect(err(h.tx([{ type: 'soundDesign.swap', clipId: id, mediaId: b, alternatives: [] }]))?.code).toBe(
			'E_SCHEMA',
		);
	});
});

describe('soundDesign.swap with frame (re-align: MCP align_peak)', () => {
	it('lands the aligned point exactly on the new frame at every rate; pan keyframes travel with it; undo / redo; refusals', () => {
		for (const fps of ALLOWED_SEQUENCE_RATES) {
			const h = new Harness();
			h.ok([{ type: 'sequence.updateSettings', sequenceId: h.seqId, settings: { frameRate: fps } }]);
			const a = libMedia(h, { types: ['whoosh'], peakSec: 0.3123, durationSec: 1.1 });
			const r = h.ok([
				{
					type: 'soundDesign.place',
					frame: 90,
					layers: [
						{
							mediaId: a,
							gainDb: -4,
							pan: {
								keyframes: [
									{ offset: -3, value: -50 },
									{ offset: 3, value: 50 },
								],
							},
						},
					],
				},
			]);
			const id = (r.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
			const F = flicksPerFrame(h.seq.settings.frameRate);
			const panTimes = () => {
				const c = clip(h, id);
				return c.pan.keyframes.map((k) => c.start * F + (k.time - c.sourceIn) / c.speed.rate);
			};
			const t0 = panTimes();
			const before = h.doc;
			const snapshot = clone(before);
			const s = h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: a, frame: 137 }]);
			const c = clip(h, id);
			expect(Math.abs(alignedAt(c, F) - 137 * F), `fps ${fps.num}/${fps.den}`).toBeLessThanOrEqual(1);
			expect(c.sfx!.placement.errorFlicks).toBe(0);
			expect((s.results[0] as { alignedFrame: number }).alignedFrame).toBe(137);
			expect(c.gainDb).toBe(-4);
			// the sweep travels with the sound: 47 frames later
			for (const [i, t] of panTimes().entries())
				expect(Math.abs(t - (t0[i]! + 47 * F))).toBeLessThanOrEqual(1);
			expect(checkInvariants(h.doc)).toEqual([]);
			expect(before).toEqual(snapshot);
			const after = h.doc;
			h.doc = before;
			h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: a, frame: 137 }]);
			expect(normalizeIds(h.doc)).toEqual(normalizeIds(after));
			// refusals: before 0 (the sound would start before the sequence), a busy span on its track
			expect(err(h.tx([{ type: 'soundDesign.swap', clipId: id, mediaId: a, frame: 2 }]))?.code).toBe(
				'E_INVALID_PARAM',
			);
			expect(err(h.tx([{ type: 'soundDesign.swap', clipId: id, mediaId: a, frame: -5 }]))?.code).toBe(
				'E_INVALID_PARAM',
			);
			h.ok([{ type: 'soundDesign.place', frame: 300, layers: [{ mediaId: a, track: c.trackId }] }]);
			expect(err(h.tx([{ type: 'soundDesign.swap', clipId: id, mediaId: a, frame: 300 }]))?.code).toBe(
				'E_OVERLAP',
			);
		}
	});
});

describe('soundDesign.setPalette / setSettings', () => {
	it('replace, add and remove palette sounds; settings with read-time defaults; refusals', () => {
		const h = new Harness();
		const s1 = 'snd_0000000000000001';
		const s2 = 'snd_0000000000000002';
		const s3 = 'snd_0000000000000003';
		expect(h.seq.soundDesign).toBeUndefined();
		const before = h.doc;
		h.ok([{ type: 'soundDesign.setPalette', soundIds: [s1, s2, s1] }]);
		expect((h.seq.soundDesign as SoundDesign).settings!.palette).toEqual([s1, s2]);
		expect((h.seq.soundDesign as SoundDesign).settings!.density).toBe('balanced');
		h.ok([{ type: 'soundDesign.setPalette', soundIds: [s3, s1], mode: 'add' }]);
		expect((h.seq.soundDesign as SoundDesign).settings!.palette).toEqual([s2, s3, s1]);
		h.ok([{ type: 'soundDesign.setPalette', soundIds: [s2], mode: 'remove' }]);
		expect((h.seq.soundDesign as SoundDesign).settings!.palette).toEqual([s3, s1]);
		expect(before.sequences[h.seqId]!.soundDesign).toBeUndefined();
		expect(err(h.tx([{ type: 'soundDesign.setPalette', soundIds: ['bad'] }]))?.code).toBe('E_SCHEMA');

		h.ok([{ type: 'mixer.addSubmix', name: 'Room' }]);
		const r = h.ok([
			{
				type: 'soundDesign.setSettings',
				delivery: 'podcast',
				density: 'sparse',
				sfxTrackIds: ['A2', 'A2'],
				roomBus: 'S1',
				seed: 7,
				agentsMayApply: true,
			},
		]);
		const s = (h.seq.soundDesign as SoundDesign).settings!;
		expect(s).toMatchObject({
			delivery: 'podcast',
			density: 'sparse',
			sfxTrackIds: [h.seq.audioTracks[1]!.id],
			roomBus: h.seq.submixTracks![0]!.id,
			seed: 7,
			agentsMayApply: true,
			palette: [s3, s1],
		});
		expect((r.results[0] as { settings: unknown }).settings).toEqual(s);
		expect(err(h.tx([{ type: 'soundDesign.setSettings', sfxTrackIds: ['V1'] }]))?.code).toBe('E_TRACK_KIND');
		expect(err(h.tx([{ type: 'soundDesign.setSettings', sfxTrackIds: ['A42'] }]))?.code).toBe('E_NOT_FOUND');
		expect(err(h.tx([{ type: 'soundDesign.setSettings', roomBus: 'S9' }]))?.code).toBe('E_NOT_FOUND');
		expect(err(h.tx([{ type: 'soundDesign.setSettings', density: 'dense' }]))?.code).toBe('E_SCHEMA');
		expect(err(h.tx([{ type: 'soundDesign.setSettings', sequenceId: 'seq_0000000000000999' }]))?.code).toBe(
			'E_NOT_FOUND',
		);
		// auto placement prefers the sound design's own tracks
		const m = libMedia(h);
		const p = h.ok([{ type: 'soundDesign.place', frame: 50, layers: [{ mediaId: m }] }]);
		expect((p.results[0] as { clips: { trackId: string }[] }).clips[0]!.trackId).toBe(
			h.seq.audioTracks[1]!.id,
		);
	});
});

describe('pickVariant (rotation and variation)', () => {
	const c = ['snd_a', 'snd_b', 'snd_c', 'snd_d', 'snd_e'];
	it('round-robins over the top N, least recently used first, never the same file twice in a row', () => {
		const ctx = { seed: 1, cueId: 'cue_1' };
		expect(pickVariant(c, ctx)!.soundId).toBe('snd_a');
		expect(pickVariant(c, { ...ctx, recentSoundIds: ['snd_a'] })!.soundId).toBe('snd_b');
		expect(pickVariant(c, { ...ctx, recentSoundIds: ['snd_b', 'snd_a'] })!.soundId).toBe('snd_c');
		expect(pickVariant(c, { ...ctx, recentSoundIds: ['snd_d', 'snd_c', 'snd_b', 'snd_a'] })!.soundId).toBe(
			'snd_a',
		);
		// the 5th candidate is outside the default top 4
		expect(pickVariant(c, { ...ctx, recentSoundIds: ['snd_a', 'snd_d', 'snd_c', 'snd_b'] })!.soundId).toBe(
			'snd_b',
		);
		expect(
			pickVariant(c, { ...ctx, topN: 5, recentSoundIds: ['snd_a', 'snd_d', 'snd_c', 'snd_b'] })!.soundId,
		).toBe('snd_e');
		expect(pickVariant(['snd_a'], { ...ctx, recentSoundIds: ['snd_a'] })).toMatchObject({
			soundId: 'snd_a',
			repeated: true,
		});
		expect(pickVariant([], ctx)).toBeNull();
		expect(pickVariant(null as never, ctx)).toBeNull();
	});
	it('is deterministic; ±2 % speed and ±1 dB gain seeded by sequence, cue, seed and layer (property)', () => {
		fc.assert(
			fc.property(
				fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 10 }),
				fc.array(fc.string({ maxLength: 6 }), { maxLength: 10 }),
				fc.integer(),
				fc.string(),
				fc.string(),
				fc.integer({ min: 0, max: 5 }),
				(cands, recent, seed, cueId, sequenceId, layer) => {
					const ctx = { seed, cueId, sequenceId, layer, recentSoundIds: recent };
					const a = pickVariant(cands, ctx);
					expect(pickVariant(cands, ctx)).toEqual(a);
					expect(a === null).toBe(cands.length === 0);
					if (!a) return;
					expect(cands).toContain(a.soundId);
					if (new Set(cands.slice(0, 4)).size > 1) expect(a.soundId).not.toBe(recent[0] ?? '\u0000');
					expect(a.rate).toBeGreaterThanOrEqual(0.98);
					expect(a.rate).toBeLessThanOrEqual(1.02);
					expect(Math.abs(a.gainDb)).toBeLessThanOrEqual(1);
				},
			),
			{ numRuns: 500 },
		);
		const v = new Set(Array.from({ length: 50 }, (_, i) => variationOf({ seed: i, cueId: 'cue_x' }).rate));
		expect(v.size).toBeGreaterThan(30);
	});
});

describe('pan sweep of a derived cue (WP2.2 panSweep)', () => {
	it('a cue’s panSweep becomes pan keyframes over its window; soundCue.update clears it', () => {
		const h = new Harness();
		const m = libMedia(h, { types: ['whoosh'], durationSec: 1, peakSec: 0.4 });
		const r = h.ok([
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 180,
						kind: 'transition',
						weight: 'support',
						source: 'derived',
						pan: 0,
						panSweep: { from: -60, to: 60 },
						window: { start: 170, end: 190 },
						ref: '$c',
					},
				],
			},
			{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: m }] },
		]);
		const cueId = r.refs.$c!;
		expect((h.seq.soundDesign as SoundDesign).cues[cueId]!.panSweep).toEqual({ from: -60, to: 60 });
		const c = clip(h, (r.results[1] as { clips: { clipId: string }[] }).clips[0]!.clipId);
		const F = flicksPerFrame(h.seq.settings.frameRate);
		expect(c.pan.keyframes.map((k) => k.value)).toEqual([-60, 60]);
		expect(c.pan.keyframes.map((k) => Math.round(c.start + (k.time - c.sourceIn) / F))).toEqual([170, 190]);
		// a window reaching before the sound's media starts holds the first key at the media start
		const r2 = h.ok([
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 400,
						kind: 'move',
						weight: 'support',
						source: 'derived',
						panSweep: { from: 50, to: -50 },
						window: { start: 300, end: 410 },
						ref: '$d',
					},
				],
			},
			{ type: 'soundDesign.place', cueId: '$d', layers: [{ mediaId: m }] },
		]);
		const d = clip(h, (r2.results[1] as { clips: { clipId: string }[] }).clips[0]!.clipId);
		expect(d.pan.keyframes[0]!.time).toBe(0);
		expect(checkInvariants(h.doc)).toEqual([]);
		h.ok([{ type: 'soundCue.update', cueId, panSweep: null }]);
		expect('panSweep' in (h.seq.soundDesign as SoundDesign).cues[cueId]!).toBe(false);
	});
});
