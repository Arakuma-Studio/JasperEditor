// Tests ported from FilmCraft crates/edit/src/tests.rs (`never_overlaps`, `insert_then_extract_is_identity`).
// MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyTransaction,
	type Clip,
	checkInvariants,
	createRandomIdSource,
	flicksPerFrame,
	type ProjectDocument,
	RATES,
	type Sequence,
} from '../src/index.ts';
import { Harness, makeCtx } from './helpers.ts';

const F30 = flicksPerFrame(RATES.r30);

type Op =
	| { k: 'over'; track: number; at: number; dur: number; src: number }
	| { k: 'ins'; track: number; at: number; dur: number; src: number }
	| { k: 'razor'; at: number }
	| { k: 'extract'; at: number; dur: number }
	| { k: 'trimOut'; clip: number; delta: number }
	| { k: 'rippleTrim'; clip: number; edge: boolean; delta: number; linked: boolean }
	| { k: 'splitTrim'; clip: number; edge: boolean; delta: number }
	| { k: 'rippleDelete'; clip: number; linked: boolean }
	| { k: 'speed'; clip: number; rate: number }
	| { k: 'move'; clip: number; delta: number; insert: boolean };

const op: fc.Arbitrary<Op> = fc.oneof(
	fc.record({
		k: fc.constant('over' as const),
		track: fc.nat(2),
		at: fc.integer({ min: 0, max: 200 }),
		dur: fc.integer({ min: 1, max: 50 }),
		src: fc.integer({ min: 0, max: 100 }),
	}),
	fc.record({
		k: fc.constant('ins' as const),
		track: fc.nat(2),
		at: fc.integer({ min: 0, max: 200 }),
		dur: fc.integer({ min: 1, max: 50 }),
		src: fc.integer({ min: 0, max: 100 }),
	}),
	fc.record({ k: fc.constant('razor' as const), at: fc.integer({ min: 0, max: 250 }) }),
	fc.record({
		k: fc.constant('extract' as const),
		at: fc.integer({ min: 0, max: 200 }),
		dur: fc.integer({ min: 1, max: 30 }),
	}),
	fc.record({
		k: fc.constant('trimOut' as const),
		clip: fc.nat(19),
		delta: fc.integer({ min: -20, max: 20 }),
	}),
	fc.record({
		k: fc.constant('rippleTrim' as const),
		clip: fc.nat(19),
		edge: fc.boolean(),
		delta: fc.integer({ min: -20, max: 20 }),
		linked: fc.boolean(),
	}),
	fc.record({
		k: fc.constant('splitTrim' as const),
		clip: fc.nat(19),
		edge: fc.boolean(),
		delta: fc.integer({ min: -15, max: 15 }),
	}),
	fc.record({ k: fc.constant('rippleDelete' as const), clip: fc.nat(19), linked: fc.boolean() }),
	fc.record({ k: fc.constant('speed' as const), clip: fc.nat(19), rate: fc.constantFrom(0.5, 2, 1.5) }),
	fc.record({
		k: fc.constant('move' as const),
		clip: fc.nat(19),
		delta: fc.integer({ min: -40, max: 40 }),
		insert: fc.boolean(),
	}),
);

const TRACKS = ['V1', 'V2', 'A1'] as const;

/** Clip ids in track order (as FilmCraft's `all_tracks().flat_map(items)`). */
function orderedIds(seq: Sequence): string[] {
	const order = [...seq.videoTracks, ...seq.audioTracks].map((t) => t.id);
	return Object.values(seq.clips)
		.sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId) || a.start - b.start)
		.map((c) => c.id);
}

function linkedIds(seq: Sequence, id: string): string[] {
	const c = seq.clips[id];
	if (!c?.linkId) return [id];
	return seq.links[c.linkId]?.members.filter((m) => seq.clips[m]) ?? [id];
}

function concretize(o: Op, doc: ProjectDocument, media: { av: string; v: string; a: string }): unknown[] {
	const seq = Object.values(doc.sequences)[0]!;
	const ids = orderedIds(seq);
	const pick = (i: number) => (ids.length ? ids[i % ids.length] : undefined);
	const src = (o: { src: number; dur: number }) => ({
		in: { flicks: o.src * F30 },
		out: { flicks: (o.src + o.dur) * F30 },
	});
	switch (o.k) {
		case 'over':
		case 'ins': {
			const track = TRACKS[o.track]!;
			const mediaId = track === 'A1' ? media.a : media.v;
			return [
				{
					type: 'clip.place',
					source: { mediaId },
					at: o.at,
					mode: o.k === 'ins' ? 'insert' : 'overwrite',
					tracks: track === 'A1' ? { audio: 'A1' } : { video: track },
					sourceRange: src(o),
				},
			];
		}
		case 'razor':
			return o.at > 0 ? [{ type: 'clip.split', at: o.at, scope: 'all-unlocked' }] : [];
		case 'extract':
			return [{ type: 'range.extract', from: o.at, to: o.at + o.dur, tracks: ['V1'] }];
		case 'trimOut': {
			const c = pick(o.clip);
			return c ? [{ type: 'clip.trim', clipId: c, edge: 'out', deltaFrames: o.delta }] : [];
		}
		case 'rippleTrim': {
			const c = pick(o.clip);
			return c
				? [
						{
							type: 'clip.trim',
							clipId: c,
							edge: o.edge ? 'in' : 'out',
							deltaFrames: o.delta,
							mode: 'ripple',
							linked: o.linked,
						},
					]
				: [];
		}
		case 'splitTrim': {
			const c = pick(o.clip);
			return c
				? [{ type: 'clip.trim', clipId: c, edge: o.edge ? 'in' : 'out', deltaFrames: o.delta, linked: false }]
				: [];
		}
		case 'rippleDelete': {
			const c = pick(o.clip);
			return c ? [{ type: 'clip.extract', clipIds: o.linked ? linkedIds(seq, c) : [c] }] : [];
		}
		case 'speed': {
			const c = pick(o.clip);
			return c ? [{ type: 'clip.setSpeed', clipIds: linkedIds(seq, c), rate: o.rate, ripple: true }] : [];
		}
		case 'move': {
			const c = pick(o.clip);
			return c
				? [
						{
							type: 'clip.move',
							clipIds: linkedIds(seq, c),
							deltaFrames: o.delta,
							mode: o.insert ? 'insert' : 'overwrite',
						},
					]
				: [];
		}
	}
}

function setup(): { h: Harness; media: { av: string; v: string; a: string } } {
	const h = new Harness({ seed: 11 });
	const av = h.registerVideo({ seconds: 60 });
	const v = h.registerVideo({ seconds: 60, audio: false });
	const a = h.registerVideo({ seconds: 60, kind: 'audio' });
	// Two linked V/A clips with a J cut between them, as a split-edit starting point.
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: av },
			at: 0,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 4 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: av },
			at: 60,
			tracks: { video: 'V1', audio: 'A1' },
			sourceRange: { in: { seconds: 10 }, out: { seconds: 12 } },
		},
	]);
	const sound2 = h.clips('A1')[1]!.id;
	h.ok([{ type: 'clip.trim', clipId: h.clips('A1')[0]!.id, edge: 'out', deltaFrames: -10, linked: false }]);
	h.ok([{ type: 'clip.trim', clipId: sound2, edge: 'in', deltaFrames: -10, linked: false }]);
	return { h, media: { av, v, a } };
}

function overlapsOrNegative(seq: Sequence): string | null {
	const byTrack = new Map<string, Clip[]>();
	for (const c of Object.values(seq.clips)) byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), c]);
	for (const list of byTrack.values()) {
		list.sort((a, b) => a.start - b.start);
		for (let i = 0; i < list.length; i++) {
			if (list[i]!.start < 0) return `clip ${list[i]!.id} starts before 0`;
			if (i > 0 && list[i - 1]!.start + list[i - 1]!.duration > list[i]!.start)
				return `clips ${list[i - 1]!.id} and ${list[i]!.id} overlap`;
		}
	}
	return null;
}

describe('FilmCraft never_overlaps (fast-check over Jasper command handlers)', () => {
	it('random overwrite/insert/razor/extract/trim/ripple/split-edit ops never overlap or break invariants', () => {
		const { h, media } = setup();
		const base = h.doc;
		const ids = createRandomIdSource();
		const stats = new Map<string, { ok: number; refused: number }>();
		fc.assert(
			fc.property(fc.array(op, { minLength: 1, maxLength: 40 }), (ops) => {
				let doc = base;
				let revision = 0;
				for (const o of ops) {
					const commands = concretize(o, doc, media);
					if (!commands.length) continue;
					const { document, result } = applyTransaction(
						doc,
						{ label: 'prop', origin: 'user', commands },
						makeCtx({ revision }, ids),
					);
					const st = stats.get(o.k) ?? { ok: 0, refused: 0 };
					stats.set(o.k, st);
					if (result.ok) st.ok++;
					else st.refused++;
					if (!result.ok) {
						if (document !== doc) throw new Error('a refused edit changed the document');
						const bad = result.errors.filter((e) => e.code === 'E_INVARIANT' || e.code === 'E_INTERNAL');
						if (bad.length) throw new Error(`${JSON.stringify(bad)} for ${JSON.stringify(commands)}`);
						continue;
					}
					const seq = Object.values(document.sequences)[0]!;
					const bad = overlapsOrNegative(seq);
					if (bad) throw new Error(`${bad} after ${JSON.stringify(commands)}`);
					const issues = checkInvariants(document);
					if (issues.length)
						throw new Error(`invariants ${JSON.stringify(issues)} after ${JSON.stringify(commands)}`);
					doc = document;
					revision = result.revision;
				}
			}),
			{ numRuns: 150 },
		);
		// Every kind of op must actually exercise the handlers, not just be refused.
		for (const k of [
			'over',
			'ins',
			'razor',
			'extract',
			'trimOut',
			'rippleTrim',
			'splitTrim',
			'rippleDelete',
			'speed',
			'move',
		])
			expect(stats.get(k)?.ok ?? 0, `${k}: ${JSON.stringify(stats.get(k))}`).toBeGreaterThan(20);
	});
});

/** Visible content per frame on a track: `mediaId@sourceFrame` or '' for a gap. */
function contentAt(seq: Sequence, trackId: string, frames: number): string[] {
	const out: string[] = Array.from({ length: frames }, () => '');
	for (const c of Object.values(seq.clips)) {
		if (c.trackId !== trackId) continue;
		const m = (c as { mediaId?: string }).mediaId ?? c.kind;
		for (let f = c.start; f < c.start + c.duration && f < frames; f++)
			out[f] = `${m}@${Math.round(c.sourceIn / F30 + (f - c.start) * c.speed.rate)}`;
	}
	return out;
}

describe('FilmCraft insert_then_extract_is_identity', () => {
	it('inserting a clip and extracting the same range restores every track frame for frame', () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 1, max: 39 }), (s, d) => {
				const h = new Harness({ seed: 3 });
				const v = h.registerVideo({ seconds: 60, audio: false });
				const a = h.registerVideo({ seconds: 60, kind: 'audio' });
				const put = (track: string, at: number, dur: number, src: number, mediaId: string) => ({
					type: 'clip.place',
					source: { mediaId },
					at,
					tracks: track.startsWith('A') ? { audio: track } : { video: track },
					sourceRange: { in: { flicks: src * F30 }, out: { flicks: (src + dur) * F30 } },
				});
				h.ok([put('V1', 0, 60, 0, v), put('V1', 70, 30, 100, v), put('A1', 10, 80, 0, a)]);
				const tracks = [h.seq.videoTracks[0]!.id, h.seq.audioTracks[0]!.id];
				const before = tracks.map((t) => contentAt(h.seq, t, 200));
				const ins = h.registerVideo({ seconds: 60, audio: false });
				h.ok([{ ...put('V1', s, d, 0, ins), mode: 'insert' }]);
				h.ok([{ type: 'range.extract', from: s, to: s + d, tracks: ['V1'] }]);
				const after = tracks.map((t) => contentAt(h.seq, t, 200));
				expect(after).toEqual(before);
				expect(checkInvariants(h.doc)).toEqual([]);
			}),
			{ numRuns: 100 },
		);
	});
});
