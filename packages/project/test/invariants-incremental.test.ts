// Chains exceed the layered id index’s flattening depth and must exercise the incremental path.
import fc from 'fast-check';
import { type Draft, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import {
	applyTransaction,
	type Clip,
	checkInvariants,
	checkTransactionInvariants,
	createRandomIdSource,
	defaultRegistries,
	invariantMode,
	invariantStats,
	isVerifiedDocument,
	type ProjectDocument,
	runInvariants,
	type Sequence,
} from '../src/index.ts';
import { TRACK_MATTE_EFFECT_ID } from '../src/masks/track-matte.ts';
import { Harness, makeCtx } from './helpers.ts';

const FUZZ = process.env.FUZZ === '1';
const RUNS = FUZZ ? 3_000 : 300;
const opts = { effects: defaultRegistries().effects };
const ids = createRandomIdSource();

/** A document with linked A/V clips, solids, text, a transition, a clip group, effects, keyframes, markers and a nest. */
function baseDocument(): { doc: ProjectDocument; h: Harness } {
	const h = new Harness({ seed: 4242 });
	const media = h.registerVideo({ seconds: 20 });
	h.ok([
		{ type: 'clip.place', source: { mediaId: media }, at: 0 },
		{ type: 'clip.place', source: { mediaId: media }, at: 600, tracks: { video: 'V1' } },
		{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V2', color: [0, 0, 1, 1] },
		{ type: 'clip.addSolid', at: 120, duration: 120, track: 'V2', color: [0, 1, 0, 1] },
		{ type: 'clip.addText', at: 300, duration: 90, track: 'V3', content: { text: 'hello' } },
		{ type: 'marker.add', frame: 30, name: 'm1' },
		{ type: 'marker.add', frame: 90, name: 'm2' },
	]);
	const v2 = h.clips('V2');
	h.ok([
		{
			type: 'transition.add',
			clipId: v2[1]!.id,
			edge: 'in',
			effectId: 'jasper.cross-dissolve',
			duration: 12,
		},
		{ type: 'clip.group', clipIds: [v2[0]!.id, h.clips('V3')[0]!.id] },
		{ type: 'param.setAnimated', target: ['clip', v2[0]!.id, 'opacity'], animated: true, at: { frames: 0 } },
		{ type: 'keyframe.add', target: ['clip', v2[0]!.id, 'opacity'], at: { frames: 40 }, value: 30 },
		{ type: 'effect.add', target: { clipId: v2[1]!.id }, effectId: 'jasper.gaussian-blur' },
	]);
	const later = h.clips('V1').find((c) => c.start === 600)!;
	h.ok([{ type: 'clip.nest', clipIds: [later.id], name: 'Nest' }]);
	return { doc: h.doc, h };
}

type Pick = { a: number; b: number; c: number; v: number };

const clipsOf = (doc: ProjectDocument) =>
	Object.values(doc.sequences).flatMap((s) => Object.values(s.clips).map((c) => ({ s, c })));
const at = <T>(list: readonly T[], i: number): T | undefined => list[i % Math.max(1, list.length)];

const idsOf = (doc: ProjectDocument) => [...runInvariants(doc, opts).seen].sort();

type Corruption = (d: Draft<ProjectDocument>, p: Pick, doc: ProjectDocument) => void;

const draftClip = (d: Draft<ProjectDocument>, doc: ProjectDocument, i: number) => {
	const x = at(clipsOf(doc), i);
	return x ? { seq: d.sequences[x.s.id]!, clip: d.sequences[x.s.id]!.clips[x.c.id]!, orig: x } : null;
};

const CORRUPTIONS: Record<string, Corruption> = {
	overlap(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		const y = at(clipsOf(doc), p.b);
		if (x && y && x.orig.s.id === y.s.id) {
			x.clip.trackId = y.c.trackId;
			x.clip.start = y.c.start + (p.v % 5);
		}
	},
	shiftClip(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		if (x) x.clip.start = Math.max(0, x.clip.start + (p.v % 400) - 200);
	},
	collideMarkerId(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		const id = at(idsOf(doc), p.b)!;
		x?.clip.markers.push({ ...(x.clip.markers[0] ?? {}), id } as never);
	},
	collideKeyframeId(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		const kfs = (x?.clip as { opacity?: { keyframes: { id: string }[] } } | undefined)?.opacity?.keyframes;
		if (kfs?.length) kfs[p.c % kfs.length]!.id = at(idsOf(doc), p.b)!;
	},
	malformedId(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		const kfs = (x?.clip as { opacity?: { keyframes: { id: string }[] } } | undefined)?.opacity?.keyframes;
		if (kfs?.length) kfs[0]!.id = 'kf_bad';
		else if (x) x.clip.markers.push({ id: 'nope' } as never);
	},
	reuseOwnId(d, p, doc) {
		// Valid: an entity keeps its id while changing (the id index must not call this a duplicate).
		const x = draftClip(d, doc, p.a);
		if (x) x.clip.name = `renamed ${p.v}`;
	},
	danglingLink(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		if (x) x.clip.linkId = 'lnk_00000000000009ZZ';
	},
	dropLinkMember(d, p, doc) {
		const seq = Object.values(doc.sequences).find((s) => Object.keys(s.links).length);
		const l = seq && at(Object.values(seq.links), p.a);
		if (seq && l) d.sequences[seq.id]!.links[l.id]!.members.splice(p.b % l.members.length, 1);
	},
	deleteLinkedClip(d, p, doc) {
		const x = at(
			clipsOf(doc).filter(({ c }) => c.linkId),
			p.a,
		);
		if (x) delete d.sequences[x.s.id]!.clips[x.c.id];
	},
	deleteAnyClip(d, p, doc) {
		const x = at(clipsOf(doc), p.a);
		if (x) delete d.sequences[x.s.id]!.clips[x.c.id];
	},
	deleteGroupedClipsGroup(d, p, doc) {
		const seq = Object.values(doc.sequences).find((s) => Object.keys(s.groups).length);
		const g = seq && at(Object.values(seq.groups), p.a);
		if (seq && g) delete d.sequences[seq.id]!.groups[g.id];
	},
	opacityOutOfRange(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		const o = (x?.clip as { opacity?: { value: number } } | undefined)?.opacity;
		if (o) o.value = 100 + (p.v % 3) * 25;
	},
	missingMedia(d, p, doc) {
		const x = at(
			clipsOf(doc).filter(({ c }) => 'mediaId' in c),
			p.a,
		);
		if (x) (d.sequences[x.s.id]!.clips[x.c.id] as { mediaId: string }).mediaId = 'med_00000000000009ZZ';
	},
	deleteSynthetic(d, p, doc) {
		const id = at(Object.keys(doc.synthetics), p.a);
		if (id) delete d.synthetics[id];
	},
	orphanSynthetic(d, p, doc) {
		const s = at(Object.values(doc.synthetics), p.a);
		if (s) d.synthetics.syn_00000000000008ZZ = { ...s, id: 'syn_00000000000008ZZ' } as never;
	},
	swapSynthetic(d, p, doc) {
		const x = at(
			clipsOf(doc).filter(({ c }) => c.kind === 'solid'),
			p.a,
		);
		const s = at(Object.keys(doc.synthetics), p.b);
		if (x && s) (d.sequences[x.s.id]!.clips[x.c.id] as { syntheticId: string }).syntheticId = s;
	},
	syntheticKind(d, p, doc) {
		const id = at(Object.keys(doc.synthetics), p.a);
		if (id) (d.synthetics[id] as { kind: string }).kind = p.v % 2 ? 'adjustment' : 'black-video';
	},
	transitionToOther(d, p, doc) {
		const seq = Object.values(doc.sequences).find((s) => Object.keys(s.transitions).length);
		const t = seq && at(Object.values(seq.transitions), p.a);
		const c = seq && at(Object.values(seq.clips), p.b);
		if (seq && t && c) d.sequences[seq.id]!.transitions[t.id]!.incomingClipId = c.id;
	},
	deleteTransitionClip(d, p, doc) {
		const seq = Object.values(doc.sequences).find((s) => Object.keys(s.transitions).length);
		const t = seq && at(Object.values(seq.transitions), p.a);
		if (seq && t?.incomingClipId) delete d.sequences[seq.id]!.clips[t.incomingClipId];
	},
	missingTrack(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		if (x) x.clip.trackId = 'trk_00000000000009ZZ';
	},
	otherKindTrack(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		if (x) x.clip.trackId = at([...x.orig.s.videoTracks, ...x.orig.s.audioTracks], p.b)!.id;
	},
	zeroDuration(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		if (x) x.clip.duration = 0;
	},
	badExpression(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		const o = (x?.clip as { opacity?: Record<string, unknown> } | undefined)?.opacity;
		if (o) o.expression = p.v % 2 ? { text: 1, enabled: true } : { text: 'time', enabled: true };
	},
	trackMatteOwnTrack(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		const fx = (x?.clip as { effects?: unknown[] } | undefined)?.effects;
		if (x && fx)
			fx.push({
				id: 'fx_00000000000007ZZ',
				effectId: TRACK_MATTE_EFFECT_ID,
				effectVersion: 1,
				enabled: true,
				params: { matteTrack: { value: p.v % 2 ? x.clip.trackId : 'trk_00000000000009ZZ', keyframes: [] } },
			});
	},
	remixMismatch(d, p, doc) {
		const x = draftClip(d, doc, p.a);
		if (x && x.clip.kind === 'audio')
			(x.clip as { remix?: unknown }).remix = { id: 'rmx', count: 3, index: 0, sourceDuration: 1 };
	},
	nestCycle(d, p, doc) {
		const nest = clipsOf(doc).find(({ c }) => c.kind === 'nest-video');
		if (!nest) return;
		const inner = d.sequences[(nest.c as { sequenceId: string }).sequenceId]!;
		const anyInner = Object.values(inner.clips)[0];
		if (anyInner)
			inner.clips.clp_00000000000006ZZ = {
				...(JSON.parse(JSON.stringify(nest.c)) as Clip),
				id: 'clp_00000000000006ZZ',
				trackId: anyInner.trackId,
				start: 5000 + p.v,
				linkId: null,
				groupId: null,
				sequenceId: nest.s.id,
			} as never;
	},
	shortenNested(d, p, doc) {
		const nest = clipsOf(doc).find(({ c }) => c.kind === 'nest-video');
		if (!nest) return;
		const inner = d.sequences[(nest.c as { sequenceId: string }).sequenceId]!;
		for (const c of Object.values(inner.clips)) c.duration = Math.max(1, c.duration - 1 - (p.v % 200));
	},
	remixPair(d, p, doc) {
		// Valid while both pieces exist; deleting one later breaks the other's count (INV-ESSENTIAL).
		const audio = clipsOf(doc).filter(({ c }) => c.kind === 'audio');
		const x = at(audio, p.a);
		const y = at(audio, p.b);
		if (!x || !y || x.c.id === y.c.id || x.s.id !== y.s.id) return;
		const remix = {
			id: 'grp_00000000000004ZZ',
			count: 2,
			targetFrames: 10,
			segments: 50,
			variations: 50,
			bpm: 120,
		};
		for (const [i, z] of [x, y].entries())
			(d.sequences[z.s.id]!.clips[z.c.id] as { remix?: unknown }).remix = {
				...remix,
				index: i,
				original: { start: 0, duration: 10, sourceIn: 0 },
			};
	},
	nestCycleInPlace(d, p, doc) {
		// An inner clip becomes a nest of the outer sequence (same span: the inner duration does not change).
		const nest = clipsOf(doc).find(({ c }) => c.kind === 'nest-video');
		if (!nest) return;
		const inner = d.sequences[(nest.c as { sequenceId: string }).sequenceId]!;
		const v = at(
			Object.values(inner.clips).filter((c) => c.kind === 'video'),
			p.a,
		);
		if (v) Object.assign(v, { kind: 'nest-video', sequenceId: nest.s.id, multicam: undefined });
	},
	breakSettings(d, p, doc) {
		const seq = at(Object.values(doc.sequences), p.a)!;
		d.sequences[seq.id]!.settings.width = 15 + (p.v % 2);
	},
	dropTrack(d, p, doc) {
		const seq = at(Object.values(doc.sequences), p.a)!;
		const list = d.sequences[seq.id]!.videoTracks;
		if (list.length > 1) list.splice(p.b % list.length, 1);
	},
	sequenceField(d, p, doc) {
		const seq = at(Object.values(doc.sequences), p.a)!;
		d.sequences[seq.id]!.inPoint = p.v % 2 ? 10 : -5;
	},
	documentField(d, p) {
		d.name = `Renamed ${p.v}`;
	},
	seqMarkerCollision(d, p, doc) {
		const seq = at(Object.values(doc.sequences), p.a)!;
		const m = d.sequences[seq.id]!.markers[0];
		if (m) m.id = at(idsOf(doc), p.b)!;
	},
	addClipCopy(d, p, doc) {
		// A new clip with fresh ids (valid when it lands in a gap) or reused ones.
		const x = at(clipsOf(doc), p.a);
		if (!x) return;
		const copy = JSON.parse(JSON.stringify(x.c)) as Clip & { opacity?: { keyframes: { id: string }[] } };
		copy.id = 'clp_00000000000005ZZ';
		copy.start = 9000 + p.v;
		copy.linkId = null;
		copy.groupId = null;
		copy.markers = [];
		if (p.c % 2) for (const k of copy.opacity?.keyframes ?? []) k.id = `kf_0000000000000${k.id.slice(-3)}`;
		d.sequences[x.s.id]!.clips[copy.id] = copy as never;
	},
};

const NAMES = Object.keys(CORRUPTIONS);

function validCommand(doc: ProjectDocument, p: Pick): unknown {
	const seq = Object.values(doc.sequences)[0]!;
	const clips = Object.values(seq.clips).sort((x, y) => x.id.localeCompare(y.id));
	const c = at(clips, p.a)?.id ?? 'clp_0000000000000000';
	switch (p.v % 9) {
		case 0:
			return { type: 'param.set', target: ['clip', c, 'opacity'], value: p.b % 100 };
		case 1:
			return { type: 'clip.move', clipIds: [c], deltaFrames: (p.b % 200) - 100 };
		case 2:
			return { type: 'clip.trim', clipId: c, edge: p.b % 2 ? 'in' : 'out', deltaFrames: (p.c % 60) - 30 };
		case 3:
			return { type: 'clip.split', at: p.b % 900, clipIds: [c] };
		case 4:
			return { type: 'clip.lift', clipIds: [c] };
		case 5:
			return {
				type: 'clip.addSolid',
				at: p.b % 900,
				duration: 1 + (p.c % 100),
				track: 'V2',
				color: [1, 0, 0, 1],
			};
		case 6:
			return { type: 'marker.add', frame: p.b % 900, name: 'x' };
		case 7:
			return {
				type: 'keyframe.add',
				target: ['clip', c, 'opacity'],
				at: { frames: p.c % 50 },
				value: p.b % 100,
			};
		default:
			return { type: 'clip.extract', clipIds: [c], syncConflict: 'cut' };
	}
}

const pickArb = fc.record({ a: fc.nat(1000), b: fc.nat(1000), c: fc.nat(1000), v: fc.nat(1000) });
const stepArb = fc.record({
	corrupt: fc.boolean(),
	name: fc.constantFrom(...NAMES),
	p: pickArb,
});

describe('incremental invariants (perf-core)', () => {
	it('tests run in verify mode (the full check decides, the incremental one must agree)', () => {
		expect(invariantMode()).toBe('verify');
	});

	it(`equals the full check on ${RUNS} random chains of edits and corruptions`, () => {
		const { doc: start, h } = baseDocument();
		const mainSeq = h.seqId;
		expect(checkInvariants(start, opts)).toEqual([]);
		const seen = new Set<string>();
		let invalid = 0;
		let applied = 0;
		fc.assert(
			fc.property(fc.array(stepArb, { minLength: 1, maxLength: 12 }), (steps) => {
				let doc = start;
				let revision = 0;
				for (const s of steps) {
					let next: ProjectDocument;
					if (s.corrupt) {
						next = produce(doc, (d) => CORRUPTIONS[s.name]!(d, s.p, doc));
						seen.add(s.name);
					} else {
						const r = applyTransaction(
							doc,
							{ label: 'step', origin: 'user', sequenceId: mainSeq, commands: [validCommand(doc, s.p)] },
							makeCtx({ revision, invariants: 'incremental' }, ids),
						);
						if (!r.result.ok) {
							// A command may refuse (E_INVARIANT) where an earlier corruption left a trap; never E_INTERNAL.
							expect(r.result.errors.some((e) => e.code === 'E_INTERNAL')).toBe(false);
							continue;
						}
						next = r.document;
						revision = r.result.revision;
						applied++;
					}
					if (next === doc) continue;
					const full = checkInvariants(next, opts);
					expect(checkTransactionInvariants(doc, next, opts, 'incremental')).toEqual(full);
					expect(checkTransactionInvariants(doc, next, opts, 'verify')).toEqual(full);
					if (full.length) invalid++;
					else doc = next;
				}
			}),
			{ numRuns: RUNS, seed: FUZZ ? undefined : 20261008 },
		);
		expect(seen.size).toBe(NAMES.length);
		expect(invalid).toBeGreaterThan(RUNS / 4);
		expect(applied).toBeGreaterThan(RUNS);
	}, 600_000);

	it('keeps the id index exact over long chains (past the flattening depth)', () => {
		const { doc: start, h } = baseDocument();
		let doc = start;
		for (let i = 0; i < 150; i++) {
			const r = applyTransaction(
				doc,
				{
					label: 'x',
					origin: 'user',
					sequenceId: h.seqId,
					commands: [
						{ type: 'marker.add', frame: 1000 + i, name: `m${i}` },
						{ type: 'clip.addSolid', at: 2000 + i * 10, duration: 5, track: 'V2', color: [1, 1, 1, 1] },
					],
				},
				makeCtx({ revision: i, invariants: 'verify' }, ids),
			);
			expect(r.result.ok, JSON.stringify(!r.result.ok && r.result.errors)).toBe(true);
			doc = r.document;
		}
		expect(isVerifiedDocument(doc, opts)).toBe(true);
	});

	it('takes the incremental path for common edits', () => {
		const { doc: start, h } = baseDocument();
		const ctx = (revision: number) => makeCtx({ revision, invariants: 'incremental' }, h.ids);
		let doc = start;
		const apply = (commands: unknown[]) => {
			const r = applyTransaction(doc, { label: 'x', origin: 'user', sequenceId: h.seqId, commands }, ctx(0));
			expect(r.result.ok, JSON.stringify(!r.result.ok && r.result.errors)).toBe(true);
			doc = r.document;
		};
		apply([{ type: 'marker.add', frame: 5, name: 'warm-up' }]);
		invariantStats(true);
		const seq = () => doc.sequences[h.seqId] as Sequence;
		const solid = () => Object.values(seq().clips).find((c) => c.kind === 'solid')!.id;
		const video = () => Object.values(seq().clips).find((c) => c.kind === 'video')!.id;
		apply([{ type: 'param.set', target: ['clip', solid(), 'opacity'], value: 40 }]);
		apply([{ type: 'clip.move', clipIds: [video()], deltaFrames: 30 }]);
		apply([{ type: 'clip.trim', clipId: video(), edge: 'out', deltaFrames: -10 }]);
		apply([{ type: 'clip.split', at: 60, clipIds: [solid()] }]);
		apply([{ type: 'keyframe.add', target: ['clip', solid(), 'opacity'], at: { frames: 3 }, value: 10 }]);
		apply([{ type: 'clip.addSolid', at: 3000, duration: 30, track: 'V2', color: [1, 0, 0, 1] }]);
		apply([{ type: 'clip.lift', clipIds: [solid()] }]);
		apply([{ type: 'effect.add', target: { clipId: video() }, effectId: 'jasper.gaussian-blur' }]);
		apply([{ type: 'clip.update', clipId: video(), patch: { enabled: false } }]);
		const s = invariantStats();
		expect(s.fallbacks).toEqual({});
		expect(s.incremental).toBe(9);
	});
});
