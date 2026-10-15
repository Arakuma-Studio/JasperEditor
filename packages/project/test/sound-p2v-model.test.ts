// Sound Design Phase 2 model review (spec 12 §2.2, §2.3, §2.9; P2-R1…R5): regression tests for the bugs the
// verification review found (each failed before its fix) and the coverage gaps it filled.
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	type ClipSfx,
	checkInvariants,
	createCounterIdSource,
	flicksPerFrame,
	type LibraryProvenance,
	loadProject,
	type ProjectDocument,
	repairDocument,
	type SoundDesign,
	soundDesignNeedsRepair,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

type SfxClip = AudioClip & { sfx?: ClipSfx };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const err = (r: ReturnType<Harness['tx']>) => (r.ok ? null : r.errors[0]!);
const sdOf = (h: Harness) => h.seq.soundDesign as SoundDesign;
const clipOf = (h: Harness, id: string) => h.seq.clips[id] as SfxClip;

let n = 0;
/** A registered library sound (50 ms of lead silence included in its descriptors). */
function libMedia(h: Harness, o: { peakSec?: number; durationSec?: number; types?: string[] } = {}): string {
	const durationSec = o.durationSec ?? 0.55;
	const soundId = `snd_${(++n).toString(16).padStart(16, 'a')}`;
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

function addCue(h: Harness, cue: Record<string, unknown>): string {
	const r = h.ok([
		{ type: 'soundCue.add', cues: [{ kind: 'land', weight: 'hero', source: 'user', ...cue }] },
	]);
	return (r.results[0] as { cueIds: string[] }).cueIds[0]!;
}

function placeOn(h: Harness, cueId: string, layers: Record<string, unknown>[], extra: object = {}): string[] {
	const r = h.ok([{ type: 'soundDesign.place', cueId, layers, ...extra }]);
	return (r.results[0] as { clips: { clipId: string }[] }).clips.map((c) => c.clipId);
}

/** V1: clips A [0, 60) and B [60, 150) of a 10 s video (and their audio on A1). */
function edit() {
	const h = new Harness();
	const media = h.registerVideo({ seconds: 10 });
	const place = (at: number, from: number, to: number) =>
		(
			h.ok([
				{
					type: 'clip.place',
					source: { mediaId: media },
					at,
					sourceRange: { in: { seconds: from }, out: { seconds: to } },
				},
			]).results[0] as { clipIds: string[] }
		).clipIds[0]!;
	const a = place(0, 0, 2);
	const b = place(60, 3, 6);
	return { h, media, a, b, trackId: h.seq.videoTracks[0]!.id };
}

describe('repairDocument idempotence (review)', () => {
	it('a cue anchored to a transition the final transition repair drops is tidied in the same pass', () => {
		const { h, a, b } = edit();
		const tr = h.ok([
			{ type: 'transition.add', trackId: 'V1', at: 60, effectId: 'jasper.cross-dissolve', duration: 10 },
		]).results[0] as { transitionId: string };
		const cueId = addCue(h, { frame: 60, anchor: { type: 'transition', transitionId: tr.transitionId } });
		expect(checkInvariants(h.doc)).toEqual([]);
		// A file whose cut no longer joins (B one frame later): only the final transition pass removes the dissolve.
		const raw = clone(h.doc) as ProjectDocument;
		raw.sequences[h.seqId]!.clips[b]!.start = 61;
		expect(raw.sequences[h.seqId]!.clips[a]).toBeDefined();
		const loaded = loadProject(raw, { ids: createCounterIdSource(900) });
		expect(loaded.issues).toEqual([]);
		expect(loaded.document.sequences[h.seqId]!.transitions[tr.transitionId]).toBeUndefined();
		const cue = (loaded.document.sequences[h.seqId]!.soundDesign as SoundDesign).cues[cueId]!;
		expect(cue.anchor).toBeNull();
		expect(soundDesignNeedsRepair(loaded.document)).toBe(false);
		const again = repairDocument(clone(loaded.document), createCounterIdSource(5000));
		expect(again.report).toEqual([]);
		expect(again.document).toEqual(loaded.document);
	});
});

describe('soundDesign.swap at the sequence start (review)', () => {
	it('a sound placed with clampStart (head trimmed at frame 0) can be swapped, also for itself', () => {
		const h = new Harness();
		// a whoosh peaking 0.5 s in, aligned by its peak on frame 3: it would start before frame 0
		const whoosh = libMedia(h, { peakSec: 0.5, durationSec: 1.2, types: ['whoosh'] });
		const other = libMedia(h, { peakSec: 0.4, durationSec: 1, types: ['whoosh'] });
		const cueId = addCue(h, { frame: 3, align: 'peak' });
		expect(err(h.tx([{ type: 'soundDesign.place', cueId, layers: [{ mediaId: whoosh }] }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
		const [id] = placeOn(h, cueId, [{ mediaId: whoosh }], { clampStart: true });
		expect(clipOf(h, id!).start).toBe(0);
		const before = clone(h.doc);
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const at = (c: SfxClip) => c.start * F + (c.sfx!.placement.peakFlicks - c.sourceIn) / c.speed.rate;
		// swapping in the same sound changes nothing
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: whoosh }]);
		expect(h.doc).toEqual(before);
		// another sound: its peak lands on the cue too, its head trimmed at frame 0
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: other }]);
		const c = clipOf(h, id!);
		expect(c.start).toBe(0);
		expect(c.mediaId).toBe(other);
		expect(Math.abs(at(c) - 3 * F)).toBeLessThanOrEqual(1);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('split of a filled SFX clip (review)', () => {
	it('both halves fill the cue: resync, update and remove withClips move or lift both', () => {
		const { h, a, b, trackId } = edit();
		const m = libMedia(h, { durationSec: 2 });
		const cueId = addCue(h, {
			frame: 60,
			anchor: { type: 'edit', trackId, outgoingClipId: a, incomingClipId: b },
		});
		const [left] = placeOn(h, cueId, [{ mediaId: m }]);
		const c = clipOf(h, left!);
		const r = h.ok([{ type: 'clip.split', clipIds: [left], at: c.start + 20 }]);
		const right = (r.results[0] as { right: string[] }).right[0]!;
		expect(clipOf(h, right).sfx?.cueId).toBe(cueId);
		expect(sdOf(h).cues[cueId]!.placedClipIds).toEqual([left, right]);
		const starts = () => [clipOf(h, left!).start, clipOf(h, right).start];
		const [l0, r0] = starts();
		// the cut moves 10 frames later: the cue and both halves follow
		h.ok([{ type: 'clip.trim', clipId: a, edge: 'out', deltaFrames: 10, mode: 'roll' }]);
		const res = h.ok([{ type: 'soundCue.resync' }]);
		expect((res.results[0] as { moved: { clipIds: string[] }[] }).moved[0]!.clipIds).toEqual([left, right]);
		expect(starts()).toEqual([l0! + 10, r0! + 10]);
		h.ok([{ type: 'soundCue.update', cueId, frame: 80 }]);
		expect(starts()).toEqual([l0! + 20, r0! + 20]);
		h.ok([{ type: 'soundCue.remove', cueIds: [cueId], withClips: true }]);
		expect(h.seq.clips[left!]).toBeUndefined();
		expect(h.seq.clips[right]).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('soundDesign.swap keeps the clip’s transitions valid (review)', () => {
	it('a fade longer than the new sound is shortened to fit, never E_INVARIANT', () => {
		const h = new Harness();
		const long = libMedia(h, { durationSec: 1.5 });
		const short = libMedia(h, { durationSec: 0.3 });
		const cueId = addCue(h, { frame: 60 });
		const [id] = placeOn(h, cueId, [{ mediaId: long }]);
		const c = clipOf(h, id!);
		h.ok([
			{ type: 'transition.add', clipId: id, edge: 'out', effectId: 'jasper.constant-power', duration: 20 },
		]);
		h.ok([
			{ type: 'transition.add', clipId: id, edge: 'in', effectId: 'jasper.constant-power', duration: 3 },
		]);
		expect(c.duration).toBeGreaterThan(20);
		const r = h.tx([{ type: 'soundDesign.swap', clipId: id, mediaId: short }]);
		expect(err(r)).toBeNull();
		const after = clipOf(h, id!);
		expect(after.duration).toBeLessThan(20);
		for (const t of Object.values(h.seq.transitions)) expect(t.duration).toBeLessThanOrEqual(after.duration);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('soundDesign.place on a cue whose clip was split (review)', () => {
	it('the two parts are one layer: the next layer is 1, and the layer limit counts layers, not parts', () => {
		const h = new Harness();
		const m = libMedia(h, { durationSec: 2 });
		const cueId = addCue(h, { frame: 60 });
		const [left] = placeOn(h, cueId, [{ mediaId: m }]);
		const c = clipOf(h, left!);
		h.ok([{ type: 'clip.split', clipIds: [left], at: c.start + 20 }]);
		expect(sdOf(h).cues[cueId]!.placedClipIds).toHaveLength(2);
		const [next] = placeOn(h, cueId, [{ mediaId: m }]);
		expect(clipOf(h, next!).sfx!.layer).toBe(1);
		expect(clipOf(h, next!).sfx!.role).toBe('layer');
		// layers 2…5 still fit (6 layers in all, 7 clips)
		placeOn(h, cueId, [{ mediaId: m }, { mediaId: m }, { mediaId: m }, { mediaId: m }]);
		expect(sdOf(h).cues[cueId]!.placedClipIds).toHaveLength(7);
		expect(err(h.tx([{ type: 'soundDesign.place', cueId, layers: [{ mediaId: m }] }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('repairDocument on hostile sound-design data (review, property)', () => {
	/** An object whose keys are own properties whatever their name (`__proto__` included). */
	function rec(entries: [string, unknown][]): Record<string, unknown> {
		const o: Record<string, unknown> = {};
		for (const [k, v] of entries) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true });
		return o;
	}

	it('one repair is enough (repair twice == once) and nothing is left to repair, whatever the values', async () => {
		const fc = (await import('fast-check')).default;
		const { h, a, b, trackId } = edit();
		const m = libMedia(h);
		const r = h.ok([
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 60,
						kind: 'cut',
						weight: 'hero',
						source: 'user',
						anchor: { type: 'edit', trackId, outgoingClipId: a, incomingClipId: b },
						ref: '$c',
					},
				],
			},
			{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: m }, { mediaId: m }] },
		]);
		const cueA = r.refs.$c!;
		const [sfxA, sfxA2] = (r.results[1] as { clips: { clipId: string }[] }).clips.map((c) => c.clipId);
		const dup = h.ok([{ type: 'sequence.duplicate', sequenceId: h.seqId }]);
		const seqB = (dup.results[0] as { sequenceId: string }).sequenceId;
		const base = h.doc;
		const seqA = h.seqId;
		const cueB = Object.keys((base.sequences[seqB]!.soundDesign as SoundDesign).cues)[0]!;
		const clipsA = Object.keys(base.sequences[seqA]!.clips);
		const clipsB = Object.keys(base.sequences[seqB]!.clips);
		const ids = [
			cueA,
			cueB,
			'cue_0000000000000777',
			'__proto__',
			'constructor',
			'toString',
			'hasOwnProperty',
			'',
			'x'.repeat(200),
			a,
			b,
			sfxA!,
			sfxA2!,
			clipsB[0]!,
			clipsB[clipsB.length - 1]!,
			'clp_0000000000000999',
		];
		const anyId = fc.oneof(fc.constantFrom(...ids), fc.string({ maxLength: 20 }));
		const frame = fc.oneof(
			fc.constantFrom(
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
				-5,
				-0,
				3.5,
				1e12,
				1e300,
			),
			fc.integer({ min: 0, max: 1000 }),
			fc.anything(),
		);
		const anchor = fc.oneof(
			fc.constant(null),
			fc.anything(),
			fc.record({ type: fc.constant('clip'), clipId: anyId, edge: fc.constantFrom('start', 'end') }),
			fc.record({ type: fc.constant('transition'), transitionId: anyId }),
			fc.record({ type: fc.constant('marker'), markerId: anyId }),
			fc.record({ type: fc.constant('edit'), trackId: anyId, outgoingClipId: anyId, incomingClipId: anyId }),
			fc.record({ type: fc.constant('scene'), mediaId: fc.constantFrom(m, '__proto__'), mediaSec: frame }),
		);
		const cue = fc.oneof(
			{ weight: 1, arbitrary: fc.anything() },
			{
				weight: 6,
				arbitrary: fc.record(
					{
						id: anyId,
						frame,
						kind: fc.constantFrom('cut', 'land', 'nope', 7),
						weight: fc.constantFrom('hero', 'support', 'x'),
						source: fc.constantFrom('user', 'derived', null),
						anchor,
						placedClipIds: fc.oneof(
							fc.array(anyId, { maxLength: 40 }),
							fc.anything(),
							fc.constant(Array.from({ length: 5000 }, () => sfxA)),
						),
						types: fc.oneof(fc.array(fc.constantFrom('hit', 'whoosh', 'Bad', 3), { maxLength: 30 })),
						window: fc.oneof(fc.record({ start: frame, end: frame }), fc.anything()),
					},
					{ requiredKeys: [] },
				),
			},
		);
		const soundDesign = fc.oneof(
			{ weight: 1, arbitrary: fc.anything() },
			{
				weight: 6,
				arbitrary: fc.record(
					{
						cues: fc.array(fc.tuple(anyId, cue), { maxLength: 8 }).map(rec),
						settings: fc.oneof(
							fc.anything(),
							fc.record({
								sfxTrackIds: fc.array(anyId, { maxLength: 100 }),
								roomBus: fc.oneof(anyId, fc.constant(null)),
								seed: frame,
								palette: fc.anything(),
							}),
						),
					},
					{ requiredKeys: [] },
				),
			},
		);
		const sfx = fc.oneof(
			fc.constant(undefined),
			fc.anything(),
			fc.record(
				{
					cueId: fc.oneof(anyId, fc.constant(null)),
					soundId: fc.oneof(anyId, fc.constant(null)),
					layer: frame,
					role: fc.constantFrom('hero', 'support', 'layer', 'boss'),
					alternatives: fc.anything(),
					placement: fc.oneof(
						fc.anything(),
						fc.record({ align: fc.constantFrom('peak', 'x'), peakFlicks: frame, errorFlicks: frame }),
					),
				},
				{ requiredKeys: [] },
			),
		);
		fc.assert(
			fc.property(
				soundDesign,
				soundDesign,
				fc.array(
					fc.tuple(fc.constantFrom(...clipsA.map((c) => [seqA, c]), ...clipsB.map((c) => [seqB, c])), sfx),
					{
						maxLength: 6,
					},
				),
				(sdA, sdB, clipSfx) => {
					const raw = structuredClone(base) as ProjectDocument;
					(raw.sequences[seqA] as { soundDesign?: unknown }).soundDesign = sdA;
					(raw.sequences[seqB] as { soundDesign?: unknown }).soundDesign = sdB;
					for (const [[s, c], v] of clipSfx) {
						const cr = raw.sequences[s]!.clips[c] as unknown as { sfx?: unknown };
						if (v === undefined) delete cr.sfx;
						else cr.sfx = v;
					}
					const loaded = loadProject(raw, { ids: createCounterIdSource(1000) });
					expect(loaded.issues).toEqual([]);
					expect(soundDesignNeedsRepair(loaded.document)).toBe(false);
					const again = repairDocument(structuredClone(loaded.document), createCounterIdSource(5000));
					expect(again.report).toEqual([]);
					expect(again.document).toEqual(loaded.document);
					// cue ids are unique in the document and every clip's cue is one of its own sequence
					const seen = new Set<string>();
					for (const seq of Object.values(loaded.document.sequences)) {
						const own = Object.keys((seq.soundDesign as SoundDesign | undefined)?.cues ?? {});
						for (const id of own) {
							expect(seen.has(id)).toBe(false);
							seen.add(id);
						}
						for (const c of Object.values(seq.clips)) {
							const x = (c as { sfx?: ClipSfx }).sfx;
							if (x?.cueId) expect(own).toContain(x.cueId);
						}
					}
				},
			),
			{ numRuns: 300 },
		);
	}, 120_000);
});

describe('soundDesign.swap keeps every property of the clip (review)', () => {
	/** Sequence flicks at which content time `k` of a clip plays. */
	const playsAt = (c: SfxClip, k: number, F: number) => c.start * F + (k - c.sourceIn) / c.speed.rate;

	it('gain, pan and volume keyframes, effects and their keyframes, markers, group, role, cue, alternatives, enabled, Essential type', () => {
		const h = new Harness();
		const a = libMedia(h, { durationSec: 1.5 });
		const b = libMedia(h, { peakSec: 0.3, durationSec: 1.2 });
		const cueId = addCue(h, { frame: 90 });
		const ids = placeOn(
			h,
			cueId,
			[
				{
					mediaId: a,
					gainDb: -4,
					rate: 1.25,
					pan: {
						keyframes: [
							{ offset: -2, value: -50 },
							{ offset: 6, value: 40 },
						],
					},
					role: 'hero',
				},
				{ mediaId: a },
			],
			{ alternatives: ['snd_00000000000000a1', 'snd_00000000000000a2'] },
		);
		const id = ids[0]!;
		const fx = h.ok([
			{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.audio.amplify', ref: '$amp' },
			{ type: 'keyframe.add', target: ['effect', '$amp', 'leftGain'], at: { sequenceFrame: 92 }, value: -6 },
			{ type: 'keyframe.add', target: ['clip', id, 'volumeDb'], at: { sequenceFrame: 91 }, value: -3 },
			{ type: 'marker.add', clipId: id, frame: 93, name: 'hit' },
			{ type: 'clip.update', clipId: id, patch: { enabled: false, name: 'My whoosh' } },
		]);
		const fxId = fx.refs.$amp!;
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const old = clone(clipOf(h, id));
		const times = (c: SfxClip) => ({
			pan: c.pan.keyframes.map((k) => Math.round(playsAt(c, k.time, F))),
			vol: c.volumeDb.keyframes.map((k) => Math.round(playsAt(c, k.time, F))),
			fx: (
				c.effects.find((e) => e.id === fxId)!.params.leftGain as { keyframes: { time: number }[] }
			).keyframes.map((k) => Math.round(playsAt(c, k.time, F))),
			markers: c.markers.map((m) => Math.round(playsAt(c, m.flicks, F))),
		});
		const before = times(old);
		const before2 = h.doc;
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: b }]);
		const c = clipOf(h, id);
		expect(c.mediaId).toBe(b);
		expect(
			Math.abs(c.start * F + (c.sfx!.placement.peakFlicks - c.sourceIn) / c.speed.rate - 90 * F),
		).toBeLessThanOrEqual(1);
		expect(times(c)).toEqual(before);
		expect(c.pan.keyframes.map((k) => k.value)).toEqual(old.pan.keyframes.map((k) => k.value));
		expect(c.volumeDb.keyframes.map((k) => [k.id, k.value])).toEqual(
			old.volumeDb.keyframes.map((k) => [k.id, k.value]),
		);
		expect(c.effects.map((e) => e.id)).toEqual(old.effects.map((e) => e.id));
		expect(c.markers.map((m) => [m.id, m.name])).toEqual(old.markers.map((m) => [m.id, m.name]));
		expect(c.gainDb).toBe(-4);
		expect(c.speed).toEqual(old.speed);
		expect(c.groupId).toBe(old.groupId);
		expect(c.linkId).toBe(old.linkId);
		expect(c.enabled).toBe(false);
		expect(c.name).toBe('My whoosh');
		expect(c.trackId).toBe(old.trackId);
		expect((c as { essential?: unknown }).essential).toEqual((old as { essential?: unknown }).essential);
		expect(c.sfx).toMatchObject({
			cueId,
			layer: 0,
			role: 'hero',
			alternatives: ['snd_00000000000000a1', 'snd_00000000000000a2'],
		});
		expect(checkInvariants(h.doc)).toEqual([]);
		// undo restores the clip exactly
		expect(before2.sequences[h.seqId]!.clips[id]).toEqual(old);
	});

	it('the clip name follows the sound only while it is the media’s name; reversed clips are refused', () => {
		const h = new Harness();
		const a = libMedia(h);
		const b = libMedia(h, { peakSec: 0.2, durationSec: 0.8 });
		const [id] = placeOn(h, addCue(h, { frame: 40 }), [{ mediaId: a }]);
		expect(clipOf(h, id!).name).toBe(h.doc.media[a]!.originalName);
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: b }]);
		expect(clipOf(h, id!).name).toBe(h.doc.media[b]!.originalName);
		h.ok([{ type: 'clip.setSpeed', clipIds: [id], reverse: true, ripple: false }]);
		const doc = h.doc;
		expect(err(h.tx([{ type: 'soundDesign.swap', clipId: id, mediaId: a }]))?.code).toBe('E_INVALID_PARAM');
		expect(h.doc).toBe(doc);
	});
});
