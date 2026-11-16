import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type Clip,
	checkInvariants,
	compressAnimationWindows,
	createStaticMgRegistry,
	defaultEffectRegistry,
	defaultRegistries,
	defaultShape,
	exportAgentSchema,
	intrinsicBoxOf,
	type LegacyShapeClip,
	loadProject,
	type MgTemplateInfo,
	type ProjectDocument,
	type ProjectEnvelope,
	resolveTextAnimationWindows,
	type ShapeData,
	scaleAnimationFrames,
	shapeIntrinsicBox,
	type TextAnimationSpec,
} from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureV4 = (): ProjectEnvelope =>
	JSON.parse(readFileSync(join(here, 'fixtures/v4/basic.jasper'), 'utf8'));
const loadV4 = () => loadProject(fixtureV4(), { effects: defaultEffectRegistry }).document;
const clipsOf = (doc: ProjectDocument) => Object.values(Object.values(doc.sequences)[0]!.clips);

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
	it('saved v4 fixture (animated text, anime template, rect + ellipse) loads without repairs (v4 → v6)', () => {
		const r = loadProject(fixtureV4(), { effects: defaultEffectRegistry });
		expect(r.readOnly).toBe(false);
		expect(r.migration.steps).toEqual([
			'v4→v5',
			'v5→v6',
			'v6→v7',
			'v7→v8',
			'v8→v9',
			'v9→v10',
			'v10→v11',
			'v11→v12',
			'v12→v13',
			'v13→v14',
			'v14→v15',
			'v15→v16',
			'v16→v17',
		]);
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
		const seq = Object.values(bad.document.sequences)[0]!;
		const text = Object.values(seq.clips).find((c) => c.kind === 'text')!;
		text.textAnimation!.in!.durationFrames = 0;
		expect(() => loadProject(bad)).toThrow(/does not match the schema/);
		const doc = loadV4();
		const s2 = Object.values(doc.sequences)[0]!;
		const t2 = Object.values(s2.clips).find((c) => c.kind === 'text')!;
		t2.textAnimation!.out!.durationFrames = 2.5;
		const rect = Object.values(s2.clips).find((c) => c.kind === 'shape') as LegacyShapeClip;
		rect.shape.size.value = [-1, 10];
		rect.shape.cornerRadius.value = -2;
		const issues = checkInvariants(doc).map((i) => i.message);
		expect(issues.some((m) => /out animation duration/.test(m))).toBe(true);
		expect(issues.some((m) => /size must be two numbers/.test(m))).toBe(true);
		expect(issues.some((m) => /corner radius/.test(m))).toBe(true);
	});
});

describe('shapes (S11:SHP-001/003)', () => {
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
	it('scales reference-rate frames to the sequence rate (round, ≥ 1)', () => {
		expect(scaleAnimationFrames(15, 60)).toBe(30);
		expect(scaleAnimationFrames(15, { num: 24000, den: 1001 })).toBe(12);
		expect(scaleAnimationFrames(1, 1)).toBe(1);
	});
	it('compresses in + out proportionally when they do not fit the clip with one frame at rest', () => {
		expect(compressAnimationWindows(100, 20, 30)).toEqual({ in: 20, out: 30, compressed: false });
		expect(compressAnimationWindows(40, 30, 30)).toEqual({ in: 20, out: 19, compressed: true });
		expect(compressAnimationWindows(40, 20, 20)).toEqual({ in: 20, out: 19, compressed: true });
		expect(compressAnimationWindows(41, 20, 20)).toEqual({ in: 20, out: 20, compressed: false });
		expect(compressAnimationWindows(10, 30, 10)).toEqual({ in: 7, out: 2, compressed: true });
		expect(compressAnimationWindows(10, 1, 100)).toEqual({ in: 1, out: 8, compressed: true });
		expect(compressAnimationWindows(10, 0, 30)).toEqual({ in: 0, out: 10, compressed: true });
		expect(compressAnimationWindows(10, 10, 0)).toEqual({ in: 10, out: 0, compressed: false });
		for (let d = 3; d < 60; d++)
			for (const [a, b] of [
				[d, d],
				[1, 3 * d],
				[2 * d, 1],
			] as const) {
				const w = compressAnimationWindows(d, a, b);
				expect(w.in + w.out).toBeLessThanOrEqual(d - 1);
				expect(w.in).toBeGreaterThanOrEqual(1);
				expect(w.out).toBeGreaterThanOrEqual(1);
			}
	});
	it('keeps one frame at rest on 1- and 2-frame clips with both sides (the text shows)', () => {
		expect(compressAnimationWindows(1, 5, 5)).toEqual({ in: 0, out: 0, compressed: true });
		expect(compressAnimationWindows(1, 1, 1)).toEqual({ in: 0, out: 0, compressed: true });
		expect(compressAnimationWindows(2, 1, 1)).toEqual({ in: 1, out: 0, compressed: true });
		expect(compressAnimationWindows(2, 3, 8)).toEqual({ in: 0, out: 1, compressed: true });
		const clip = {
			duration: 1,
			textAnimation: {
				in: { preset: 'fade', version: 1, durationFrames: 15, params: {} },
				out: { preset: 'fade', version: 1, durationFrames: 15, params: {} },
			},
		};
		const w = resolveTextAnimationWindows(clip, [FADE]);
		expect([w.in?.frames, w.out?.frames, w.compressed]).toEqual([0, 0, true]);
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
		expect(w.out).toEqual({ preset: 'mystery', version: 3, params: { x: 1 }, frames: 9 });
		expect(w.compressed).toBe(true);
		expect(w.unknown).toEqual(['mystery@3']);
		expect(resolveTextAnimationWindows({ duration: 20, textAnimation: { in: null } })).toEqual({
			compressed: false,
			unknown: [],
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
		// every version is described (documents may hold superseded ones); `latest` marks what new animations use
		expect(s.textAnimations.filter((t) => t.id === 'typewriter').map((t) => [t.version, t.latest])).toEqual([
			[1, false],
			[2, true],
		]);
		expect(s.mgTemplates[0]).toMatchObject({
			renderer: 'anime',
			description: 'Char-staggered title',
			defaultDurationSeconds: 4,
		});
		expect(s.properties.find((p) => p.key === 'transform.position')?.kinds).toContain('shape');
		expect(s.properties.find((p) => p.key === 'opacity')?.kinds).toContain('shape');
		expect(s.warningCodes).toContain('W_ANIMATION_COMPRESSED');
	});
});
