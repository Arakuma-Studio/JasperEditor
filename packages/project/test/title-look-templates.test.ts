// Spec 19 TL-052: title templates expand into ordinary clips in one transaction.
import { describe, expect, it } from 'vitest';
import {
	type Appearance,
	type Clip,
	checkInvariants,
	clipLook,
	costClassOf,
	defaultEffectRegistry,
	type EffectInstance,
	FACTORY_LOOKS,
	FACTORY_TEMPLATES,
	factoryColorway,
	factoryLook,
	factoryTemplate,
	type Layer3D,
	LOOK_CATEGORIES,
	latestTextAnimationSpec,
	SURFACE_PRESETS,
	TEMPLATE_KINDS,
	type TemplateText,
	templateCostClass,
	userScene3d,
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
				// A face of its own only under a solid: a 2D title takes a look of the library.
				if (typeof c.look === 'string') expect(factoryLook(c.look), `${t.id}: ${c.look}`).toBeTruthy();
				else expect(c.solid, `${t.id}: ${c.slot}`).toBeTruthy();
				expect(latestTextAnimationSpec(c.in.preset), `${t.id}: ${c.in.preset}`).toBeTruthy();
				expect(latestTextAnimationSpec(c.out.preset), `${t.id}: ${c.out.preset}`).toBeTruthy();
				expect(c.labelEs).toBeTruthy();
			}
		}
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
				// A 3D template adds its environment light.
				expect(out.clipIds.length, t.id).toBe(t.clips.length + (t.scene3d ? 1 : 0));
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
					const f = typeof c.look === 'string' ? factoryLook(c.look)!.recipe.font! : c.look.font;
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

	it('uses only looks of the library, or a bare face under a solid', () => {
		const ids = new Set(FACTORY_LOOKS.map((l) => l.libraryId));
		for (const t of FACTORY_TEMPLATES)
			for (const c of t.clips)
				if (c.kind === 'text')
					if (typeof c.look === 'string') expect(ids.has(c.look), `${t.id}: ${c.look}`).toBe(true);
					else expect(Object.keys(c.look), `${t.id}: ${c.slot}`).toEqual(['font']);
		expect(factoryTemplate('template.neon-sign')?.clips).toHaveLength(1);
	});
});

const solidTexts = (id: string) =>
	factoryTemplate(id)!.clips.filter((c): c is TemplateText => c.kind === 'text' && !!c.solid);
const THREE_D = FACTORY_TEMPLATES.filter((t) => t.category === '3d');
const td = (c: Clip) => (c as unknown as { threeD?: Layer3D }).threeD;

describe('3D title templates (spec 19 §9 through TL-052)', () => {
	it('fill the 3D category with real solids; the drawn-depth title is not among them', () => {
		expect(THREE_D.length).toBeGreaterThanOrEqual(4);
		for (const t of THREE_D) {
			expect(solidTexts(t.id).length, t.id).toBeGreaterThan(0);
			expect(t.scene3d, t.id).toBeTruthy();
		}
		// Every 3D template is a solid, and every template with a solid is in 3D.
		for (const t of FACTORY_TEMPLATES)
			expect(t.category === '3d', t.id).toBe(t.clips.some((c) => c.kind === 'text' && !!c.solid));
		expect(factoryTemplate('template.block-title')?.category).toBe('drawn-depth');
		// The model's parts, across the four: bands, plates, inflate, per-surface materials, glints, several environments.
		const solids = THREE_D.flatMap((t) => solidTexts(t.id).map((c) => c.solid!));
		expect(solids.some((s) => (s.bands ?? []).length > 1)).toBe(true);
		expect(solids.some((s) => (s.plates ?? []).length > 0)).toBe(true);
		expect(solids.some((s) => !!s.inflate)).toBe(true);
		expect(solids.some((s) => !!s.surfaces)).toBe(true);
		expect(THREE_D.some((t) => !!t.scene3d?.glint)).toBe(true);
		expect(new Set(THREE_D.map((t) => t.scene3d!.environment)).size).toBeGreaterThanOrEqual(3);
		for (const s of solids)
			for (const m of [
				s.material,
				...Object.values(s.surfaces ?? {}),
				...(s.bands ?? []).map((b) => b.material),
				...(s.plates ?? []).map((p) => p.material),
			])
				if (m !== undefined) expect(SURFACE_PRESETS[m], m).toBeTruthy();
	});

	for (const t of THREE_D)
		it(`${t.id} makes Advanced 3D layers with its solid, materials and scene`, () => {
			const h = new Harness();
			const r = h.ok([{ type: 'title.insertTemplate', templateId: t.id, at: 0 }]);
			const out = r.results[0] as { clipIds: string[]; slots: Record<string, string> };
			ok(h);
			const seq = h.seq;
			expect(seq.threeD?.renderer).toBe('advanced');
			expect(seq.threeD?.toneMapping).toBe(t.scene3d!.toneMapping);
			expect(!!seq.threeD?.glint?.enabled).toBe(!!t.scene3d!.glint);
			// The environment light is one of the template's clips, over its span, in its group.
			const light = out.clipIds.map((id) => seq.clips[id]!).find((c) => c.kind === 'light')!;
			expect(light, t.id).toBeTruthy();
			expect((light as unknown as { light: { environmentPreset?: string } }).light.environmentPreset).toBe(
				t.scene3d!.environment,
			);
			expect(out.clipIds).toHaveLength(t.clips.length + 1);
			for (const c of t.clips) {
				if (c.kind !== 'text') continue;
				const clip = seq.clips[out.slots[c.slot]!]!;
				expect(light.groupId).toBe(clip.groupId);
				const three = td(clip);
				if (!c.solid) {
					expect(three?.enabled ?? false, `${t.id}: ${c.slot} stays flat`).toBe(false);
					continue;
				}
				expect(three?.enabled, `${t.id}: ${c.slot}`).toBe(true);
				const g = three!.geometry!;
				expect(g.bands ?? []).toHaveLength(c.solid.bands?.length ?? 0);
				expect(g.backplates ?? []).toHaveLength(c.solid.plates?.length ?? 0);
				expect(g.mode ?? 'extrude').toBe(c.solid.inflate ? 'inflate' : 'extrude');
				// The base material is the preset's: a gold solid has gold's base colour.
				const base = three!.material.pbr as unknown as { baseColor: { value: number[] } };
				const want = SURFACE_PRESETS[c.solid.material]!.values.baseColor;
				if (want) expect(base.baseColor.value).toEqual(want);
				// The cost the Looks tab states is the one the made clip has (TL-078).
				expect(templateCostClass(t), t.id).toBe(costClassOf(three, seq.threeD));
			}
		});

	it('says what each template costs: flat ones are fast, 3D ones never bake', () => {
		for (const t of FACTORY_TEMPLATES)
			if (t.category === '3d') expect(templateCostClass(t), t.id).toMatch(/^3d/);
			else expect(templateCostClass(t), t.id).toBe('fast');
		expect(templateCostClass(factoryTemplate('template.gold-3d-title')!)).toBe('3d');
		expect(templateCostClass(factoryTemplate('template.puffy-3d-hook')!)).toBe('3d-heavy');
		expect(templateCostClass(factoryTemplate('template.gold-glint-end-card')!)).toBe('3d-heavy');
	});

	it('sizes the solid with the text, so it is the same solid at any frame size', () => {
		const depthAt = (preset: string) => {
			const h = new Harness({ preset });
			const r = h.ok([{ type: 'title.insertTemplate', templateId: 'template.gold-3d-title', at: 0 }]);
			const { slots } = r.results[0] as { slots: Record<string, string> };
			const clip = h.seq.clips[slots.title!] as Extract<Clip, { kind: 'text' }>;
			const g = td(clip)!.geometry!;
			return {
				ratio: (g.extrusionDepth as { value: number }).value / clip.content.style.sizePx,
				band: (g.bands![0]!.width as { value: number }).value / clip.content.style.sizePx,
			};
		};
		const hd = depthAt('hd-1080p-30');
		const small = depthAt('hd-720p-30');
		expect(hd.ratio).toBeCloseTo(0.22, 2);
		expect(small.ratio).toBeCloseTo(hd.ratio, 2);
		expect(small.band).toBeCloseTo(hd.band, 2);
	});

	describe('never overwrites the sequence look of 3D the user set', () => {
		const END_CARD = 'template.gold-glint-end-card';
		const warned = (r: { warnings: { code: string; message: string }[] }, c: string) =>
			r.warnings.filter((w) => w.code === c);
		const outcome = (r: { results: unknown[] }) =>
			(r.results[0] as { scene3d?: Record<string, unknown> }).scene3d;

		it('a Classic sequence at its defaults takes the template look, in one undo step, and says so', () => {
			const h = new Harness();
			const before = h.doc;
			expect(userScene3d(h.seq.threeD)).toEqual([]);
			const r = h.ok([{ type: 'title.insertTemplate', templateId: END_CARD, at: 0 }]);
			expect(outcome(r)).toEqual({
				switchedRenderer: true,
				set: ['tone mapping', 'exposure', 'glints'],
				kept: [],
			});
			expect(warned(r, 'W_SCENE3D_SET')).toHaveLength(1);
			expect(warned(r, 'W_SCENE3D_SET')[0]!.message).toMatch(
				/Advanced 3D and set its tone mapping, exposure, glints/,
			);
			expect(warned(r, 'W_SCENE3D_KEPT')).toEqual([]);
			const three = h.seq.threeD!;
			expect(three.toneMapping).toBe('aces');
			expect(three.exposure).toMatchObject({ value: 0.25, keyframes: [] });
			expect(three.glint?.enabled).toBe(true);
			ok(h);
			h.doc = before;
			expect(h.seq.threeD).toBeUndefined();
		});

		it('an Advanced 3D sequence keeps its tone mapping, exposure and glints', () => {
			const h = new Harness();
			h.ok([{ type: 'sequence.set3dRenderer', renderer: 'advanced' }]);
			const three = h.seq.threeD;
			const r = h.ok([{ type: 'title.insertTemplate', templateId: END_CARD, at: 0 }]);
			expect(outcome(r)).toEqual({
				switchedRenderer: false,
				set: [],
				kept: ['tone mapping', 'exposure', 'glints'],
			});
			expect(h.seq.threeD).toEqual(three);
			expect(warned(r, 'W_SCENE3D_KEPT')[0]!.message).toMatch(
				/kept the tone mapping, exposure, glints of the sequence:/,
			);
			expect(warned(r, 'W_SCENE3D_SET')).toEqual([]);
			ok(h);
		});

		it('a Classic sequence with its own tone mapping is switched to Advanced 3D and keeps it', () => {
			const h = new Harness();
			h.ok([{ type: 'sequence.set3dRenderer', renderer: 'classic', toneMapping: 'agx' }]);
			expect(userScene3d(h.seq.threeD)).toEqual(['tone mapping']);
			const r = h.ok([{ type: 'title.insertTemplate', templateId: END_CARD, at: 0 }]);
			expect(outcome(r)).toEqual({ switchedRenderer: true, set: [], kept: ['tone mapping'] });
			expect(h.seq.threeD).toMatchObject({ renderer: 'advanced', toneMapping: 'agx' });
			expect(h.seq.threeD?.exposure).toBeUndefined();
			expect(h.seq.threeD?.glint).toBeUndefined();
			expect(warned(r, 'W_SCENE3D_KEPT')[0]!.message).toMatch(
				/kept the tone mapping of the sequence and switched it to Advanced 3D/,
			);
			ok(h);
		});

		it('an animated exposure or glint keeps every key (no key at frame 0 is overwritten)', () => {
			const h = new Harness();
			const exposure = ['scene3d', h.seqId, 'exposure'];
			const glint = ['scene3d', h.seqId, 'glintThreshold'];
			h.ok([
				{ type: 'keyframe.add', target: exposure, at: { sequenceFrame: 0 }, value: -1 },
				{ type: 'keyframe.add', target: exposure, at: { sequenceFrame: 30 }, value: 1 },
				{ type: 'keyframe.add', target: glint, at: { sequenceFrame: 0 }, value: 2 },
				{ type: 'keyframe.add', target: glint, at: { sequenceFrame: 30 }, value: 4 },
				{ type: 'sequence.set3dRenderer', renderer: 'classic' },
			]);
			expect(userScene3d(h.seq.threeD)).toEqual(['exposure', 'glints']);
			const three = h.seq.threeD!;
			const r = h.ok([{ type: 'title.insertTemplate', templateId: END_CARD, at: 0 }]);
			expect(outcome(r)).toMatchObject({ switchedRenderer: true, set: [], kept: ['exposure', 'glints'] });
			expect(h.seq.threeD!.exposure).toEqual(three.exposure);
			expect(h.seq.threeD!.glint).toEqual(three.glint);
			expect(h.seq.threeD!.toneMapping).toBeUndefined();
			ok(h);
		});

		it('a static non-default exposure or a tweaked disabled glint counts as set by the user', () => {
			const h = new Harness();
			h.ok([{ type: 'param.set', target: ['scene3d', h.seqId, 'exposure'], value: 0.5 }]);
			expect(userScene3d(h.seq.threeD)).toEqual(['exposure']);
			const g = new Harness();
			g.ok([
				{ type: 'sequence.set3dRenderer', renderer: 'classic', glint: { enabled: false, threshold: 3 } },
			]);
			expect(userScene3d(g.seq.threeD)).toEqual(['glints']);
			const z = new Harness();
			z.ok([{ type: 'param.set', target: ['scene3d', z.seqId, 'exposure'], value: 0 }]);
			z.ok([{ type: 'sequence.set3dRenderer', renderer: 'classic', toneMapping: 'none' }]);
			expect(userScene3d(z.seq.threeD)).toEqual([]);
		});
	});

	it('shares one face per font across 3D templates (TL-015)', () => {
		const h = new Harness();
		h.ok([{ type: 'title.insertTemplate', templateId: 'template.gold-3d-title', at: 0 }]);
		h.ok([{ type: 'title.insertTemplate', templateId: 'template.gold-glint-end-card', at: 200 }]);
		const faces = Object.values(
			(h.doc as { titleLooks?: Record<string, { name: string }> }).titleLooks ?? {},
		).filter((l) => l.name.startsWith('3D Title Face'));
		expect(faces.map((l) => l.name)).toEqual(['3D Title Face (Archivo Black)']);
		ok(h);
	});
});
