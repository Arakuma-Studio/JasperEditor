// First-free placement (`placement: 'first-free'` on generator clips) and the template fill hook
// (`clip.addMotionGraphic {fill}`): social-comments design §7.9 / §7.10, docs/wp-notes/social-comments.md
// "Placement & agent API".
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	checkInvariants,
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	type ProjectDocument,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { avatarCard } from './template-media-fixture.ts';

const cardParams = z.strictObject({
	handle: z.string().min(1).max(40),
	text: z.string().max(200),
	likes: z.number().int().min(0),
});

const NAMES = ['ana', 'bo', 'cy', 'dee'];
const card: MgTemplateInfo = {
	id: 'card',
	version: 1,
	name: 'Card',
	category: 'Social',
	paramsSchema: cardParams,
	defaults: { handle: 'user', text: 'Hello', likes: 0 },
	introFrames: 10,
	outroFrames: 10,
	canvasDefault: 'sequence',
	defaultDurationSeconds: 4,
	fill(partial, seed) {
		if (partial.likes === -1)
			return { ok: false, error: 'likes must not be -1', issues: [{ message: 'nope' }] };
		if (partial.text === 'throw') throw new Error('boom');
		const out: Record<string, unknown> = { ...partial };
		const filled: string[] = [];
		if (out.handle === undefined) {
			out.handle = NAMES[seed % NAMES.length]!;
			filled.push('handle');
		}
		if (out.likes === undefined) {
			out.likes = (seed * 7919) % 100_000;
			filled.push('likes');
		}
		return { ok: true, params: out, filled };
	},
};
const plain: MgTemplateInfo = { ...card, id: 'plain', fill: undefined };
const registries = defaultRegistries(createStaticMgRegistry([card, plain]));

const harness = () => new Harness({ ctx: { registries } });

const mg = (at: number, duration: number, extra: Record<string, unknown> = {}) => ({
	type: 'clip.addMotionGraphic',
	at,
	duration,
	track: 'V1',
	placement: 'first-free',
	template: { id: 'card', version: 1 },
	...extra,
});
const solid = (at: number, duration: number, track: string) => ({
	type: 'clip.addSolid',
	at,
	duration,
	track,
	color: [0, 0, 0, 1],
});

type MgResult = {
	clipId: string;
	trackId: string;
	track: string;
	createdTrack?: boolean;
	start: number;
	duration: number;
	params: Record<string, unknown>;
	filled?: string[];
	seed?: number;
};

const label = (doc: ProjectDocument, trackId: string) => {
	const seq = Object.values(doc.sequences)[0]!;
	const i = seq.videoTracks.findIndex((t) => t.id === trackId);
	return i < 0 ? null : `V${i + 1}`;
};

describe("clip.addMotionGraphic placement: 'first-free'", () => {
	it('uses the target track when it is free and the next free one above when it is busy', () => {
		const h = harness();
		const r1 = h.ok([mg(0, 60)]).results[0] as MgResult;
		expect(r1).toMatchObject({ sequenceId: h.seqId, track: 'V1', start: 0, duration: 60 });
		expect(label(h.doc, r1.trackId)).toBe('V1');
		// overlapping V1's clip → V2; touching it (starting where it ends) is free → V1 again
		const r2 = h.ok([mg(30, 60)]).results[0] as MgResult;
		expect(r2.track).toBe('V2');
		const r3 = h.ok([mg(60, 30)]).results[0] as MgResult;
		expect(r3.track).toBe('V1');
		expect(h.spans('V1')).toEqual([
			[0, 60],
			[60, 90],
		]);
		expect(h.spans('V2')).toEqual([[30, 90]]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('never trims, splits or moves other clips (sync-locked tracks included)', () => {
		const h = harness();
		h.ok([solid(0, 300, 'V1'), solid(0, 300, 'V2'), solid(100, 50, 'V3')]);
		const before = structuredClone(h.seq.clips);
		const r = h.ok([mg(90, 30)]).results[0] as MgResult;
		expect(r).toMatchObject({ track: 'V4', createdTrack: true });
		expect(h.seq.videoTracks).toHaveLength(4);
		for (const [id, c] of Object.entries(before)) expect(h.seq.clips[id]).toEqual(c);
		expect(h.seq.markers).toEqual([]);
	});

	it('skips locked tracks and adds a track on top when every track is busy or locked', () => {
		const h = harness();
		h.ok([solid(0, 100, 'V1')]);
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { locked: true } }]);
		const r = h.ok([mg(10, 20)]).results[0] as MgResult;
		expect(r.track).toBe('V3');
		h.ok([{ type: 'track.update', trackId: 'V3', patch: { locked: true } }]);
		const tracksBefore = h.seq.videoTracks.length;
		const r2 = h.ok([mg(10, 20)]).results[0] as MgResult;
		expect(r2).toMatchObject({ track: 'V4', createdTrack: true });
		expect(h.seq.videoTracks).toHaveLength(tracksBefore + 1);
		expect(h.seq.videoTracks.at(-1)!.locked).toBe(false);
		// a locked floor is skipped, not refused
		const r3 = h.ok([{ ...mg(10, 20), track: 'V2' }]).results[0] as MgResult;
		expect(r3.track).toBe('V5');
	});

	it('skips tracks whose output is off (a graphic there would be invisible in Program and export)', () => {
		const h = harness();
		h.ok([solid(0, 100, 'V1')]);
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { output: false } }]);
		const r = h.ok([mg(10, 20)]).results[0] as MgResult;
		expect(r.track).toBe('V3');
		expect(h.spans('V2')).toEqual([]);
	});

	it('starts at the given floor track (lower free tracks are not used)', () => {
		const h = harness();
		const r = h.ok([{ ...mg(0, 30), track: 'V2' }]).results[0] as MgResult;
		expect(r.track).toBe('V2');
		// a label above the existing tracks adds the missing ones, as an overwrite to that label does
		const r2 = h.ok([{ ...mg(0, 30), track: 'V5' }]).results[0] as MgResult;
		expect(r2).toMatchObject({ track: 'V5', createdTrack: true });
		expect(h.seq.videoTracks).toHaveLength(5);
		// by track id
		const v3 = h.seq.videoTracks[2]!.id;
		const r3 = h.ok([{ ...mg(0, 30), track: v3 }]).results[0] as MgResult;
		expect(r3.track).toBe('V3');
	});

	it('places a batch in one transaction without collisions (one undo step), deterministically', () => {
		const run = () => {
			const h = harness();
			h.ok([solid(0, 600, 'V1')]);
			const before = h.doc;
			const snapshot = structuredClone(before);
			const r = h.ok([mg(0, 90), mg(30, 90), mg(60, 90), mg(150, 30), mg(400, 30)]);
			return { h, before, snapshot, r };
		};
		const { h, before, snapshot, r } = run();
		const results = r.results as MgResult[];
		expect(results.map((x) => x.track)).toEqual(['V2', 'V3', 'V4', 'V2', 'V2']);
		expect(results.filter((x) => x.createdTrack)).toHaveLength(1);
		// no two clips on one track overlap
		for (const t of h.seq.videoTracks) {
			const spans = h.spans(t.id);
			for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
		}
		expect(checkInvariants(h.doc)).toEqual([]);
		// undo = the untouched document (transactions are immutable); redo = the same placement
		expect(before).toEqual(snapshot);
		expect(Object.values(before.sequences)[0]!.videoTracks).toHaveLength(3);
		const again = run();
		expect((again.r.results as MgResult[]).map((x) => [x.track, x.start, x.duration])).toEqual(
			results.map((x) => [x.track, x.start, x.duration]),
		);
		expect(again.h.doc).toEqual(h.doc);
	});

	it('refuses a track of another kind or an unknown track and changes nothing', () => {
		const h = harness();
		const before = h.doc;
		expect(h.tx([{ ...mg(0, 30), track: 'A1' }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_TRACK_KIND' }],
		});
		expect(h.tx([{ ...mg(0, 30), track: 'trk_missing' }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_NOT_FOUND' }],
		});
		expect(h.tx([mg(0, 30), { ...mg(0, 30), placement: 'sideways' }])).toMatchObject({ ok: false });
		expect(h.tx([{ ...mg(-5, 30) }])).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
		expect(h.doc).toBe(before);
	});

	it('overwrite (the default) keeps clearing the range on the given track', () => {
		const h = harness();
		h.ok([solid(0, 100, 'V2')]);
		const r = h.ok([{ ...mg(20, 30), placement: undefined, track: 'V2' }]).results[0] as MgResult;
		expect(r.track).toBe('V2');
		expect(h.spans('V2')).toEqual([
			[0, 20],
			[20, 50],
			[50, 100],
		]);
	});

	it('works for the other generator clips (text, solid, shape)', () => {
		const h = harness();
		h.ok([solid(0, 100, 'V1')]);
		const r = h.ok([
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V1',
				placement: 'first-free',
				content: { text: 'Hi' },
			},
			{ ...solid(0, 30, 'V1'), placement: 'first-free' },
			{
				type: 'clip.addShape',
				at: 0,
				duration: 30,
				track: 'V1',
				placement: 'first-free',
				shape: { type: 'rect' },
			},
		]);
		const tracks = r.results.map((x) => h.seq.clips[(x as { clipId: string }).clipId]!.trackId);
		expect(tracks.map((t) => label(h.doc, t))).toEqual(['V2', 'V3', 'V4']);
	});

	it('property: a random batch never overlaps, never touches existing clips and keeps the invariants', () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.nat(300), fc.integer({ min: 1, max: 120 }), fc.nat(2)), { maxLength: 6 }),
				fc.array(fc.tuple(fc.nat(300), fc.integer({ min: 1, max: 120 }), fc.integer({ min: 1, max: 4 })), {
					minLength: 1,
					maxLength: 12,
				}),
				fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
				(existing, batch, locks) => {
					const h = harness();
					h.ok(existing.map(([at, d, t]) => solid(at, d, `V${t + 1}`)));
					const locked = locks.flatMap((l, i) => (l ? [h.seq.videoTracks[i]!.id] : []));
					for (const id of locked) h.ok([{ type: 'track.update', trackId: id, patch: { locked: true } }]);
					const before = structuredClone(h.seq.clips);
					const r = h.ok(batch.map(([at, d, floor]) => ({ ...mg(at, d), track: `V${floor}` })));
					for (const [id, c] of Object.entries(before)) expect(h.seq.clips[id]).toEqual(c);
					for (const [i, x] of (r.results as MgResult[]).entries()) {
						expect(locked).not.toContain(x.trackId);
						const idx = h.seq.videoTracks.findIndex((t) => t.id === x.trackId);
						expect(idx).toBeGreaterThanOrEqual(batch[i]![2] - 1);
					}
					for (const t of h.seq.videoTracks) {
						const spans = h.spans(t.id);
						for (let i = 1; i < spans.length; i++)
							expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
					}
					expect(checkInvariants(h.doc)).toEqual([]);
				},
			),
			{ numRuns: 60 },
		);
	});
});

describe('clip.addMotionGraphic {fill} (template fill hook)', () => {
	it('fills only the omitted params, deterministically per seed, and reports them', () => {
		const h = harness();
		const r = h.ok([mg(0, 30, { params: { text: 'Nice' }, fill: { seed: 5 } })]).results[0] as MgResult;
		expect(r.params).toEqual({ handle: 'bo', text: 'Nice', likes: 39_595 });
		expect(r.filled).toEqual(['handle', 'likes']);
		expect(r.seed).toBe(5);
		expect((h.seq.clips[r.clipId] as unknown as { params: unknown }).params).toEqual(r.params);
		const again = harness().ok([mg(0, 30, { params: { text: 'Nice' }, fill: { seed: 5 } })])
			.results[0] as MgResult;
		expect(again.params).toEqual(r.params);
		const given = h.ok([mg(0, 30, { params: { handle: 'zed', likes: 3 }, fill: { seed: 9 } })])
			.results[0] as MgResult;
		expect(given.params).toEqual({ handle: 'zed', text: 'Hello', likes: 3 });
		expect(given.filled).toEqual([]);
	});

	it('without fill (or for a template without a hook) the defaults are merged', () => {
		const h = harness();
		const r = h.ok([mg(0, 30, { params: { text: 'x' } })]).results[0] as MgResult;
		expect(r.params).toEqual({ handle: 'user', text: 'x', likes: 0 });
		expect(r.filled).toBeUndefined();
		const p = h.ok([mg(0, 30, { template: { id: 'plain', version: 1 }, fill: { seed: 1 } })])
			.results[0] as MgResult;
		expect(p.params).toEqual({ handle: 'user', text: 'Hello', likes: 0 });
		expect(p.filled).toEqual([]);
	});

	it('refuses a failing or throwing hook and invalid filled params with E_INVALID_PARAM', () => {
		const h = harness();
		const before = h.doc;
		for (const params of [{ likes: -1 }, { text: 'throw' }, { text: 'x'.repeat(500) }]) {
			const r = h.tx([mg(0, 30, { params, fill: { seed: 1 } })]);
			expect(r).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
		}
		const failed = h.tx([mg(0, 30, { params: { likes: -1 }, fill: { seed: 1 } })]);
		expect(!failed.ok && failed.errors[0]!.message).toContain('likes must not be -1: nope');
		expect(h.tx([mg(0, 30, { fill: { seed: -1 } })])).toMatchObject({ ok: false });
		expect(h.tx([mg(0, 30, { fill: { seed: 2 ** 32 } })])).toMatchObject({ ok: false });
		expect(h.doc).toBe(before);
	});
});

describe('fill hook × template media params (WP1 checks apply to filled params)', () => {
	const filling: MgTemplateInfo = {
		...avatarCard,
		id: 'avatar-fill',
		fill(partial, seed) {
			if (partial.avatar !== undefined) return { ok: true, params: partial, filled: [] };
			return { ok: true, params: { ...partial, avatar: { mediaId: `med_${seed}` } }, filled: ['avatar'] };
		},
	};
	const regs = defaultRegistries(createStaticMgRegistry([filling]));
	const add = (extra: Record<string, unknown>) => ({
		type: 'clip.addMotionGraphic',
		at: 0,
		duration: 30,
		track: 'V1',
		placement: 'first-free',
		template: { id: 'avatar-fill', version: 1 },
		...extra,
	});

	it('refuses a filled reference to a missing medium (E_NOT_FOUND) and one of the wrong kind (E_INVALID_PARAM)', () => {
		const h = new Harness({ ctx: { registries: regs } });
		const before = h.doc;
		expect(h.tx([add({ fill: { seed: 1 } })])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_NOT_FOUND' }],
		});
		const audio = (
			h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio' }) }]).results[0] as {
				mediaId: string;
			}
		).mediaId;
		const image = (
			h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image' }) }]).results[0] as {
				mediaId: string;
			}
		).mediaId;
		const afterRegister = h.doc;
		// the given (caller or preset) value wins over the fill and is checked the same way
		expect(h.tx([add({ params: { avatar: { mediaId: audio } }, fill: { seed: 1 } })])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM' }],
		});
		expect(h.doc).toBe(afterRegister);
		const r = h.ok([add({ params: { avatar: { mediaId: image } }, fill: { seed: 1 } })])
			.results[0] as MgResult;
		expect(r.params.avatar).toEqual({ mediaId: image });
		expect(r.filled).toEqual([]);
		expect(before).not.toBe(h.doc);
	});

	it('a batch is refused as a whole when one filled item references a missing medium', () => {
		const h = new Harness({ ctx: { registries: regs } });
		const image = (
			h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image' }) }]).results[0] as {
				mediaId: string;
			}
		).mediaId;
		const before = h.doc;
		const r = h.tx([
			add({ params: { avatar: { mediaId: image } }, fill: { seed: 2 } }),
			add({ fill: { seed: 3 } }),
		]);
		expect(r).toMatchObject({ ok: false, errors: [{ code: 'E_NOT_FOUND', commandIndex: 1 }] });
		expect(h.doc).toBe(before);
	});
});

describe('layering defaults → preset → fill → caller (presets travel as given params)', () => {
	it('the fill never overrides what the preset or the caller set', () => {
		const h = harness();
		const preset = { handle: 'brand', text: 'From the preset' };
		const r = h.ok([mg(0, 30, { params: { ...preset }, fill: { seed: 5 } })]).results[0] as MgResult;
		expect(r.params).toEqual({ handle: 'brand', text: 'From the preset', likes: 39_595 });
		expect(r.filled).toEqual(['likes']);
		const caller = h.ok([mg(0, 30, { params: { ...preset, text: 'Mine', likes: 1 }, fill: { seed: 5 } })])
			.results[0] as MgResult;
		expect(caller.params).toEqual({ handle: 'brand', text: 'Mine', likes: 1 });
		expect(caller.filled).toEqual([]);
	});
});
