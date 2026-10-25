// "Add another" (`clip.duplicateMotionGraphic`, social-comments design §7.9; docs/wp-notes/social-comments.md
// "Add another & bulk import"): a copy right after the source, never overwriting, with the template's re-randomized
// params refilled from the seed and every other param, the transform and the effects copied.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type Clip,
	checkInvariants,
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	mgInstanceParams,
	mgRerollParams,
	resolveMgTemplateParams,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const schema = z.strictObject({
	variant: z.enum(['a', 'b']),
	handle: z.string().min(1).max(40),
	text: z.string().max(200),
	likes: z.number().int().min(0),
	size: z.number().min(1).max(500),
	glow: z.number().min(0).max(1),
});
const NAMES = ['ana', 'bo', 'cy', 'dee', 'eve'];
const card: MgTemplateInfo = {
	id: 'card',
	version: 1,
	name: 'Card',
	category: 'Social',
	renderer: 'anime',
	paramsSchema: schema,
	defaults: { variant: 'a', handle: 'user', text: 'Hello', likes: 0, size: 100, glow: 0.5 },
	introFrames: 10,
	outroFrames: 10,
	canvasDefault: 'sequence',
	defaultDurationSeconds: 4,
	ui: { addAnother: { reroll: ['handle', 'likes', 'glow'] } },
	fill(partial, seed) {
		if (partial.text === 'refuse') return { ok: false, error: 'no fill for this text' };
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
		if (out.glow === undefined) {
			out.glow = (seed % 10) / 10;
			filled.push('glow');
		}
		return { ok: true, params: out, filled };
	},
};
const noHint: MgTemplateInfo = { ...card, id: 'nohint', ui: undefined };
const noFill: MgTemplateInfo = { ...card, id: 'nofill', fill: undefined };
const registries = defaultRegistries(createStaticMgRegistry([card, noHint, noFill]));
const harness = () => new Harness({ ctx: { registries } });

type DupResult = {
	clipId: string;
	sourceClipId: string;
	trackId: string;
	track: string;
	createdTrack?: boolean;
	start: number;
	duration: number;
	params: Record<string, unknown>;
	rerolled: string[];
	seed: number;
};
type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;

function addCard(h: Harness, extra: Record<string, unknown> = {}, id = 'card'): string {
	const r = h.ok([
		{
			type: 'clip.addMotionGraphic',
			at: 30,
			duration: 60,
			track: 'V2',
			template: { id, version: 1 },
			params: { variant: 'b', handle: 'orig', text: 'Keep me', likes: 7, size: 250, glow: 0.9 },
			ref: '$c',
			...extra,
		},
	]);
	return r.refs.$c!;
}

const dup = (clipId: string, extra: Record<string, unknown> = {}) => ({
	type: 'clip.duplicateMotionGraphic',
	clipId,
	seed: 3,
	...extra,
});

describe('clip.duplicateMotionGraphic', () => {
	it('places the copy right after the source on its track with the same duration', () => {
		const h = harness();
		const src = addCard(h);
		const r = h.ok([dup(src)]).results[0] as DupResult;
		expect(r).toMatchObject({ sourceClipId: src, track: 'V2', start: 90, duration: 60, seed: 3 });
		expect(h.spans('V2')).toEqual([
			[30, 90],
			[90, 150],
		]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('re-randomizes only the hinted params and keeps the others', () => {
		const h = harness();
		const src = addCard(h);
		const r = h.ok([dup(src, { seed: 3 })]).results[0] as DupResult;
		expect(r.rerolled.sort()).toEqual(['glow', 'handle', 'likes']);
		expect(r.params).toEqual({
			variant: 'b',
			handle: NAMES[3],
			text: 'Keep me',
			likes: (3 * 7919) % 100_000,
			size: 250,
			glow: 0.3,
		});
		expect((h.seq.clips[r.clipId] as MgClip).params).toEqual(r.params);
		// the source is untouched
		expect((h.seq.clips[src] as MgClip).params).toMatchObject({ handle: 'orig', likes: 7 });
	});

	it('is deterministic for a seed', () => {
		const a = harness();
		const b = harness();
		const sa = addCard(a);
		const sb = addCard(b);
		expect((a.ok([dup(sa, { seed: 99 })]).results[0] as DupResult).params).toEqual(
			(b.ok([dup(sb, { seed: 99 })]).results[0] as DupResult).params,
		);
	});

	it('copies transform, effects, name and label but not links or groups', () => {
		const h = harness();
		const src = addCard(h);
		h.ok([
			{ type: 'clip.update', clipId: src, patch: { name: 'Reply card', label: 'mango' } },
			{ type: 'clip.addSolid', at: 30, duration: 60, track: 'V3', color: [0, 0, 0, 1], ref: '$s' },
		]);
		const solidId = Object.values(h.seq.clips).find((c) => c.kind === 'solid')!.id;
		h.ok([{ type: 'clip.group', clipIds: [src, solidId] }]);
		const source = h.seq.clips[src] as MgClip;
		const r = h.ok([dup(src)]).results[0] as DupResult;
		const copy = h.seq.clips[r.clipId] as MgClip;
		expect(copy.name).toBe('Reply card');
		expect(copy.label).toBe('mango');
		expect(copy.transform).toEqual(source.transform);
		expect(copy.template).toEqual(source.template);
		expect(copy.canvas).toEqual(source.canvas);
		expect(copy.groupId).toBeNull();
		expect(copy.linkId).toBeNull();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('never overwrites: a busy range sends the copy to the next free track up', () => {
		const h = harness();
		const src = addCard(h);
		h.ok([{ type: 'clip.addSolid', at: 100, duration: 30, track: 'V2', color: [1, 0, 0, 1] }]);
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V3', color: [1, 0, 0, 1] }]);
		const before = structuredClone(h.seq.clips);
		const r = h.ok([dup(src)]).results[0] as DupResult;
		expect(r).toMatchObject({ track: 'V4', createdTrack: true, start: 90 });
		for (const [id, c] of Object.entries(before)) expect(h.seq.clips[id]).toEqual(c);
	});

	it('takes at and track (the lowest track tried)', () => {
		const h = harness();
		const src = addCard(h);
		const r = h.ok([dup(src, { at: { seconds: 10 }, track: 'V1' })]).results[0] as DupResult;
		expect(r).toMatchObject({ track: 'V1', start: 300 });
	});

	it('skips locked tracks instead of refusing', () => {
		const h = harness();
		const src = addCard(h);
		const v2 = h.seq.videoTracks[1]!.id;
		h.ok([{ type: 'track.update', trackId: v2, patch: { locked: true } }]);
		const r = h.ok([dup(src)]).results[0] as DupResult;
		expect(r.track).toBe('V3');
	});

	it('given params win and are not re-randomized', () => {
		const h = harness();
		const src = addCard(h);
		const r = h.ok([dup(src, { params: { handle: 'given', text: 'New text' } })]).results[0] as DupResult;
		expect(r.params).toMatchObject({ handle: 'given', text: 'New text', size: 250 });
		expect(r.rerolled.sort()).toEqual(['glow', 'likes']);
	});

	it('drops the keyframes of re-randomized and given params, keeps the others', () => {
		const h = harness();
		const src = addCard(h);
		const key = (name: string, frames: number, value: number) => ({
			type: 'keyframe.add',
			target: ['clip', src, 'params', name],
			at: { frames },
			value,
		});
		h.ok([key('glow', 0, 0.1), key('glow', 30, 0.9), key('size', 0, 10), key('size', 30, 90)]);
		const clip = h.seq.clips[src] as MgClip & { paramKeyframes?: Record<string, unknown[]> };
		expect(Object.keys(clip.paramKeyframes ?? {}).sort()).toEqual(['glow', 'size']);
		const r = h.ok([dup(src)]).results[0] as DupResult;
		const copy = h.seq.clips[r.clipId] as typeof clip;
		expect(Object.keys(copy.paramKeyframes ?? {})).toEqual(['size']);
		expect(checkInvariants(h.doc)).toEqual([]);
		const r2 = h.ok([dup(src, { params: { size: 120 } })]).results[0] as DupResult;
		expect((h.seq.clips[r2.clipId] as typeof clip).paramKeyframes).toBeUndefined();
	});

	it('templates without the hint or without a fill copy every param', () => {
		for (const id of ['nohint', 'nofill']) {
			const h = harness();
			const src = addCard(h, {}, id);
			const r = h.ok([dup(src)]).results[0] as DupResult;
			expect(r.rerolled).toEqual([]);
			expect(r.params).toEqual((h.seq.clips[src] as MgClip).params);
		}
	});

	it('chains through refs (several copies in one transaction, one after another)', () => {
		const h = harness();
		const src = addCard(h);
		const r = h.ok([
			dup(src, { seed: 1, ref: '$a' }),
			dup('$a', { seed: 2, ref: '$b' }),
			dup('$b', { seed: 3 }),
		]);
		expect(r.results.map((x) => (x as DupResult).start)).toEqual([90, 150, 210]);
		expect(h.spans('V2')).toEqual([
			[30, 90],
			[90, 150],
			[150, 210],
			[210, 270],
		]);
	});

	describe('refusals (nothing changes)', () => {
		const refused = (h: Harness, cmd: Record<string, unknown>, code: string) => {
			const before = h.doc;
			const r = h.tx([cmd]);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code).toBe(code);
			expect(h.doc).toBe(before);
		};
		it('refuses an unknown clip, a clip of another kind and a template that is not installed', () => {
			const h = harness();
			refused(h, dup('clp_missing'), 'E_NOT_FOUND');
			h.ok([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 0, 1] }]);
			const solid = Object.values(h.seq.clips)[0]!.id;
			refused(h, dup(solid), 'E_INVALID_PARAM');
			const src = addCard(h);
			const doc = structuredClone(h.doc);
			(Object.values(doc.sequences)[0]!.clips[src] as MgClip).template.id = 'gone';
			h.doc = doc;
			refused(h, dup(src), 'E_INVALID_PARAM');
		});
		it('refuses params the template rejects, a refused fill, an audio track and a negative start', () => {
			const h = harness();
			const src = addCard(h);
			refused(h, dup(src, { params: { size: 9999 } }), 'E_INVALID_PARAM');
			refused(h, dup(src, { params: { text: 'refuse' } }), 'E_INVALID_PARAM');
			refused(h, dup(src, { track: 'A1' }), 'E_TRACK_KIND');
			refused(h, dup(src, { at: -5 }), 'E_INVALID_PARAM');
		});
		it('refuses a seed outside uint32 at the schema', () => {
			const h = harness();
			const src = addCard(h);
			refused(h, dup(src, { seed: -1 }), 'E_SCHEMA');
		});
	});

	it('dry runs report the copy without storing it', () => {
		const h = harness();
		const src = addCard(h);
		const before = h.doc;
		const r = h.tx([dup(src)], { dryRun: true });
		expect(r.ok).toBe(true);
		if (r.ok) expect((r.results[0] as DupResult).start).toBe(90);
		expect(h.doc).toBe(before);
	});

	it('property: copies never overlap other clips on their track and invariants hold', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						at: fc.integer({ min: 0, max: 400 }),
						len: fc.integer({ min: 1, max: 120 }),
						track: fc.constantFrom('V1', 'V2', 'V3'),
					}),
					{ maxLength: 8 },
				),
				fc.integer({ min: 0, max: 0xffff_ffff }),
				(solids, seed) => {
					const h = harness();
					const src = addCard(h);
					for (const s of solids)
						h.tx([{ type: 'clip.addSolid', at: s.at, duration: s.len, track: s.track, color: [0, 0, 0, 1] }]);
					const before = Object.keys(h.seq.clips).length;
					const sourceNow = h.seq.clips[src];
					if (!sourceNow) return; // an overwrite removed the card
					const r = h.ok([dup(src, { seed })]).results[0] as DupResult;
					expect(Object.keys(h.seq.clips)).toHaveLength(before + 1);
					const copy = h.seq.clips[r.clipId]!;
					for (const c of Object.values(h.seq.clips))
						if (c.id !== copy.id && c.trackId === copy.trackId)
							expect(c.start >= copy.start + copy.duration || c.start + c.duration <= copy.start).toBe(true);
					expect(checkInvariants(h.doc)).toEqual([]);
				},
			),
			{ numRuns: 60 },
		);
	});
});

describe('mgRerollParams / mgInstanceParams / resolveMgTemplateParams', () => {
	it('lists the reroll hint only with a fill hook', () => {
		expect(mgRerollParams(card)).toEqual(['handle', 'likes', 'glow']);
		expect(mgRerollParams(noFill)).toEqual([]);
		expect(mgRerollParams(noHint)).toEqual([]);
		// a catalogue entry / import view (JSON, no hook key): the registry only accepts the hint with a hook
		expect(mgRerollParams({ ui: { addAnother: { reroll: ['handle', 'handle', 'likes'] } } })).toEqual([
			'handle',
			'likes',
		]);
	});

	it('mgInstanceParams: base (preset or copied clip) without the per-instance params not given, given over it', () => {
		const preset = { handle: 'username', likes: 9, glow: true, text: 'Look' };
		expect(mgInstanceParams(card, preset, { likes: 3 })).toEqual({
			params: { text: 'Look', likes: 3 },
			reroll: ['handle', 'glow'],
		});
		expect(mgInstanceParams(card, undefined, undefined)).toEqual({
			params: {},
			reroll: ['handle', 'likes', 'glow'],
		});
		// no fill hook / no hint: the base is kept as it is
		expect(mgInstanceParams(noFill, preset, {}).params).toEqual(preset);
		expect(mgInstanceParams(noHint, preset, { text: 'x' }).params).toEqual({ ...preset, text: 'x' });
	});
	it('resolves like clip.addMotionGraphic (fill → defaults → schema → media)', () => {
		const r = resolveMgTemplateParams(card, { text: 'Hi' }, { seed: 2, media: {} });
		expect(r).toEqual({
			ok: true,
			params: {
				variant: 'a',
				handle: NAMES[2],
				text: 'Hi',
				likes: (2 * 7919) % 100_000,
				size: 100,
				glow: 0.2,
			},
			filled: ['handle', 'likes', 'glow'],
		});
		expect(resolveMgTemplateParams(card, { size: 0 }, { seed: 2, media: {} })).toMatchObject({
			ok: false,
			code: 'E_INVALID_PARAM',
		});
		expect(resolveMgTemplateParams(card, { text: 'refuse' }, { seed: 2, media: {} })).toMatchObject({
			ok: false,
			message: expect.stringContaining('no fill for this text'),
		});
		const throwing: MgTemplateInfo = {
			...card,
			fill: () => {
				throw new Error('boom');
			},
		};
		expect(resolveMgTemplateParams(throwing, {}, { seed: 1, media: {} })).toMatchObject({
			ok: false,
			message: expect.stringContaining('boom'),
		});
		// without a seed, no fill
		expect(resolveMgTemplateParams(card, {}, { media: {} })).toMatchObject({
			ok: true,
			params: card.defaults,
			filled: [],
		});
	});
});
