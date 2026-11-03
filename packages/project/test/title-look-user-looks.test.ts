// Spec 19 TL-054: the versioned user look format. Fuzzed with every other parser in `fuzz-parsers.test.ts`.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Appearance,
	appearanceBytes,
	appearanceFromRecipe,
	buildEffectPreset,
	buildLookBundle,
	checkInvariants,
	clipLook,
	defaultEffectRegistry,
	type EffectInstance,
	FACTORY_LOOKS,
	jsonDepthExceeds,
	type LookRecipe,
	parseLookFile,
	parseUserLook,
	readLookLibrary,
	recipeFromAppearance,
	recipeProblem,
	TITLE_LOOK_EFFECT_ID,
	USER_LOOK_LIBRARY_FORMAT,
	USER_LOOK_VERSION,
	type UserLook,
	userLookSource,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const recipe: LookRecipe = {
	palette: { face: [1, 0.8, 0.2, 1] },
	layers: [{ type: 'rim', params: { width: 5 } }, { type: 'face' }],
};
const look = (over: object = {}) => ({
	id: 'ulk_0123456789ABCDEF',
	version: USER_LOOK_VERSION,
	name: 'Mine',
	recipe,
	createdAt: '2026-11-02T00:00:00.000Z',
	updatedAt: '2026-11-02T00:00:00.000Z',
	...over,
});

describe('user looks (TL-054)', () => {
	it('reads a valid look and keeps unknown fields for a round trip', () => {
		const r = parseUserLook(look({ futureField: 7 }));
		expect(r.ok).toBe(true);
		expect((r as { look: Record<string, unknown> }).look.futureField).toBe(7);
	});

	it('refuses what cannot be stored, with a reason and without throwing', () => {
		for (const bad of [
			null,
			3,
			[],
			{},
			look({ id: 'nope' }),
			look({ name: '   ' }),
			look({ recipe: { layers: [{ type: 'nope' }] } }),
			look({ recipe: { layers: [{ type: 'rim', params: { width: 'wide' } }] } }),
			look({ recipe: { layers: [{ type: 'face', params: { nope: 1 } }] } }),
		]) {
			const r = parseUserLook(bad);
			expect(r.ok).toBe(false);
			expect((r as { message: string }).message.length).toBeGreaterThan(0);
		}
	});

	it('refuses a newer version instead of guessing', () => {
		const r = parseUserLook(look({ version: USER_LOOK_VERSION + 1 }));
		expect(r).toEqual({ ok: false, message: expect.stringContaining('newer') });
	});

	it('refuses a recipe over the appearance limits', () => {
		const many = { layers: Array.from({ length: 25 }, () => ({ type: 'face' })) };
		expect(recipeProblem(many)).toContain('layers');
		expect(recipeProblem({ layers: [{ type: 'face', name: 'x'.repeat(300_000) }] })).toContain('too large');
	});

	it('accepts every factory recipe', () => {
		for (const l of FACTORY_LOOKS) expect(recipeProblem(l.recipe), l.libraryId).toBeNull();
	});

	it('reads a bundle, a library file, one look and a list', () => {
		const one = look() as unknown as UserLook;
		for (const file of [
			buildLookBundle([one]),
			{ format: USER_LOOK_LIBRARY_FORMAT, version: 1, revision: 3, looks: [one] },
			one,
			[one],
		]) {
			const r = parseLookFile(file);
			expect(r.ok).toBe(true);
			expect((r as { entries: unknown[] }).entries).toHaveLength(1);
		}
	});

	it('refuses other files, newer files, empty files and huge ones', () => {
		for (const file of [
			null,
			'x',
			{ hello: 1 },
			[],
			{ format: 'jasper-title-looks', version: 1, looks: [] },
			{ format: 'jasper-title-looks', version: 99, looks: [look()] },
			{ format: 'jasper-title-looks', version: 1 },
			{ format: 'jasper-title-looks', version: 1, looks: Array.from({ length: 2001 }, () => 1) },
			['x'.repeat(9 * 1024 * 1024)],
		])
			expect(parseLookFile(file).ok).toBe(false);
	});

	it('refuses data nested too deep to measure, by name, and never throws on it (regression: RangeError)', () => {
		let deep: unknown = 1;
		for (let i = 0; i < 100_000; i++) deep = { a: deep };
		const file = { format: 'jasper-title-looks', version: 1, looks: [look({ recipe: deep })] };
		expect(parseLookFile(file)).toMatchObject({ ok: false, code: 'LOOK_TOO_DEEP' });
		expect(recipeProblem({ layers: [{ type: 'face', params: { x: deep } }] })).toMatch(/nested more than 64/);
		expect(jsonDepthExceeds(deep)).toBe(true);
		expect(jsonDepthExceeds(file.looks[0]!.recipe, 100_001)).toBe(false);
		// What JSON.stringify cannot write measures as infinitely large: every limit refuses it, nothing throws.
		const cyclic: Record<string, unknown> = { layers: [] };
		cyclic.self = cyclic;
		expect(appearanceBytes(cyclic)).toBe(Number.POSITIVE_INFINITY);
		expect(jsonDepthExceeds(cyclic)).toBe(true);
		expect(recipeProblem(cyclic)).toMatch(/nested more than/);
		// A real look is far from the bound.
		for (const f of FACTORY_LOOKS)
			expect(jsonDepthExceeds(buildLookBundle([look({ recipe: f.recipe }) as never]), 24)).toBe(false);
	});

	it('copies the looks it bundles', () => {
		const one = look() as unknown as UserLook;
		const b = buildLookBundle([one]);
		expect(b.looks[0]).not.toBe(one);
		expect(b.version).toBe(USER_LOOK_VERSION);
	});

	it('never throws on anything (property)', () => {
		fc.assert(
			fc.property(fc.anything(), (v) => {
				parseUserLook(v);
				parseLookFile(v);
				parseUserLook(look({ recipe: v }));
			}),
			{ numRuns: 300 },
		);
	});
});

describe('userLookSource: a user look given to look.apply', () => {
	it('copies the look in once, with its id as sourceId; a second apply reuses the copy', () => {
		const user = parseUserLook(
			look({
				tags: ['bold'],
				category: 'sports',
				colorways: [{ id: 'cw.mine', name: 'Mine', palette: { face: [0, 0, 1, 1] } }],
			}),
		);
		if (!user.ok) throw new Error(user.message);
		const source = userLookSource(user.look);
		expect(source).toEqual({
			name: 'Mine',
			recipe,
			sourceId: 'ulk_0123456789ABCDEF',
			tags: ['bold'],
			category: 'sports',
			colorways: [{ id: 'cw.mine', name: 'Mine', palette: { face: [0, 0, 1, 1] } }],
		});
		// No empty lists or metadata the look does not have.
		expect(Object.keys(userLookSource(look() as UserLook))).toEqual(['name', 'recipe', 'sourceId']);
		const h = new Harness();
		h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'A' }, ref: '$a' },
			{ type: 'clip.addText', at: 60, duration: 60, track: 'V2', content: { text: 'B' }, ref: '$b' },
			{ type: 'look.apply', clipIds: ['$a'], look: source },
			{ type: 'look.apply', clipIds: ['$b'], look: source },
		]);
		const copies = Object.values(h.doc.titleLooks ?? {}).filter(
			(l) => (l as { sourceId?: string }).sourceId === 'ulk_0123456789ABCDEF',
		);
		expect(copies).toHaveLength(1);
	});

	it('applying a user look is one undo step (the copy and the clip go back together), and redo is the result', () => {
		const user = parseUserLook(look());
		if (!user.ok) throw new Error(user.message);
		const h = new Harness();
		const t = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'A' }, ref: '$a' },
		]).refs.$a!;
		const before = h.doc;
		h.ok([{ type: 'look.apply', clipIds: [t], look: userLookSource(user.look) }]);
		const after = h.doc;
		expect(Object.values(after.titleLooks ?? {})).toHaveLength(1);
		// Undo is the document before (History keeps it by identity): no copy, no look on the clip.
		h.doc = before;
		expect(h.doc.titleLooks).toBeUndefined();
		expect(clipLook((h.seq.clips[t] as unknown as { effects: EffectInstance[] }).effects)).toBeNull();
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
		// Redo is the document after, and applying again from there reuses the copy.
		h.doc = after;
		h.ok([{ type: 'look.apply', clipIds: [t], look: userLookSource(user.look) }]);
		expect(Object.values(h.doc.titleLooks ?? {})).toHaveLength(1);
	});
});

describe('readLookLibrary: the engine library file (TL-054)', () => {
	const file = (over: object = {}) => ({
		format: USER_LOOK_LIBRARY_FORMAT,
		version: USER_LOOK_VERSION,
		revision: 4,
		looks: [look()],
		...over,
	});

	it('reads its looks, keeps bad and repeated entries aside, and the revision', () => {
		const r = readLookLibrary(file({ looks: [look(), look(), { id: 'nope' }], invalid: ['old'] }));
		expect(r).toMatchObject({ ok: true, newer: false, version: 1, revision: 4 });
		if (!r.ok) return;
		expect(r.looks.map((l) => l.id)).toEqual(['ulk_0123456789ABCDEF']);
		expect(r.invalid).toEqual(['old', look(), { id: 'nope' }]);
		expect(readLookLibrary(file({ revision: -1 }))).toMatchObject({ ok: true, revision: 0 });
	});

	it('refuses what is not a library, so the engine moves it aside instead of overwriting it', () => {
		for (const raw of [
			null,
			[look()],
			'text',
			{ hello: 1 },
			file({ format: 'jasper-title-looks' }),
			file({ looks: { a: look() } }),
			file({ looks: undefined }),
			file({ invalid: 3 }),
			file({ version: '1' }),
			file({ version: 0 }),
		])
			expect(readLookLibrary(raw).ok, JSON.stringify(raw)).toBe(false);
	});

	it('reads a newer library as far as it goes, flagged newer', () => {
		expect(readLookLibrary({ version: 9, looks: 'changed shape' })).toMatchObject({
			ok: true,
			newer: true,
			version: 9,
			looks: [],
		});
	});
});

describe('libraries stay apart (TL-055)', () => {
	function withEffectAndLook() {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Title' }, ref: '$t' },
			{ type: 'effect.add', target: { clipId: '$t' }, effectId: 'jasper.gaussian-blur' },
			{ type: 'look.apply', clipIds: ['$t'], lookId: 'look.clean-sans' },
		]);
		const id = r.refs.$t!;
		const stack = () => (h.seq.clips[id] as unknown as { effects: EffectInstance[] }).effects;
		return { h, id, stack };
	}

	it('never stores a look in an effect preset', () => {
		const { h, id, stack } = withEffectAndLook();
		const p = buildEffectPreset(h.doc, id, {
			name: 'P',
			type: 'scale',
			sections: { effectIds: stack().map((fx) => fx.id) },
		});
		expect(p.effects?.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur']);
	});

	it('refuses a preset of nothing but a look, and says what to do', () => {
		const { h, id, stack } = withEffectAndLook();
		const look = clipLook(stack())!;
		expect(() =>
			buildEffectPreset(h.doc, id, { name: 'P', type: 'scale', sections: { effectIds: [look.id] } }),
		).toThrow(/save it as a look/);
	});

	it('skips a look in an older preset file: the clip gets no empty instance', () => {
		const { h, id, stack } = withEffectAndLook();
		const before = stack().length;
		const old = buildEffectPreset(h.doc, id, {
			name: 'Old',
			type: 'scale',
			sections: { effectIds: stack().map((fx) => fx.id) },
		});
		old.effects = [...(old.effects ?? []), { effectId: TITLE_LOOK_EFFECT_ID, params: {} }];
		const r = h.ok([{ type: 'effect.applyPreset', preset: old, clipIds: [id] }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_PRESET_UNKNOWN_EFFECT');
		expect(stack().filter((fx) => fx.effectId === TITLE_LOOK_EFFECT_ID)).toHaveLength(1);
		expect(stack()).toHaveLength(before + 1);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});
});

describe('recipeFromAppearance', () => {
	it('turns a keyed clip look into values at a time, with no ids, keys or link', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Title' }, ref: '$t' },
			{ type: 'look.apply', clipIds: ['$t'], lookId: 'look.varsity-block' },
		]);
		const fx = clipLook((h.seq.clips[r.refs.$t!] as unknown as { effects: EffectInstance[] }).effects)!;
		const a = fx.appearance as Appearance;
		const rim = a.layers.find((l) => l.type === 'rim')!;
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx.id, rim.id, 'width'], at: { frames: 0 }, value: 2 },
			{ type: 'keyframe.add', target: ['appearance', fx.id, rim.id, 'width'], at: { frames: 30 }, value: 8 },
		]);
		const keyed = clipLook((h.seq.clips[r.refs.$t!] as unknown as { effects: EffectInstance[] }).effects)!
			.appearance as Appearance;
		const out = recipeFromAppearance(keyed, 0);
		expect(recipeProblem(out)).toBeNull();
		const s = JSON.stringify(out);
		expect(s).not.toContain('apl_');
		expect(s).not.toContain('keyframes');
		expect(s).not.toContain('lookId');
		expect(out.layers.find((l) => l.type === 'rim')!.params!.width).toBe(2);
	});

	it('round-trips every factory look: the same appearance comes back', () => {
		for (const l of FACTORY_LOOKS) {
			let n = 0;
			const id = () => `apl_${String(++n).padStart(16, '0')}`;
			const a = appearanceFromRecipe(l.recipe, id, 5);
			n = 0;
			const b = appearanceFromRecipe(recipeFromAppearance(a), id, 5);
			expect(b, l.libraryId).toEqual(a);
		}
	});

	it('keeps disabled layers, names and the fixed mark', () => {
		const a = appearanceFromRecipe(
			{
				layers: [
					{
						type: 'face',
						name: 'Top',
						enabled: false,
						fixedColor: true,
						params: { paint: { kind: 'color', color: [1, 0, 0, 1] } },
					},
				],
			},
			() => 'apl_0000000000000001',
		);
		const out = recipeFromAppearance(a).layers[0]!;
		expect(out).toMatchObject({ name: 'Top', enabled: false, fixedColor: true });
	});
});
