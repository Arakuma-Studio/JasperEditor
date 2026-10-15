// Sound Design Phase 2 model review (spec 12 §2.2, §2.3, §2.9; P2-R1…R5): regression tests for the bugs the
// verification review found (each failed before its fix) and the coverage gaps it filled.
import { describe, expect, it } from 'vitest';
import { pitchPlan } from '../src/commands/handlers/sound.ts';
import {
	type AudioClip,
	applyTransaction,
	type ClipSfx,
	checkInvariants,
	createCounterIdSource,
	deriveCues,
	flicksPerFrame,
	type LibraryProvenance,
	loadProject,
	type ProjectDocument,
	repairDocument,
	type SoundDesign,
	soundDesignNeedsRepair,
	unknownCommandKeyIssues,
} from '../src/index.ts';
import { Harness, makeCtx, videoAsset } from './helpers.ts';
import { mgRegistry, phase2Fixture } from './sound-cues-fixtures.ts';
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

/**
 * Undo / redo at the model level: the document before the transaction is untouched (Undo restores it), and the same
 * transaction applied to it again gives the same document (Redo). Ids are drawn from a counter at the same seed.
 */
function undoRedo(h: Harness, commands: unknown[], seed = 4242): void {
	const before = h.doc;
	const snapshot = clone(before);
	const run = () =>
		applyTransaction(
			before,
			{ label: 'test', origin: 'user', sequenceId: h.seqId, commands: commands as never },
			makeCtx({ revision: h.revision }, createCounterIdSource(seed)),
		);
	const first = run();
	expect(first.result.ok, JSON.stringify(first.result)).toBe(true);
	expect(first.document).not.toBe(before);
	expect(clone(before)).toEqual(snapshot);
	expect(run().document).toEqual(first.document);
	expect(checkInvariants(first.document)).toEqual([]);
	h.doc = first.document;
	h.revision = first.result.revision;
}

/** Refused with `code` and the document unchanged. */
function refused(h: Harness, commands: unknown[], code: string): void {
	const doc = h.doc;
	const r = h.tx(commands);
	expect(err(r)?.code, JSON.stringify(commands)).toBe(code);
	expect(h.doc).toBe(doc);
}

describe('every soundCue.* / soundDesign.* command: undo / redo and each refusal (review, gaps)', () => {
	function filled() {
		const e = edit();
		const m = libMedia(e.h);
		const r = e.h.ok([
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 60,
						kind: 'cut',
						weight: 'support',
						source: 'user',
						anchor: { type: 'clip', clipId: e.b, edge: 'start' },
						ref: '$c',
					},
				],
			},
			{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: m }] },
		]);
		const cueId = r.refs.$c!;
		const clipId = (r.results[1] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		return { ...e, m, cueId, clipId };
	}

	it('soundCue.add / update / remove / resync: undo / redo', () => {
		const f = filled();
		undoRedo(f.h, [
			{ type: 'soundCue.add', cues: [{ frame: 9, kind: 'manual', weight: 'ambient', source: 'agent' }] },
		]);
		undoRedo(f.h, [{ type: 'soundCue.update', cueId: f.cueId, frame: 64, label: 'x', weight: 'hero' }]);
		f.h.ok([{ type: 'clip.move', clipIds: [f.b], deltaFrames: 5 }]);
		undoRedo(f.h, [{ type: 'soundCue.resync' }]);
		expect(clipOf(f.h, f.clipId).sfx!.cueId).toBe(f.cueId);
		undoRedo(f.h, [{ type: 'soundCue.remove', cueIds: [f.cueId], withClips: true }]);
		expect(f.h.seq.clips[f.clipId]).toBeUndefined();
	});

	it('soundDesign.place / swap / setRole / setPalette / setSettings / setPeak: undo / redo', () => {
		const f = filled();
		const other = libMedia(f.h, { peakSec: 0.2, durationSec: 0.8 });
		undoRedo(f.h, [
			{ type: 'soundDesign.place', cueId: f.cueId, layers: [{ mediaId: f.m }, { mediaId: other }] },
		]);
		undoRedo(f.h, [{ type: 'soundDesign.swap', clipId: f.clipId, mediaId: other, pitchSt: 2 }]);
		undoRedo(f.h, [{ type: 'soundDesign.setRole', clipIds: [f.clipId], role: 'layer' }]);
		undoRedo(f.h, [{ type: 'soundDesign.setPalette', soundIds: ['snd_0000000000000001'], mode: 'add' }]);
		undoRedo(f.h, [{ type: 'soundDesign.setSettings', seed: 9, density: 'rich', sfxTrackIds: ['A2'] }]);
		undoRedo(f.h, [{ type: 'soundDesign.setPeak', clipId: f.clipId, peakFlicks: 1000 }]);
	});

	it('soundCue.update: an anchor to nothing (E_NOT_FOUND) and unknown keys (E_SCHEMA)', () => {
		const f = filled();
		refused(
			f.h,
			[
				{
					type: 'soundCue.update',
					cueId: f.cueId,
					anchor: { type: 'transition', transitionId: 'trn_0000000000000999' },
				},
			],
			'E_NOT_FOUND',
		);
		refused(f.h, [{ type: 'soundCue.update', cueId: f.cueId, nope: 1 }], 'E_SCHEMA');
		refused(f.h, [{ type: 'soundCue.update', cueId: f.cueId, frame: -1 }], 'E_SCHEMA');
		refused(f.h, [{ type: 'soundCue.update', cueId: f.cueId, frame: Number.NaN }], 'E_SCHEMA');
		refused(f.h, [{ type: 'soundCue.update', cueId: f.cueId, frame: 10_368_001 }], 'E_SCHEMA');
	});

	it('soundCue.remove: no cue ids or unknown keys (E_SCHEMA)', () => {
		const f = filled();
		refused(f.h, [{ type: 'soundCue.remove', cueIds: [] }], 'E_SCHEMA');
		refused(f.h, [{ type: 'soundCue.remove', cueIds: [f.cueId], lift: true }], 'E_SCHEMA');
	});

	it('soundCue.resync: a clip pushed before frame 0 (E_INVALID_PARAM), unknown sequence / no cues (E_NOT_FOUND), E_SCHEMA', () => {
		const f = filled();
		// B moves to frame 0 (A lifted): the cue follows to 0, its sound would start before the sequence
		f.h.ok([{ type: 'clip.lift', clipIds: [f.a] }]);
		f.h.ok([{ type: 'clip.move', clipIds: [f.b], deltaFrames: -60 }]);
		expect(clipOf(f.h, f.clipId).start).toBeLessThan(60);
		refused(f.h, [{ type: 'soundCue.resync' }], 'E_INVALID_PARAM');
		refused(f.h, [{ type: 'soundCue.resync', sequenceId: 'seq_0000000000000999' }], 'E_NOT_FOUND');
		refused(f.h, [{ type: 'soundCue.resync', cueIds: [] }], 'E_SCHEMA');
		refused(f.h, [{ type: 'soundCue.resync', all: true }], 'E_SCHEMA');
		const empty = new Harness();
		refused(empty, [{ type: 'soundCue.resync', cueIds: ['cue_0000000000000001'] }], 'E_NOT_FOUND');
		expect(empty.ok([{ type: 'soundCue.resync' }]).results[0]).toEqual({
			moved: [],
			unresolved: [],
			unanchored: [],
		});
	});

	it('soundDesign.swap: every E_INVALID_PARAM case and E_SCHEMA', () => {
		const f = filled();
		const h = f.h;
		const plain = h.registerVideo({ kind: 'audio', seconds: 2 });
		const still = h.registerVideo({ kind: 'image' });
		const r = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: plain },
				at: 300,
				tracks: { audio: 'A3' },
				video: false,
				ref: '$p',
			},
		]);
		const plainClip = r.refs.$p!;
		// a video clip
		refused(h, [{ type: 'soundDesign.swap', clipId: f.a, mediaId: f.m }], 'E_INVALID_PARAM');
		// project audio never placed by sound design and without a peak
		refused(h, [{ type: 'soundDesign.swap', clipId: plainClip, mediaId: f.m }], 'E_INVALID_PARAM');
		// a media without sound
		refused(h, [{ type: 'soundDesign.swap', clipId: f.clipId, mediaId: still }], 'E_INVALID_PARAM');
		// project audio has no peak to align by its peak (by its start it is fine)
		refused(h, [{ type: 'soundDesign.swap', clipId: f.clipId, mediaId: plain }], 'E_INVALID_PARAM');
		// the frame out of range, the new sound before frame 0
		refused(
			h,
			[{ type: 'soundDesign.swap', clipId: f.clipId, mediaId: f.m, frame: 10_368_001 }],
			'E_INVALID_PARAM',
		);
		const late = libMedia(h, { peakSec: 1.5, durationSec: 2 });
		refused(h, [{ type: 'soundDesign.swap', clipId: f.clipId, mediaId: late, frame: 10 }], 'E_INVALID_PARAM');
		refused(h, [{ type: 'soundDesign.swap', clipId: f.clipId, mediaId: f.m, pitchSt: 12.5 }], 'E_SCHEMA');
		refused(h, [{ type: 'soundDesign.swap', clipId: f.clipId, mediaId: f.m, track: 'A1' }], 'E_SCHEMA');
		refused(h, [{ type: 'soundDesign.swap', clipId: f.clipId }], 'E_SCHEMA');
		h.ok([{ type: 'soundDesign.swap', clipId: f.clipId, mediaId: plain, align: 'start' }]);
		expect(clipOf(h, f.clipId).mediaId).toBe(plain);
	});

	it('soundDesign.setPalette: more than 500 sounds (E_LIMIT), unknown sequence (E_NOT_FOUND)', () => {
		const h = new Harness();
		const ids = (from: number, count: number) =>
			Array.from({ length: count }, (_, i) => `snd_${(from + i).toString(16).padStart(16, '0')}`);
		h.ok([{ type: 'soundDesign.setPalette', soundIds: ids(0, 400) }]);
		refused(h, [{ type: 'soundDesign.setPalette', soundIds: ids(400, 101), mode: 'add' }], 'E_LIMIT');
		h.ok([{ type: 'soundDesign.setPalette', soundIds: ids(400, 100), mode: 'add' }]);
		expect((h.seq.soundDesign as SoundDesign).settings!.palette).toHaveLength(500);
		refused(h, [{ type: 'soundDesign.setPalette', soundIds: ids(0, 501) }], 'E_SCHEMA');
		refused(
			h,
			[{ type: 'soundDesign.setPalette', sequenceId: 'seq_0000000000000999', soundIds: [] }],
			'E_NOT_FOUND',
		);
	});
});

describe('sound command input is strict and bounded (review, gaps)', () => {
	it('agents get E_SCHEMA for unknown keys at any depth (window, panSweep, anchor, layer pan keyframes)', () => {
		const cue = { frame: 10, kind: 'cut', weight: 'hero', source: 'agent' };
		const cases: unknown[] = [
			{ type: 'soundCue.add', cues: [{ ...cue, window: { start: 1, end: 2, extra: 1 } }] },
			{ type: 'soundCue.add', cues: [{ ...cue, panSweep: { from: 0, to: 1, ease: 1 } }] },
			{
				type: 'soundCue.add',
				cues: [{ ...cue, anchor: { type: 'clip', clipId: 'clp_0000000000000001', edge: 'start', x: 1 } }],
			},
			{
				type: 'soundCue.update',
				cueId: 'cue_0000000000000001',
				stopBefore: { seconds: 1, depthDb: -6, q: 1 },
			},
			{
				type: 'soundDesign.place',
				frame: 10,
				layers: [
					{
						mediaId: 'med_0000000000000001',
						pan: {
							keyframes: [
								{ offset: 0, value: 0, ease: 1 },
								{ offset: 1, value: 1 },
							],
						},
					},
				],
			},
		];
		for (const c of cases)
			expect(
				unknownCommandKeyIssues([c]).map((i) => i.code),
				JSON.stringify(c),
			).toEqual(['E_SCHEMA']);
		expect(unknownCommandKeyIssues([{ type: 'soundCue.add', cues: [cue] }])).toEqual([]);
	});

	it('non-finite numbers, oversized arrays and strings are refused before any handler runs', () => {
		const h = new Harness();
		const m = libMedia(h);
		const cue = { kind: 'cut', weight: 'hero', source: 'agent' };
		const bad: unknown[] = [
			{ type: 'soundCue.add', cues: [{ ...cue, frame: Number.NaN }] },
			{ type: 'soundCue.add', cues: [{ ...cue, frame: Number.POSITIVE_INFINITY }] },
			{ type: 'soundCue.add', cues: [{ ...cue, frame: 1.5 }] },
			{ type: 'soundCue.add', cues: [{ ...cue, frame: 1, pitchSt: Number.NaN }] },
			{ type: 'soundCue.add', cues: [{ ...cue, frame: 1, confidence: Number.POSITIVE_INFINITY }] },
			{ type: 'soundCue.add', cues: [{ ...cue, frame: 1, label: 'x'.repeat(501) }] },
			{ type: 'soundCue.add', cues: [{ ...cue, frame: 1, id: 'x'.repeat(10_000) }] },
			{ type: 'soundCue.add', cues: Array.from({ length: 2001 }, () => ({ ...cue, frame: 1 })) },
			{ type: 'soundCue.add', cues: [{ ...cue, frame: 1, types: Array.from({ length: 17 }, () => 'hit') }] },
			{ type: 'soundCue.add', cues: [{ ...cue, frame: 1, window: { start: 5, end: 4 } }] },
			{ type: 'soundDesign.place', frame: 10, layers: Array.from({ length: 7 }, () => ({ mediaId: m })) },
			{ type: 'soundDesign.place', frame: 10, layers: [{ mediaId: m, gainDb: Number.NaN }] },
			{ type: 'soundDesign.place', frame: 10, layers: [{ mediaId: m, rate: 0 }] },
			{
				type: 'soundDesign.place',
				frame: 10,
				layers: [{ mediaId: m }],
				preferTrackIds: Array.from({ length: 33 }, () => 'A1'),
			},
			{ type: 'soundDesign.place', frame: 10, layers: [{ mediaId: m }], alternatives: ['snd_x'] },
			{ type: 'soundDesign.swap', clipId: 'clp_0000000000000001', mediaId: m, pitchSt: Number.NaN },
			{ type: 'soundDesign.setPeak', clipId: 'clp_0000000000000001', peakFlicks: Number.POSITIVE_INFINITY },
			{ type: 'soundDesign.setSettings', seed: -1 },
			{ type: 'soundDesign.setSettings', seed: 2 ** 32 },
		];
		for (const c of bad) {
			const code = err(h.tx([c]))?.code;
			// a malformed cue id is refused by the handler; everything else by the schema
			expect(['E_SCHEMA', 'E_INVALID_PARAM'], JSON.stringify(c).slice(0, 200)).toContain(code);
		}
	});
});

describe('deriveCues determinism (review, gaps)', () => {
	it('the same cues whatever order the clips, transitions, media and markers are stored in (property)', async () => {
		const fc = (await import('fast-check')).default;
		const f = phase2Fixture();
		const h = f.h;
		h.ok([
			{ type: 'marker.add', frame: 200, name: 'sfx: hit' },
			{ type: 'marker.add', frame: 40, name: 'sfx: whoosh' },
			{ type: 'marker.add', frame: 120, name: 'sfx: boom' },
		]);
		const opts = { density: 'rich' as const, mgTemplates: mgRegistry() };
		const ref = deriveCues(h.doc, h.seqId, opts);
		expect(ref.cues.length).toBeGreaterThan(10);
		const want = JSON.stringify({ cues: ref.cues, curves: ref.curves });
		const shuffle = <T>(list: T[], keys: number[]) =>
			list
				.map((x, i) => [x, keys[i % keys.length]! + i / 1e6] as const)
				.sort((a, b) => a[1] - b[1])
				.map((x) => x[0]);
		const reorder = (o: Record<string, unknown>, keys: number[]) =>
			Object.fromEntries(shuffle(Object.entries(o), keys));
		fc.assert(
			fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 40 }), (keys) => {
				const doc = structuredClone(h.doc);
				const seq = doc.sequences[h.seqId]!;
				seq.clips = reorder(seq.clips, keys) as typeof seq.clips;
				seq.transitions = reorder(seq.transitions, [...keys].reverse()) as typeof seq.transitions;
				seq.markers = shuffle(seq.markers, keys);
				doc.media = reorder(doc.media, keys) as typeof doc.media;
				doc.sequences = reorder(doc.sequences, keys) as typeof doc.sequences;
				const r = deriveCues(doc, h.seqId, opts);
				expect(JSON.stringify({ cues: r.cues, curves: r.curves })).toBe(want);
			}),
			{ numRuns: 40 },
		);
	}, 120_000);
});

describe('soundCue.resync follows trims, speed changes and moves (review, gaps)', () => {
	function anchoredTo(edge: 'start' | 'end') {
		const e = edit();
		const m = libMedia(e.h);
		const frame = edge === 'start' ? 60 : 150;
		const cueId = addCue(e.h, { frame, anchor: { type: 'clip', clipId: e.b, edge } });
		const [clipId] = placeOn(e.h, cueId, [{ mediaId: m }]);
		return { ...e, m, cueId, clipId: clipId! };
	}

	it('the anchored clip trimmed or speed-changed: the cue and its sound follow its end', () => {
		const f = anchoredTo('end');
		const s0 = clipOf(f.h, f.clipId).start;
		f.h.ok([{ type: 'clip.trim', clipId: f.b, edge: 'out', deltaFrames: -30 }]);
		f.h.ok([{ type: 'soundCue.resync' }]);
		expect(sdOf(f.h).cues[f.cueId]!.frame).toBe(120);
		expect(clipOf(f.h, f.clipId).start).toBe(s0 - 30);
		// twice as fast: B [60, 120) → [60, 90)
		f.h.ok([{ type: 'clip.setSpeed', clipIds: [f.b], rate: 2, ripple: false }]);
		const end = f.h.seq.clips[f.b]!.start + f.h.seq.clips[f.b]!.duration;
		const r = f.h.ok([{ type: 'soundCue.resync' }]);
		expect((r.results[0] as { moved: { to: number }[] }).moved[0]!.to).toBe(end);
		expect(clipOf(f.h, f.clipId).start).toBe(s0 - 30 + (end - 120));
		expect(checkInvariants(f.h.doc)).toEqual([]);
	});

	it('a clip filling two cues moves once (by the first cue’s delta); an unresolvable anchor is reported', () => {
		const f = anchoredTo('start');
		const other = addCue(f.h, { frame: 60, anchor: { type: 'clip', clipId: f.b, edge: 'start' } });
		const unresolved = addCue(f.h, {
			frame: 30,
			anchor: { type: 'mg', clipId: f.a, event: 'intro-end' },
		});
		// a file in which the second cue names the same clip
		const doc = clone(f.h.doc);
		(doc.sequences[f.h.seqId]!.soundDesign as SoundDesign).cues[other]!.placedClipIds = [f.clipId];
		f.h.doc = doc;
		const s0 = clipOf(f.h, f.clipId).start;
		f.h.ok([{ type: 'clip.move', clipIds: [f.b], deltaFrames: 8 }]);
		const r = f.h.ok([{ type: 'soundCue.resync' }]).results[0] as {
			moved: { cueId: string; clipIds: string[] }[];
			unresolved: string[];
		};
		expect(clipOf(f.h, f.clipId).start).toBe(s0 + 8);
		expect(r.moved.map((x) => [x.cueId, x.clipIds])).toEqual([
			[f.cueId, [f.clipId]],
			[other, []],
		]);
		expect(r.unresolved).toEqual([unresolved]);
		expect(sdOf(f.h).cues[unresolved]!.frame).toBe(30);
	});
});

describe('pitch plan boundaries (review, gaps)', () => {
	it('|st| = 3 exactly is varispeed; just above uses the Pitch Shifter (place and swap)', () => {
		expect(pitchPlan(3, 1)).toEqual({ rate: 2 ** (3 / 12), shifterSt: 0 });
		expect(pitchPlan(-3, 1.01)).toEqual({ rate: 1.01 * 2 ** (-3 / 12), shifterSt: 0 });
		expect(pitchPlan(3.01, 1.01)).toEqual({ rate: 1.01, shifterSt: 3.01 });
		expect(pitchPlan(-12, 1)).toEqual({ rate: 1, shifterSt: -12 });
		expect(pitchPlan(0, 0.99)).toEqual({ rate: 0.99, shifterSt: 0 });
		const h = new Harness();
		const m = libMedia(h);
		const r = h.ok([
			{
				type: 'soundDesign.place',
				frame: 100,
				group: false,
				layers: [
					{ mediaId: m, pitchSt: 3 },
					{ mediaId: m, pitchSt: -3 },
					{ mediaId: m, pitchSt: 3.5 },
				],
			},
		]);
		const [a, b, c] = (r.results[0] as { clips: { clipId: string }[] }).clips.map((x) => clipOf(h, x.clipId));
		const shifter = (x: SfxClip) => x.effects.filter((fx) => fx.effectId === 'jasper.audio.pitch-shifter');
		expect(a!.speed.rate).toBeCloseTo(2 ** (3 / 12), 12);
		expect(shifter(a!)).toHaveLength(0);
		expect(b!.speed.rate).toBeCloseTo(2 ** (-3 / 12), 12);
		expect(shifter(b!)).toHaveLength(0);
		expect(c!.speed.rate).toBe(1);
		expect(shifter(c!).map((fx) => [fx.params.semitones!.value, fx.params.cents!.value])).toEqual([[3, 50]]);
		// swap re-pitches across the boundary both ways; never two shifters
		h.ok([{ type: 'soundDesign.swap', clipId: a!.id, mediaId: m, pitchSt: -4 }]);
		expect(clipOf(h, a!.id).speed.rate).toBe(1);
		expect(shifter(clipOf(h, a!.id)).map((fx) => fx.params.semitones!.value)).toEqual([-4]);
		h.ok([{ type: 'soundDesign.swap', clipId: a!.id, mediaId: m, pitchSt: 3 }]);
		expect(clipOf(h, a!.id).speed.rate).toBeCloseTo(2 ** (3 / 12), 6);
		expect(shifter(clipOf(h, a!.id))).toHaveLength(0);
		h.ok([{ type: 'soundDesign.swap', clipId: c!.id, mediaId: m, pitchSt: 0 }]);
		expect(clipOf(h, c!.id).speed.rate).toBe(1);
		expect(shifter(clipOf(h, c!.id))).toHaveLength(0);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('soundDesign.swap onto a frame stays refused before frame 0 (review)', () => {
	it('a clip at frame 0 re-aligned onto an earlier frame than its lead allows is refused, not trimmed', () => {
		const h = new Harness();
		const whoosh = libMedia(h, { peakSec: 0.5, durationSec: 1.2, types: ['whoosh'] });
		const [id] = placeOn(h, addCue(h, { frame: 3, align: 'peak' }), [{ mediaId: whoosh }], {
			clampStart: true,
		});
		expect(clipOf(h, id!).start).toBe(0);
		refused(h, [{ type: 'soundDesign.swap', clipId: id, mediaId: whoosh, frame: 2 }], 'E_INVALID_PARAM');
		h.ok([{ type: 'soundDesign.swap', clipId: id, mediaId: whoosh, frame: 40 }]);
		expect(clipOf(h, id!).start).toBeGreaterThan(0);
	});
});
