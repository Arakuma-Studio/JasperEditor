// Spec 19 TL-050 / TL-051 / TL-053 and §14 "Library checks": every factory look parses, passes the lint at error level
// with every colourway, keeps its colours in roles, and no shipped text holds a banned name.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Appearance,
	appearanceFromRecipe,
	appearanceProblem,
	applyColorway,
	type Clip,
	COLOR_ROLES,
	chooseLookFont,
	clipLook,
	type EffectInstance,
	FACTORY_COLORWAYS,
	FACTORY_LOOKS,
	FACTORY_TEMPLATES,
	factoryColorway,
	factoryLook,
	foldSearchText,
	hasJapanese,
	LOOK_CATEGORIES,
	LookRecipeSchema,
	labOf,
	lintAppearance,
	lookCategory,
	lookCategoryCounts,
	type Paint,
	paintRoles,
	repairAppearance,
	searchLooks,
	searchTemplates,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const code = (r: ReturnType<Harness['tx']>) => (r.ok ? 'ok' : r.errors[0]?.code);

const here = dirname(fileURLToPath(import.meta.url));
const FACTORY_DIR = join(here, '..', 'src', 'title-looks', 'factory');

const appearanceOf = (recipe: (typeof FACTORY_LOOKS)[number]['recipe']): Appearance => {
	let n = 0;
	return appearanceFromRecipe(recipe, () => `apl_${String(++n).padStart(16, '0')}`, 7);
};

const paintsOf = (params: Record<string, unknown> | undefined): Paint[] =>
	Object.values(params ?? {}).filter((v): v is Paint => {
		const k = (v as { kind?: unknown } | null)?.kind;
		return k === 'role' || k === 'color' || k === 'gradient' || k === 'source';
	});

describe('the library (TL-050)', () => {
	it('has the categories of the spec, general styles first, with pachinko as one among them', () => {
		expect(LOOK_CATEGORIES.map((c) => c.label)).toEqual([
			'Clean',
			'Corporate',
			'Cinematic',
			'Sports',
			'Gaming',
			'Neon & Retro',
			'Comic',
			'Luxury',
			'Horror',
			'Playful',
			'Social',
			'Japanese Variety',
			'Pachinko & Arcade',
			'Brush',
			'Drawn Depth',
			'3D',
		]);
		for (const c of LOOK_CATEGORIES) expect(c.labelEs.length).toBeGreaterThan(0);
	});

	it('holds at least 60 looks in at least 12 categories, every category filled, and none holds more than a quarter', () => {
		const counts = lookCategoryCounts();
		expect(FACTORY_LOOKS.length).toBeGreaterThanOrEqual(60);
		expect(counts.filter((c) => c.count > 0).length).toBeGreaterThanOrEqual(15);
		// Every category is filled: with looks, or, for 3D, with templates. A look cannot hold an Advanced 3D solid
		// (TL-055), so 3D is the category of the solid templates and no look claims it; depth a look draws is Drawn Depth.
		for (const c of counts)
			if (c.id === '3d') {
				expect(c.count, 'no look is called 3D').toBe(0);
				expect(FACTORY_TEMPLATES.filter((t) => t.category === '3d').length).toBeGreaterThanOrEqual(4);
			} else expect(c.count, c.id).toBeGreaterThan(0);
		expect(counts.find((c) => c.id === 'drawn-depth')!.count).toBe(4);
		for (const c of counts) expect(c.count, c.id).toBeLessThanOrEqual(FACTORY_LOOKS.length / 4);
	});

	it('uses the finishes, glows and generators, and keeps a generator’s own colours only where it is marked fixed', () => {
		const types = new Set(FACTORY_LOOKS.flatMap((l) => l.recipe.layers.map((x) => x.type)));
		const finishes = new Set(
			FACTORY_LOOKS.flatMap((l) => l.recipe.layers.map((x) => x.params?.finish).filter(Boolean)),
		);
		expect([...types].filter((t) => t.startsWith('generator:')).length).toBeGreaterThanOrEqual(8);
		for (const t of ['extrude', 'plate', 'texture', 'gloss', 'innerGlow', 'deepGlow', 'sheen'])
			expect(types.has(t), t).toBe(true);
		for (const f of ['metal', 'bevel', 'glass', 'gloss', 'pattern', 'gradientMap'])
			expect(finishes.has(f), f).toBe(true);
		for (const l of FACTORY_LOOKS)
			for (const x of l.recipe.layers)
				if (x.type.startsWith('generator:') && x.params?.ownColors === true)
					expect(x.fixedColor, `${l.libraryId}: ${x.type}`).toBe(true);
	});

	it('does not read as a pachinko tool: the first looks are general, and its category stays a minority', () => {
		const counts = lookCategoryCounts();
		const pachinko = counts.find((c) => c.id === 'pachinko-arcade')!.count;
		expect(pachinko / FACTORY_LOOKS.length).toBeLessThanOrEqual(0.15);
		expect(FACTORY_LOOKS[0]!.category).toBe('clean');
		expect(searchLooks(FACTORY_LOOKS)[0]!.category).not.toBe('pachinko-arcade');
	});

	it('gives every look unique ids, names and complete metadata', () => {
		const ids = new Set(FACTORY_LOOKS.map((l) => l.libraryId));
		expect(ids.size).toBe(FACTORY_LOOKS.length);
		expect(new Set(FACTORY_LOOKS.map((l) => l.name)).size).toBe(FACTORY_LOOKS.length);
		for (const l of FACTORY_LOOKS) {
			expect(l.libraryId).toMatch(/^look\.[a-z0-9-]+$/);
			expect(lookCategory(l.category), l.libraryId).toBeTruthy();
			expect(l.nameEs, l.libraryId).toBeTruthy();
			expect(l.description.length, l.libraryId).toBeGreaterThan(10);
			expect(l.tags.length, l.libraryId).toBeGreaterThanOrEqual(3);
			expect(l.tags.length).toBeLessThanOrEqual(64);
			for (const t of l.tags) expect(t.length).toBeLessThanOrEqual(64);
			expect(factoryLook(l.libraryId)).toBe(l);
		}
	});

	it('parses every recipe and stores a valid appearance', () => {
		for (const l of FACTORY_LOOKS) {
			const r = LookRecipeSchema.safeParse(l.recipe);
			expect(r.success, l.libraryId).toBe(true);
			expect(appearanceProblem(appearanceOf(l.recipe)), l.libraryId).toBeNull();
		}
	});

	it('names a font with a weight, a fallback and a Japanese face on every look', () => {
		for (const l of FACTORY_LOOKS) {
			const f = l.recipe.font!;
			expect(f.family, l.libraryId).toBeTruthy();
			expect(f.weight, l.libraryId).toBeGreaterThan(0);
			expect(f.fallback ?? f.family, l.libraryId).toBeTruthy();
			expect(f.ja?.family ?? f.family, l.libraryId).toBeTruthy();
		}
	});

	it('keeps every colour in a role unless the layer is marked fixed, and has a role per layer that paints', () => {
		for (const l of FACTORY_LOOKS)
			for (const layer of l.recipe.layers) {
				const paints = paintsOf(layer.params);
				for (const p of paints) {
					const stops = p.kind === 'gradient' ? p.gradient.stops : [];
					const free = p.kind === 'color' || stops.some((s) => 'color' in s.paint);
					if (free) expect(layer.fixedColor, `${l.libraryId}: ${layer.type}`).toBe(true);
					if (!layer.fixedColor && p.kind !== 'source')
						expect(paintRoles(p).length, `${l.libraryId}: ${layer.type}`).toBeGreaterThan(0);
				}
			}
	});

	it('passes the lint at error level with every colourway, and is warning-free in its own', () => {
		for (const l of FACTORY_LOOKS) {
			const mine = lintAppearance(appearanceOf(l.recipe), { clipKind: 'text' });
			expect(mine.issues, l.libraryId).toEqual([]);
			for (const way of FACTORY_COLORWAYS) {
				const a = appearanceOf(l.recipe);
				applyColorway(a, way);
				const errors = lintAppearance(a, { clipKind: 'text' }).issues.filter((i) => i.severity === 'error');
				expect(errors, `${l.libraryId} in ${way.id}`).toEqual([]);
			}
		}
	});

	it('uses a real colourway as each look’s own palette', () => {
		for (const l of FACTORY_LOOKS) {
			expect(factoryColorway(l.colorwayId)?.palette, l.libraryId).toEqual(l.recipe.palette);
			expect(l.suggestedColorways[0]).toBe(l.colorwayId);
			expect(l.suggestedColorways.length).toBeGreaterThanOrEqual(3);
			for (const c of l.suggestedColorways) expect(factoryColorway(c), `${l.libraryId}: ${c}`).toBeTruthy();
		}
	});
});

describe('colourways (TL-051)', () => {
	it('ships at least 12, usable with any look', () => {
		expect(FACTORY_COLORWAYS.length).toBeGreaterThanOrEqual(12);
		expect(new Set(FACTORY_COLORWAYS.map((c) => c.id)).size).toBe(FACTORY_COLORWAYS.length);
	});

	it('fills every role explicitly, with Spanish names and tags', () => {
		for (const c of FACTORY_COLORWAYS) {
			expect(Object.keys(c.palette).sort(), c.id).toEqual([...COLOR_ROLES].sort());
			expect(c.nameEs, c.id).toBeTruthy();
			expect(c.tags.length, c.id).toBeGreaterThan(0);
		}
	});

	it('keeps what the roles promise a look: rings alternate, light is bright, shadows are tinted', () => {
		const L = (c: readonly number[]) => labOf(c)[0];
		for (const { id, palette: p } of FACTORY_COLORWAYS) {
			expect(Math.abs(L(p.face) - L(p.keyline)), `${id}: face/keyline`).toBeGreaterThanOrEqual(25);
			expect(Math.abs(L(p.keyline) - L(p.accent1)), `${id}: keyline/accent1`).toBeGreaterThanOrEqual(25);
			expect(Math.abs(L(p.accent1) - L(p.accent2)), `${id}: accent1/accent2`).toBeGreaterThanOrEqual(15);
			expect(L(p.glow), `${id}: glow`).toBeGreaterThanOrEqual(60);
			expect(L(p.shadow), `${id}: shadow`).toBeLessThanOrEqual(25);
			expect(
				p.shadow.slice(0, 3).some((v) => v > 0),
				`${id}: shadow is not pure black`,
			).toBe(true);
		}
	});

	it('keeps structure when applied: only role values change', () => {
		const look = FACTORY_LOOKS.find((l) => l.libraryId === 'look.gold-ladder')!;
		const a = appearanceOf(look.recipe);
		const before = JSON.stringify(a.layers);
		applyColorway(a, factoryColorway('colorway.cobalt')!);
		expect(JSON.stringify(a.layers)).toBe(before);
		expect(a.palette.face!.value).toEqual(factoryColorway('colorway.cobalt')!.palette.face);
		expect(a.colorwayId).toBe('colorway.cobalt');
	});
});

describe('search (TL-050)', () => {
	const ids = (q: Parameters<typeof searchLooks>[1]) => searchLooks(FACTORY_LOOKS, q).map((l) => l.libraryId);

	it('folds accents, width and kana', () => {
		expect(foldSearchText('Neón')).toBe('neon');
		expect(foldSearchText('ネオン')).toBe(foldSearchText('ねおん'));
		expect(foldSearchText('ﾈｵﾝ')).toBe(foldSearchText('ねおん'));
		expect(foldSearchText('ＧＯＬＤ')).toBe('gold');
		expect(foldSearchText('ガ')).not.toBe(foldSearchText('カ'));
	});

	it('finds looks in English, Spanish and Japanese, whatever the kana', () => {
		expect(ids({ query: 'neon' })).toContain('look.neon-tube');
		expect(ids({ query: 'neón' })).toEqual(ids({ query: 'neon' }));
		expect(ids({ query: 'ネオン' })).toContain('look.neon-tube');
		expect(ids({ query: 'ねおん' })).toEqual(ids({ query: 'ネオン' }));
		expect(ids({ query: 'ﾈｵﾝ' })).toEqual(ids({ query: 'ネオン' }));
		expect(ids({ query: 'oro' })).toContain('look.engraved-gold');
		expect(ids({ query: 'てろっぷ' })).toContain('look.variety-double-outline');
	});

	it('ranks a name above a tag above a description, and needs every word', () => {
		expect(ids({ query: 'neon tube' })[0]).toBe('look.neon-tube');
		expect(ids({ query: 'neon gold zzz' })).toEqual([]);
	});

	it('filters by category and tag, and lists everything in library order for an empty query', () => {
		expect(ids({})).toEqual(FACTORY_LOOKS.map((l) => l.libraryId));
		expect(searchLooks(FACTORY_LOOKS, { category: 'comic' }).every((l) => l.category === 'comic')).toBe(true);
		expect(ids({ tags: ['ネオン'] })).toContain('look.neon-tube');
		expect(ids({ tags: ['no-such-tag'] })).toEqual([]);
	});

	it('finds templates the same way', () => {
		expect(searchTemplates('rótulo').map((t) => t.id)).toContain('template.lower-third-clean');
		expect(searchTemplates('ROTULO').map((t) => t.id)).toContain('template.lower-third-clean');
		expect(searchTemplates('てろっぷ').map((t) => t.id)).toContain('template.variety-telop');
	});

	it('never throws and stays deterministic on any text', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), (q) => {
				expect(ids({ query: q })).toEqual(ids({ query: q }));
				foldSearchText(q);
			}),
			{ numRuns: 200 },
		);
	});
});

describe('look fonts (TL-053)', () => {
	const face = {
		family: 'Anton',
		weight: 400,
		trackingEm: 0.03,
		fallback: 'Oswald',
		ja: { family: 'Dela Gothic One', weight: 400 },
	};

	it('recognises Japanese', () => {
		expect(hasJapanese('大当たり')).toBe(true);
		expect(hasJapanese('カタカナ')).toBe(true);
		expect(hasJapanese('ｶﾀｶﾅ')).toBe(true);
		expect(hasJapanese('GAME DAY é')).toBe(false);
	});

	it('takes the named face for Latin text and the Japanese face for Japanese, with no Latin tracking', () => {
		expect(chooseLookFont(face, 'GAME DAY')).toEqual({ family: 'Anton', weight: 400, trackingEm: 0.03 });
		expect(chooseLookFont(face, '勝利')).toEqual({ family: 'Dela Gothic One', weight: 400 });
	});

	it('falls back only when the caller knows the family is missing and the fallback is there', () => {
		expect(chooseLookFont(face, 'A', ['oswald']).family).toBe('Oswald');
		expect(chooseLookFont(face, 'A', ['Anton', 'Oswald']).family).toBe('Anton');
		expect(chooseLookFont(face, 'A', ['Inter']).family).toBe('Anton');
		expect(chooseLookFont(face, 'A').family).toBe('Anton');
	});

	it('look.apply sets the family, weight and tracking, and one undo restores the text style', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'GAME DAY' }, ref: '$t' },
		]);
		const id = r.refs.$t!;
		const styleOf = () => (h.seq.clips[id] as Extract<Clip, { kind: 'text' }>).content.style;
		const before = styleOf();
		const doc = h.doc;
		h.ok([{ type: 'look.apply', clipIds: [id], lookId: 'look.varsity-block' }]);
		const after = styleOf();
		expect(h.doc.fonts[after.fontId]!.family).toBe('Anton');
		expect(after.weight).toBe(400);
		expect(after.trackingEm).toBeCloseTo(0.03);
		h.doc = doc;
		expect(styleOf()).toEqual(before);
	});

	it('look.apply gives Japanese text the look’s Japanese face', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: '勝利' }, ref: '$t' },
		]);
		h.ok([{ type: 'look.apply', clipIds: [r.refs.$t!], lookId: 'look.varsity-block' }]);
		const s = (h.seq.clips[r.refs.$t!] as Extract<Clip, { kind: 'text' }>).content.style;
		expect(h.doc.fonts[s.fontId]!.family).toBe('Dela Gothic One');
	});

	it('look.apply uses the fallback when the caller says the family is missing', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'GAME' }, ref: '$t' },
		]);
		h.ok([
			{ type: 'look.apply', clipIds: [r.refs.$t!], lookId: 'look.varsity-block', availableFonts: ['Oswald'] },
		]);
		const s = (h.seq.clips[r.refs.$t!] as Extract<Clip, { kind: 'text' }>).content.style;
		expect(h.doc.fonts[s.fontId]!.family).toBe('Oswald');
	});
});

describe('fixed colours (TL-051)', () => {
	function withLook() {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Title' }, ref: '$t' },
		]);
		const id = r.refs.$t!;
		h.ok([{ type: 'look.apply', clipIds: [id], lookId: 'look.comic-burst' }]);
		const fxOf = () => clipLook((h.seq.clips[id] as unknown as { effects: EffectInstance[] }).effects)!;
		return { h, id, fxOf, a: () => fxOf().appearance as Appearance };
	}

	it('turns the roles a layer reads into their colours, so a colourway no longer changes it', () => {
		const { h, id, fxOf, a } = withLook();
		const face = a().layers.at(-1)!;
		const rim = a().layers.find((l) => l.type === 'rim')!;
		const color = a().palette.accent1!.value;
		const r = h.ok([
			{ type: 'appearance.setLayerFixedColor', effectInstanceId: fxOf().id, layerId: rim.id, fixed: true },
		]);
		expect(r.results?.[0] ?? r).toBeTruthy();
		const stored = a().layers.find((l) => l.id === rim.id)!;
		expect(stored.fixedColor).toBe(true);
		expect(stored.params.paint!.value).toEqual({ kind: 'color', color });
		const way = factoryColorway('colorway.cobalt')!;
		h.ok([{ type: 'look.setColorway', clipIds: [id], colorwayId: way.id }]);
		expect(a().layers.find((l) => l.id === rim.id)!.params.paint!.value).toEqual({ kind: 'color', color });
		expect(a().palette.face!.value).toEqual(way.palette.face);
		expect(paintRoles(a().layers.find((l) => l.id === face.id)!.params.paint!.value).length).toBeGreaterThan(
			0,
		);
	});

	it('undoes in one step, and unmarking keeps the colours', () => {
		const { h, fxOf, a } = withLook();
		const rim = a().layers.find((l) => l.type === 'rim')!;
		const doc = h.doc;
		h.ok([
			{ type: 'appearance.setLayerFixedColor', effectInstanceId: fxOf().id, layerId: rim.id, fixed: true },
		]);
		h.ok([
			{ type: 'appearance.setLayerFixedColor', effectInstanceId: fxOf().id, layerId: rim.id, fixed: false },
		]);
		const now = a().layers.find((l) => l.id === rim.id)!;
		expect(now.fixedColor).toBeUndefined();
		expect((now.params.paint!.value as Paint).kind).toBe('color');
		h.doc = doc;
		expect(a().layers.find((l) => l.id === rim.id)!.fixedColor).toBeUndefined();
		expect((a().layers.find((l) => l.id === rim.id)!.params.paint!.value as Paint).kind).toBe('role');
	});

	it('refuses an unknown layer', () => {
		const { h, fxOf } = withLook();
		expect(
			code(
				h.tx([
					{
						type: 'appearance.setLayerFixedColor',
						effectInstanceId: fxOf().id,
						layerId: 'apl_0000000000000000',
						fixed: true,
					},
				]),
			),
		).toBe('E_NOT_FOUND');
	});

	it('keeps the mark through a look update as an override of the clip', () => {
		const { h, id, fxOf, a } = withLook();
		const rim = a().layers.find((l) => l.type === 'rim')!;
		h.ok([
			{ type: 'appearance.setLayerFixedColor', effectInstanceId: fxOf().id, layerId: rim.id, fixed: true },
		]);
		expect((a().lookOverrides as Record<string, string[]>)[rim.id]).toContain('$fixedColor');
		const lookId = a().lookId!;
		h.ok([
			{
				type: 'look.update',
				lookId,
				recipe: FACTORY_LOOKS.find((l) => l.libraryId === 'look.comic-burst')!.recipe,
			},
		]);
		expect(a().layers.find((l) => l.id === rim.id)!.fixedColor).toBe(true);
		expect(id).toBeTruthy();
	});
});

describe('repair of the new fields', () => {
	const stored = () => appearanceOf(FACTORY_LOOKS[0]!.recipe) as unknown as Record<string, unknown>;
	const repair = (raw: unknown) => {
		const notes: string[] = [];
		let n = 100;
		const fixed = repairAppearance(
			raw,
			() => `apl_${String(++n).padStart(16, '0')}`,
			'fx',
			(_a, _e, d) => notes.push(d),
		);
		return { fixed, notes };
	};

	it('removes an unreadable fixed mark and says so, keeping the layer', () => {
		const a = stored();
		(a.layers as Record<string, unknown>[])[0]!.fixedColor = 'yes';
		expect(appearanceProblem(a)).not.toBeNull();
		const { fixed, notes } = repair(a);
		expect(fixed?.layers[0]?.fixedColor).toBeUndefined();
		expect(fixed?.layers).toHaveLength((a.layers as unknown[]).length);
		expect(notes.join()).toContain('fixed colour');
	});

	it('keeps a valid fixed mark', () => {
		const a = stored();
		(a.layers as Record<string, unknown>[])[0]!.fixedColor = true;
		const { fixed } = repair({ ...a, seed: -1 });
		expect(fixed?.layers[0]?.fixedColor).toBe(true);
	});

	it('removes unreadable font settings and keeps the family', () => {
		const a = { ...stored(), font: { family: 'Anton', weight: 'heavy' } };
		const { fixed, notes } = repair(a);
		expect(fixed?.font).toEqual({ family: 'Anton' });
		expect(notes.join()).toContain('font settings');
	});

	it('never loses the look over an unreadable family', () => {
		const a = { ...stored(), font: { family: 'x'.repeat(300) } };
		const { fixed } = repair(a);
		expect(fixed).not.toBeNull();
		expect(fixed?.font).toBeUndefined();
	});
});

describe('banned names (TL-001, §14)', () => {
	const list = readFileSync(join(here, 'fixtures', 'banned-title-names.txt'), 'utf8')
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith('#'))
		.map(foldSearchText);

	/** Whole words for Latin names, so "sonic" does not match "supersonic" and "garo" not "garoupa"; substrings otherwise. */
	const finder = (name: string) =>
		/^[\p{Script=Latin}0-9 -]+$/u.test(name)
			? new RegExp(
					`(?<![\\p{L}\\p{N}])${name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
					'u',
				)
			: new RegExp(name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&'), 'u');

	const banned = (text: string): string[] => {
		const t = foldSearchText(text);
		return list.filter((n) => finder(n).test(t));
	};

	const walk = (d: string): string[] =>
		readdirSync(d).flatMap((f) => {
			const p = join(d, f);
			return statSync(p).isDirectory() ? walk(p) : [p];
		});

	it('has a real list, and the check finds what it should', () => {
		expect(list.length).toBeGreaterThan(80);
		expect(banned('Hokuto Slanted Box')).toEqual(expect.arrayContaining(['hokuto']));
		expect(banned('北斗の拳 box')).not.toEqual([]);
		expect(banned('ＨＯＫＵＴＯ')).not.toEqual([]);
		expect(banned('ｴｳﾞｧ gold').length + banned('エヴァ gold').length).toBeGreaterThan(0);
		expect(banned('a TikTok look')).toEqual(['tiktok']);
		expect(banned('supersonic gold')).toEqual([]);
	});

	it('finds none in any look, colourway, category or template text', () => {
		const texts = [
			...FACTORY_LOOKS.flatMap((l) => [
				l.libraryId,
				l.name,
				l.nameEs,
				l.description,
				l.sampleText,
				...l.tags,
			]),
			...FACTORY_COLORWAYS.flatMap((c) => [c.id, c.name, c.nameEs, ...c.tags]),
			...LOOK_CATEGORIES.flatMap((c) => [c.id, c.label, c.labelEs, ...c.tags]),
			...FACTORY_TEMPLATES.flatMap((t) => [
				t.id,
				t.name,
				t.nameEs,
				t.description,
				...t.tags,
				...t.clips.flatMap((c) => (c.kind === 'text' ? [c.text, c.label, c.labelEs] : [c.name])),
			]),
		];
		for (const t of texts) expect(banned(t), t).toEqual([]);
	});

	it('finds none in the source files of the library, comments included', () => {
		const files = walk(FACTORY_DIR);
		expect(files.length).toBeGreaterThan(15);
		for (const f of files) expect(banned(readFileSync(f, 'utf8')), f).toEqual([]);
	});
});
