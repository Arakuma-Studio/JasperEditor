// Spec 19 TL-052: title templates expand into ordinary clips in one transaction.
import { describe, expect, it } from 'vitest';
import {
	type Appearance,
	type Clip,
	checkInvariants,
	clipLook,
	defaultEffectRegistry,
	type EffectInstance,
	FACTORY_LOOKS,
	FACTORY_TEMPLATES,
	factoryColorway,
	factoryLook,
	factoryTemplate,
	LOOK_CATEGORIES,
	latestTextAnimationSpec,
	TEMPLATE_KINDS,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const code = (r: ReturnType<Harness['tx']>) => (r.ok ? 'ok' : r.errors[0]?.code);

const fxOf = (c: Clip) => clipLook((c as unknown as { effects: EffectInstance[] }).effects);
const ok = (h: Harness) => expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
const texts = (h: Harness) =>
	Object.values(h.seq.clips).filter((c): c is Extract<Clip, { kind: 'text' }> => c.kind === 'text');

describe('title templates (TL-052)', () => {
	it('are data with valid references and complete metadata', () => {
		expect(new Set(FACTORY_TEMPLATES.map((t) => t.id)).size).toBe(FACTORY_TEMPLATES.length);
		expect(JSON.parse(JSON.stringify(FACTORY_TEMPLATES))).toEqual(FACTORY_TEMPLATES);
		for (const t of FACTORY_TEMPLATES) {
			expect(t.id).toMatch(/^template\.[a-z0-9-]+$/);
			expect(
				LOOK_CATEGORIES.some((c) => c.id === t.category),
				t.id,
			).toBe(true);
			expect(TEMPLATE_KINDS, t.id).toContain(t.kind);
			expect(t.nameEs, t.id).toBeTruthy();
			expect(t.clips.length, t.id).toBeGreaterThan(0);
			const slots = t.clips.flatMap((c) => (c.kind === 'text' ? [c.slot] : []));
			expect(new Set(slots).size, t.id).toBe(slots.length);
			for (const c of t.clips) {
				if (c.kind !== 'text') continue;
				expect(factoryLook(c.look), `${t.id}: ${c.look}`).toBeTruthy();
				expect(latestTextAnimationSpec(c.in.preset), `${t.id}: ${c.in.preset}`).toBeTruthy();
				expect(latestTextAnimationSpec(c.out.preset), `${t.id}: ${c.out.preset}`).toBeTruthy();
				expect(c.labelEs).toBeTruthy();
			}
		}
	});

	it('cover lower thirds, full-screen titles, end cards and social hooks across general categories', () => {
		for (const k of TEMPLATE_KINDS)
			expect(FACTORY_TEMPLATES.filter((t) => t.kind === k).length, k).toBeGreaterThan(0);
		expect(new Set(FACTORY_TEMPLATES.map((t) => t.category)).size).toBeGreaterThanOrEqual(6);
		expect(FACTORY_TEMPLATES.filter((t) => t.category === 'pachinko-arcade').length).toBeLessThanOrEqual(2);
	});

	for (const [preset, label] of [
		['hd-1080p-30', '16:9'],
		['vertical-1080x1920-30', '9:16'],
	] as const)
		it(`every template expands validly at ${label}`, () => {
			for (const t of FACTORY_TEMPLATES) {
				const h = new Harness({ preset });
				const r = h.ok([{ type: 'title.insertTemplate', templateId: t.id, at: 0 }]);
				const out = r.results[0] as { clipIds: string[]; slots: Record<string, string> };
				expect(out.clipIds.length, t.id).toBe(t.clips.length);
				ok(h);
				for (const c of t.clips) {
					if (c.kind !== 'text') continue;
					const clip = h.seq.clips[out.slots[c.slot]!] as Extract<Clip, { kind: 'text' }>;
					expect(clip.kind, t.id).toBe('text');
					expect(clip.content.text).toBe(c.text);
					expect(fxOf(clip), t.id).toBeTruthy();
					expect(clip.textAnimation?.in?.preset).toBe(c.in.preset);
					expect(clip.textAnimation?.out?.preset).toBe(c.out.preset);
					const family = h.doc.fonts[clip.content.style.fontId]!.family;
					const f = factoryLook(c.look)!.recipe.font!;
					expect([f.family, f.ja?.family], t.id).toContain(family);
				}
			}
		});

	it('makes ordinary clips: a shape, two texts, all grouped, stacked on rising tracks', () => {
		const h = new Harness();
		const r = h.ok([{ type: 'title.insertTemplate', templateId: 'template.lower-third-clean', at: 30 }]);
		const { clipIds } = r.results[0] as { clipIds: string[] };
		const clips = clipIds.map((id) => h.seq.clips[id]!);
		expect(clips.map((c) => c.kind)).toEqual(['shape', 'text', 'text']);
		const group = clips[0]!.groupId;
		expect(group).toBeTruthy();
		for (const c of clips) expect(c.groupId).toBe(group);
		const index = (c: Clip) => h.seq.videoTracks.findIndex((t) => t.id === c.trackId);
		expect(index(clips[0]!)).toBeLessThan(index(clips[1]!));
		expect(index(clips[1]!)).toBeLessThan(index(clips[2]!));
		expect(clips[0]!.start).toBe(30);
		expect(clips[1]!.start).toBeGreaterThan(30);
	});

	it('is one undo step: the document before it comes back whole', () => {
		const h = new Harness();
		const before = h.doc;
		const clipsBefore = Object.keys(h.seq.clips).length;
		h.ok([{ type: 'title.insertTemplate', templateId: 'template.lower-third-corporate', at: 0 }]);
		expect(Object.keys(h.seq.clips).length).toBe(clipsBefore + 4);
		expect(h.doc).not.toBe(before);
		h.doc = before;
		expect(Object.keys(h.seq.clips).length).toBe(clipsBefore);
		expect((h.doc as { titleLooks?: unknown }).titleLooks).toBeUndefined();
		ok(h);
	});

	it('applies nothing when anything in it is refused', () => {
		const h = new Harness();
		const before = h.doc;
		expect(
			code(
				h.tx([
					{
						type: 'title.insertTemplate',
						templateId: 'template.lower-third-clean',
						at: 0,
						colorwayId: 'colorway.none',
					},
				]),
			),
		).toBe('E_NOT_FOUND');
		expect(h.doc).toBe(before);
	});

	it('takes the caller’s text, colourway and seed, and scales the clips to a given length', () => {
		const h = new Harness();
		const way = factoryColorway('colorway.ocean')!;
		const r = h.ok([
			{
				type: 'title.insertTemplate',
				templateId: 'template.cinematic-title',
				at: 0,
				duration: 150,
				texts: { title: 'MY FILM' },
				colorwayId: way.id,
				seed: 42,
			},
		]);
		const { slots } = r.results[0] as { slots: Record<string, string> };
		const title = h.seq.clips[slots.title!] as Extract<Clip, { kind: 'text' }>;
		expect(title.content.text).toBe('MY FILM');
		expect(title.duration).toBe(150);
		const a = fxOf(title)!.appearance as Appearance;
		expect(a.colorwayId).toBe(way.id);
		expect(a.palette.face!.value).toEqual(way.palette.face);
		expect(a.seed).toBe(42);
		expect(h.seq.clips[slots.kicker!]!.start).toBeGreaterThan(0);
	});

	it('recolours its shapes with the colourway: they carry a look', () => {
		const h = new Harness();
		const way = factoryColorway('colorway.crimson')!;
		const r = h.ok([
			{
				type: 'title.insertTemplate',
				templateId: 'template.lower-third-broadcast',
				at: 0,
				colorwayId: way.id,
			},
		]);
		const { clipIds } = r.results[0] as { clipIds: string[] };
		const strap = h.seq.clips[clipIds[0]!]!;
		expect(strap.kind).toBe('shape');
		const a = fxOf(strap)!.appearance as Appearance;
		expect(a.palette.accent2!.value).toEqual(way.palette.accent2);
	});

	it('gives templates of different palettes their own shape colours in one project', () => {
		const h = new Harness();
		const accent = (r: { results: unknown[] }) => {
			const { clipIds } = r.results[0] as { clipIds: string[] };
			return (fxOf(h.seq.clips[clipIds[0]!]!)!.appearance as Appearance).palette.accent2!.value;
		};
		const clean = accent(
			h.ok([{ type: 'title.insertTemplate', templateId: 'template.lower-third-clean', at: 0 }]),
		);
		const strap = accent(
			h.ok([{ type: 'title.insertTemplate', templateId: 'template.lower-third-broadcast', at: 0 }]),
		);
		expect(clean).toEqual(factoryColorway('colorway.pure-white')!.palette.accent2);
		expect(strap).toEqual(factoryColorway('colorway.corporate-navy')!.palette.accent2);
	});

	it('animates a shape with ordinary keyframes that start and end at nothing', () => {
		const h = new Harness();
		const r = h.ok([{ type: 'title.insertTemplate', templateId: 'template.lower-third-broadcast', at: 0 }]);
		const { clipIds } = r.results[0] as { clipIds: string[] };
		const strap = h.seq.clips[clipIds[0]!] as Extract<Clip, { kind: 'shape' }>;
		const keys = strap.transform.scaleWidth.keyframes;
		expect(keys).toHaveLength(4);
		expect(keys.map((k) => k.value)).toEqual([0, 100, 100, 0]);
		expect(strap.transform.anchor.value[0]).toBe(0);
	});

	it('keeps a plate’s opacity through its fade', () => {
		const h = new Harness();
		const r = h.ok([{ type: 'title.insertTemplate', templateId: 'template.lower-third-corporate', at: 0 }]);
		const { clipIds } = r.results[0] as { clipIds: string[] };
		const plate = h.seq.clips[clipIds[0]!] as Extract<Clip, { kind: 'shape' }>;
		expect(plate.opacity.value).toBe(88);
		const edge = h.seq.clips[clipIds[1]!] as Extract<Clip, { kind: 'shape' }>;
		expect(edge.opacity.keyframes.map((k) => k.value)).toEqual([0, 100, 100, 0]);
	});

	it('places a generator under the title as a clip, with its colours from the colourway', () => {
		const h = new Harness();
		const way = factoryColorway('colorway.emerald')!;
		const r = h.ok([
			{ type: 'title.insertTemplate', templateId: 'template.end-card-gradient', at: 0, colorwayId: way.id },
		]);
		const { clipIds } = r.results[0] as { clipIds: string[] };
		const bg = h.seq.clips[clipIds[0]!]! as Clip & { effects: EffectInstance[] };
		expect(bg.kind).toBe('solid');
		const fx = bg.effects[0]!;
		expect(fx.effectId).toBe('jasper.4-color-gradient');
		expect((fx.params.color2 as { value: unknown }).value).toEqual(way.palette.accent2);
		const track = (id: string) => h.seq.videoTracks.findIndex((t) => t.id === h.seq.clips[id]!.trackId);
		expect(track(clipIds[0]!)).toBeLessThan(track(clipIds[1]!));
		ok(h);
	});

	it('never overwrites: clips already on the tracks stay, and the template goes above them', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 300, track: 'V2', content: { text: 'Keep me' }, ref: '$k' },
		]);
		h.ok([{ type: 'title.insertTemplate', templateId: 'template.comic-burst', at: 0 }]);
		expect(h.seq.clips[r.refs.$k!]!.duration).toBe(300);
		expect(texts(h)).toHaveLength(2);
		const made = texts(h).find((c) => c.id !== r.refs.$k)!;
		expect(made.trackId).not.toBe(h.seq.clips[r.refs.$k!]!.trackId);
		ok(h);
	});

	it('shares one project copy of a look across its clips (TL-015)', () => {
		const h = new Harness();
		h.ok([{ type: 'title.insertTemplate', templateId: 'template.lower-third-clean', at: 0 }]);
		const looks = Object.values((h.doc as { titleLooks: Record<string, { sourceId?: string }> }).titleLooks);
		expect(looks.filter((l) => l.sourceId === 'look.clean-sans')).toHaveLength(1);
	});

	it('refuses an unknown template and an unknown slot', () => {
		const h = new Harness();
		expect(code(h.tx([{ type: 'title.insertTemplate', templateId: 'template.none', at: 0 }]))).toBe(
			'E_NOT_FOUND',
		);
		expect(
			code(
				h.tx([
					{ type: 'title.insertTemplate', templateId: 'template.comic-burst', at: 0, texts: { nope: 'x' } },
				]),
			),
		).toBe('E_INVALID_PARAM');
	});

	it('is deterministic in everything but ids', () => {
		const shape = () => {
			const h = new Harness();
			const r = h.ok([{ type: 'title.insertTemplate', templateId: 'template.sports-title', at: 0, seed: 1 }]);
			const { clipIds } = r.results[0] as { clipIds: string[] };
			return clipIds.map((id) => {
				const c = h.seq.clips[id] as Extract<Clip, { kind: 'text' }>;
				return [c.kind, c.start, c.duration, c.content.text, c.transform.position.value];
			});
		};
		expect(shape()).toEqual(shape());
	});

	it('uses only looks of the library', () => {
		const ids = new Set(FACTORY_LOOKS.map((l) => l.libraryId));
		for (const t of FACTORY_TEMPLATES)
			for (const c of t.clips)
				if (c.kind === 'text') expect(ids.has(c.look), `${t.id}: ${c.look}`).toBe(true);
		expect(factoryTemplate('template.neon-sign')?.clips).toHaveLength(1);
	});
});
