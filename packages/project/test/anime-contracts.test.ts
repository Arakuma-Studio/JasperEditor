// M2 animation contracts (ARCHITECTURE §20.1, S11): schema v4 (text animators, anime renderer, shape clips),
// text-animation windows, clip engines, snapshot sources, command stubs and the agent schema additions.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	buildRenderSnapshot,
	type Clip,
	COMMAND_CATALOG,
	COMMAND_FIELD_OWNERS,
	CURRENT_SCHEMA_VERSION,
	checkInvariants,
	clipEngines,
	compressAnimationWindows,
	createStaticMgRegistry,
	defaultEffectRegistry,
	defaultRegistries,
	defaultShape,
	exportAgentSchema,
	getTextAnimationSpec,
	intrinsicBoxOf,
	KIND_CAPABILITIES,
	KNOWN_CLIP_KINDS,
	loadProject,
	type MgTemplateInfo,
	type ProjectDocument,
	resolveTextAnimationWindows,
	type ShapeData,
	scaleAnimationFrames,
	shapeIntrinsicBox,
	TEXT_ANIMATION_SPECS,
	type TextAnimationSpec,
	WARNING_CODES,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureV4 = () => JSON.parse(readFileSync(join(here, 'fixtures/v4/basic.jasper'), 'utf8'));
const loadV4 = () => loadProject(fixtureV4(), { effects: defaultEffectRegistry }).document;
const clipsOf = (doc: ProjectDocument) => Object.values(Object.values(doc.sequences)[0]!.clips);
const snapshotOf = (doc: ProjectDocument) =>
	buildRenderSnapshot(doc, Object.keys(doc.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => 'https://fonts.test/f.woff2',
	});

const FADE: TextAnimationSpec = {
	id: 'fade',
	version: 1,
	label: 'Fade',
	category: 'Fade',
	phases: ['in', 'out'],
	paramsSchema: z.strictObject({
		ease: z.string().default('out'),
		stagger: z.number().min(0).max(1).default(0),
	}),
	defaults: { ease: 'out', stagger: 0 },
	defaultDurationFrames: 15,
	description: 'Fades the text in or out.',
};

describe('schema v4 (ARCHITECTURE §20.1, D-32)', () => {
	it('is version 4 and the v4 fixture (animated text, anime template, rect + ellipse) loads without repairs', () => {
		expect(CURRENT_SCHEMA_VERSION).toBe(4);
		const r = loadProject(fixtureV4(), { effects: defaultEffectRegistry });
		expect(r.readOnly).toBe(false);
		expect(r.migration.steps).toEqual([]);
		expect(r.repairs).toEqual([]);
		expect(r.issues).toEqual([]);
		const clips = clipsOf(r.document);
		const text = clips.find((c) => c.kind === 'text');
		expect(text?.kind === 'text' && text.textAnimation?.in?.preset).toBe('slide-up');
		expect(text?.kind === 'text' && text.textAnimation?.out?.durationFrames).toBe(15);
		const mg = clips.find((c) => c.kind === 'motion-graphic');
		expect(mg?.kind === 'motion-graphic' && mg.template.renderer).toBe('anime');
		const shapes = clips.filter((c): c is Extract<Clip, { kind: 'shape' }> => c.kind === 'shape');
		expect(shapes.map((s) => s.shape.type).sort()).toEqual(['ellipse', 'rect']);
	});
	it('rejects malformed animators and shapes at load (schema), and flags them after edits (invariants)', () => {
		const bad = fixtureV4();
		const seq = Object.values(bad.document.sequences)[0] as { clips: Record<string, any> };
		const text = Object.values(seq.clips).find((c) => c.kind === 'text');
		text.textAnimation.in.durationFrames = 0;
		expect(() => loadProject(bad)).toThrow(/does not match the schema/);
		const doc = loadV4();
		const s2 = Object.values(doc.sequences)[0]!;
		const t2 = Object.values(s2.clips).find((c) => c.kind === 'text') as any;
		t2.textAnimation.out.durationFrames = 2.5;
		const rect = Object.values(s2.clips).find((c) => c.kind === 'shape') as any;
		rect.shape.size.value = [-1, 10];
		rect.shape.cornerRadius.value = -2;
		const issues = checkInvariants(doc).map((i) => i.message);
		expect(issues.some((m) => /out animation duration/.test(m))).toBe(true);
		expect(issues.some((m) => /size must be two numbers/.test(m))).toBe(true);
		expect(issues.some((m) => /corner radius/.test(m))).toBe(true);
	});
	it('registers the shape kind (capabilities like text, Remotion engines, graphics label)', () => {
		expect(KNOWN_CLIP_KINDS).toContain('shape');
		expect(KIND_CAPABILITIES.shape).toMatchObject({
			trackKind: 'video',
			visual: true,
			hasTransform: true,
			hasOpacity: true,
			supportsEffects: true,
			engines: { preview: 'remotion', export: 'remotion' },
			badge: 'R',
			defaultLabel: 'magenta',
		});
		expect(WARNING_CODES).toContain('W_ANIMATION_COMPRESSED');
	});
});

describe('shapes (S11:SHP-001/003)', () => {
	it('defaultShape: white fill, no stroke, radius 0, 400×400', () => {
		const s = defaultShape('rect');
		expect(s).toEqual({
			type: 'rect',
			size: { value: [400, 400], keyframes: [] },
			fill: { value: [1, 1, 1, 1], keyframes: [] },
			stroke: null,
			cornerRadius: { value: 0, keyframes: [] },
		});
	});
	it('intrinsic box = largest size + the stroke drawn outside the geometry', () => {
		const stroke = (position: 'inside' | 'center' | 'outside') =>
			defaultShape('rect', { size: [100, 50], stroke: { color: [1, 1, 1, 1], width: 10, position } });
		expect(shapeIntrinsicBox(stroke('inside'))).toEqual({ width: 100, height: 50 });
		expect(shapeIntrinsicBox(stroke('center'))).toEqual({ width: 110, height: 60 });
		expect(shapeIntrinsicBox(stroke('outside'))).toEqual({ width: 120, height: 70 });
		const grow: ShapeData = defaultShape('ellipse', { size: [10, 10] });
		grow.size.keyframes = [
			{
				id: 'kf_0000000000000001',
				time: 0,
				value: [300, 20],
				interpolation: 'linear',
				easeIn: { influence: 0.3, slope: 0 },
				easeOut: { influence: 0.3, slope: 0 },
			},
		];
		expect(shapeIntrinsicBox(grow)).toEqual({ width: 300, height: 20 });
		const doc = loadV4();
		const seq = Object.values(doc.sequences)[0]!;
		const rect = clipsOf(doc).find((c) => c.kind === 'shape' && c.shape.type === 'rect')!;
		expect(intrinsicBoxOf({ doc, seq, clip: rect })).toEqual({ width: 616, height: 316 });
	});
});

describe('text animation windows (S11:TXA-002/004)', () => {
	it('lookups use the shipped catalogue (wp-m2-text-anim) or an explicit list', () => {
		expect(getTextAnimationSpec('fade', 1)).toBe(TEXT_ANIMATION_SPECS[0]);
		expect(getTextAnimationSpec('fade', 1, [])).toBeUndefined();
		expect(getTextAnimationSpec('fade', 1, [FADE])).toBe(FADE);
		expect(getTextAnimationSpec('fade', 2, [FADE])).toBeUndefined();
	});
	it('scales reference-rate frames to the sequence rate (round, ≥ 1)', () => {
		expect(scaleAnimationFrames(15, 60)).toBe(30);
		expect(scaleAnimationFrames(15, { num: 24000, den: 1001 })).toBe(12);
		expect(scaleAnimationFrames(1, 1)).toBe(1);
	});
	it('compresses in + out proportionally when they exceed the clip', () => {
		expect(compressAnimationWindows(100, 20, 30)).toEqual({ in: 20, out: 30, compressed: false });
		expect(compressAnimationWindows(40, 30, 30)).toEqual({ in: 20, out: 20, compressed: true });
		expect(compressAnimationWindows(10, 30, 10)).toEqual({ in: 8, out: 2, compressed: true });
		expect(compressAnimationWindows(10, 1, 100)).toEqual({ in: 1, out: 9, compressed: true });
		expect(compressAnimationWindows(10, 0, 30)).toEqual({ in: 0, out: 10, compressed: true });
		expect(compressAnimationWindows(1, 5, 5)).toEqual({ in: 1, out: 1, compressed: true });
		for (let d = 2; d < 60; d++)
			for (const [a, b] of [
				[d, d],
				[1, 3 * d],
				[2 * d, 1],
			] as const) {
				const w = compressAnimationWindows(d, a, b);
				expect(w.in + w.out).toBeLessThanOrEqual(d);
				expect(w.in).toBeGreaterThanOrEqual(1);
				expect(w.out).toBeGreaterThanOrEqual(1);
			}
	});
	it('merges preset defaults for known presets and passes unknown presets through', () => {
		const clip = {
			duration: 20,
			textAnimation: {
				in: { preset: 'fade', version: 1, durationFrames: 15, params: { stagger: 0.5 } },
				out: { preset: 'mystery', version: 3, durationFrames: 15, params: { x: 1 } },
			},
		};
		const w = resolveTextAnimationWindows(clip, [FADE]);
		expect(w.in).toEqual({ preset: 'fade', version: 1, params: { ease: 'out', stagger: 0.5 }, frames: 10 });
		expect(w.out).toEqual({ preset: 'mystery', version: 3, params: { x: 1 }, frames: 10 });
		expect(w.compressed).toBe(true);
		expect(w.unknown).toEqual(['mystery@3']);
		expect(resolveTextAnimationWindows({ duration: 20, textAnimation: { in: null } })).toEqual({
			compressed: false,
			unknown: [],
		});
	});
});

describe('clip engines and the snapshot (ARCHITECTURE §20.1)', () => {
	it('clipEngines: kind defaults; anime templates are Remotion-rendered', () => {
		expect(clipEngines({ kind: 'motion-graphic', template: { renderer: 'anime' } })).toEqual({
			preview: 'remotion',
			export: 'remotion',
			badge: 'R',
		});
		expect(clipEngines({ kind: 'motion-graphic', template: {} })).toEqual({
			preview: 'fframes',
			export: 'fframes',
			badge: 'F',
		});
		expect(clipEngines({ kind: 'shape' })?.badge).toBe('R');
		expect(clipEngines({ kind: 'video' })).toEqual({ preview: 'native', export: 'native', badge: null });
		expect(clipEngines({ kind: 'hologram' })).toBeNull();
	});
	it('carries text animation, the anime renderer and shapes', () => {
		const doc = loadV4();
		const snap = snapshotOf(doc);
		const clips = snap.videoTracks.flatMap((t) => t.clips);
		const text = clips.find((c) => c.kind === 'text')!;
		// Defaults merged since wp-m2-text-anim filled the catalogue.
		expect('text' in text.source && text.source.animation).toEqual({
			in: {
				preset: 'slide-up',
				version: 1,
				params: { unit: 'word', stagger: 0.4, order: 'forward', ease: 'outExpo', distance: 60 },
				frames: 20,
			},
			out: {
				preset: 'fade',
				version: 1,
				params: { unit: 'word', stagger: 0, order: 'forward', ease: 'out' },
				frames: 15,
			},
		});
		expect(snap.warnings.filter((w) => w.code === 'UNKNOWN_TEXT_ANIMATION')).toEqual([]);
		const mg = clips.find((c) => c.kind === 'motion-graphic')!;
		expect('mg' in mg.source && mg.source.mg.renderer).toBe('anime');
		expect('mg' in mg.source && mg.source.mg.template).toEqual({ id: 'title-reveal', version: 1 });
		expect(mg.engine).toBe('remotion');
		const shapes = clips.filter((c) => c.kind === 'shape');
		expect(shapes).toHaveLength(2);
		const rect = shapes.find((c) => 'shape' in c.source && c.source.shape.type === 'rect')!;
		expect(rect.intrinsicBox).toEqual({ width: 616, height: 316 });
		expect(rect.engine).toBe('remotion');
		const ell = shapes.find((c) => 'shape' in c.source && c.source.shape.type === 'ellipse')!;
		// Keyframes stay unevaluated in the snapshot (RND-001).
		expect('shape' in ell.source && ell.source.shape.size.keyframes).toHaveLength(2);
		expect(ell.intrinsicBox).toEqual({ width: 306, height: 306 });
	});
	it('text without animators and fframes templates keep their M1 snapshot shape', () => {
		const h = new Harness();
		const r = h.tx([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hi' } }]);
		expect(r.ok).toBe(true);
		const text = snapshotOf(h.doc).videoTracks.flatMap((t) => t.clips)[0]!;
		expect(Object.keys(text.source).sort()).toEqual(['box', 'text']);
	});
});

describe('command contracts (handlers owned by the wave-1 packages)', () => {
	const fail = (r: ReturnType<Harness['tx']>) => (r.ok ? null : r.errors[0]!);
	it('clip.addShape is registered and owned by wp-m2-shapes (implemented there, test/shapes.test.ts)', () => {
		expect(COMMAND_CATALOG['clip.addShape']).toMatchObject({ owner: 'wp-m2-shapes', milestone: 'M2' });
		const h = new Harness();
		const r = h.tx([{ type: 'clip.addShape', at: 0, track: 'V1', shape: { type: 'ellipse' } }]);
		expect(r.ok).toBe(true);
		const invalid = h.tx([{ type: 'clip.addShape', at: 0, track: 'V1', shape: { type: 'star' } }]);
		expect(fail(invalid)?.code).toBe('E_SCHEMA');
	});
	it('new clip.update / clip.addText fields validate their target, then name their owner', () => {
		expect(COMMAND_FIELD_OWNERS).toEqual({
			'clip.addText.textAnimation': 'wp-m2-text-anim',
			'clip.update.textAnimation': 'wp-m2-text-anim',
			'clip.update.shape': 'wp-m2-shapes',
			'clip.update.template': 'wp-m2-anime-templates',
		});
		const h = new Harness();
		const add = h.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V1',
				content: { text: 'Hi' },
				textAnimation: { in: { preset: 'fade' } },
			},
		]);
		// Implemented by wp-m2-text-anim (packages/project/test/text-animation.test.ts).
		expect(add.ok).toBe(true);
		const ok = h.tx([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hi' }, ref: '$t' },
		]);
		expect(ok.ok).toBe(true);
		const id = ok.ok ? ok.refs.$t! : '';
		const upd = (patch: unknown) => fail(h.tx([{ type: 'clip.update', clipId: id, patch }]));
		expect(upd({ textAnimation: null })).toBeNull();
		expect(upd({ shape: { cornerRadius: 4 } })?.code).toBe('E_INVALID_PARAM');
		expect(upd({ template: { version: 2 } })?.code).toBe('E_INVALID_PARAM');
		expect(upd({ textAnimation: { in: { durationFrames: 0 } } })?.code).toBe('E_SCHEMA');
		// Existing fields are unaffected.
		expect(h.tx([{ type: 'clip.update', clipId: id, patch: { name: 'Renamed' } }]).ok).toBe(true);
	});
	it('clip.addMotionGraphic stamps the anime renderer from the registry; upgrades need an installed target', () => {
		const info = (renderer?: 'anime'): MgTemplateInfo => ({
			id: renderer ? 'title-reveal' : 'card',
			version: 1,
			name: 'T',
			category: 'Titles',
			paramsSchema: z.strictObject({ title: z.string().default('Hello') }),
			defaults: { title: 'Hello' },
			introFrames: 10,
			outroFrames: 10,
			canvasDefault: 'sequence',
			...(renderer ? { renderer } : {}),
		});
		const registries = defaultRegistries(createStaticMgRegistry([info('anime'), info()]));
		const h = new Harness({ ctx: { registries } });
		const r = h.tx([
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 60,
				track: 'V1',
				template: { id: 'title-reveal', version: 1 },
				ref: '$a',
			},
			{
				type: 'clip.addMotionGraphic',
				at: 60,
				duration: 60,
				track: 'V1',
				template: { id: 'card', version: 1 },
				ref: '$f',
			},
		]);
		expect(r.ok).toBe(true);
		const refs = r.ok ? r.refs : {};
		const a = h.seq.clips[refs.$a!] as Extract<Clip, { kind: 'motion-graphic' }>;
		const f = h.seq.clips[refs.$f!] as Extract<Clip, { kind: 'motion-graphic' }>;
		expect(a.template).toEqual({ id: 'title-reveal', version: 1, renderer: 'anime' });
		expect(f.template).toEqual({ id: 'card', version: 1 });
		const up = h.tx([{ type: 'clip.update', clipId: refs.$a!, patch: { template: { version: 2 } } }]);
		// wp-m2-anime-templates implemented the upgrade (S11:ATP-009): version 2 is not installed here.
		expect(fail(up)).toMatchObject({
			code: 'E_INVALID_PARAM',
			message: expect.stringMatching(/not installed/),
		});
	});
});

describe('agent schema (S11:ANA-001)', () => {
	it('lists text animations, template renderers and the kinds of every property', () => {
		const info: MgTemplateInfo = {
			id: 'title-reveal',
			version: 1,
			name: 'Title Reveal',
			category: 'Titles',
			paramsSchema: z.strictObject({ title: z.string().default('Hello') }),
			defaults: { title: 'Hello' },
			introFrames: 20,
			outroFrames: 20,
			canvasDefault: 'sequence',
			renderer: 'anime',
			description: 'Char-staggered title',
			defaultDurationSeconds: 4,
		};
		const s = exportAgentSchema(defaultRegistries(createStaticMgRegistry([info])));
		expect(s.textAnimations.map((t) => t.id)).toContain('slide-up');
		expect(s.mgTemplates[0]).toMatchObject({
			renderer: 'anime',
			description: 'Char-staggered title',
			defaultDurationSeconds: 4,
		});
		expect(s.commands['clip.addShape']).toMatchObject({ owner: 'wp-m2-shapes', implemented: true });
		expect(s.properties.find((p) => p.key === 'transform.position')?.kinds).toContain('shape');
		expect(s.properties.find((p) => p.key === 'opacity')?.kinds).toContain('shape');
		expect(s.warningCodes).toContain('W_ANIMATION_COMPRESSED');
	});
});
