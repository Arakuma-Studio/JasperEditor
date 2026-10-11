import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	animatedTemplateParams,
	buildRenderSnapshot,
	type Clip,
	checkInvariants,
	clipPropertiesJsonSchema,
	createStaticMgRegistry,
	defaultRegistries,
	evaluateTemplateParams,
	FLICKS_PER_SECOND,
	loadProject,
	type MgTemplateInfo,
	type MgTemplateRegistry,
	makeEnvelope,
	type ProjectDocument,
	paramsPropertySpecs,
	repairDocument,
	resolvePropertyAt,
	resolvePropertySpec,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type Mg = Extract<Clip, { kind: 'motion-graphic' }>;
const channel = z.number().min(0).max(1);
const rgba = (d: number[]) => z.array(channel).length(4).default(d);

const revealV1 = z.strictObject({
	title: z.string().max(40).default('Hello'),
	color: rgba([1, 1, 1, 1]),
	size: z.number().min(10).max(200).default(100),
	count: z.number().int().min(0).max(10).default(3),
	align: z.enum(['left', 'center']).default('center'),
});
const revealV2 = z.strictObject({
	heading: z.string().max(40).default('Hello'),
	color: rgba([1, 1, 1, 1]),
	scale: z.number().min(0).max(5).default(1),
});

function info(id: string, version: number, schema: z.ZodType, renderer?: 'anime'): MgTemplateInfo {
	return {
		id,
		version,
		name: `${id} v${version}`,
		category: 'Titles',
		paramsSchema: schema,
		defaults: schema.parse({}) as Record<string, unknown>,
		introFrames: 10,
		outroFrames: 10,
		canvasDefault: 'sequence',
		...(renderer ? { renderer } : {}),
	};
}

/** A registry with an upgrade path reveal@1 → reveal@2 (title → heading, size → scale). */
function registry(): MgTemplateRegistry {
	const base = createStaticMgRegistry([
		info('reveal', 1, revealV1, 'anime'),
		info('reveal', 2, revealV2, 'anime'),
		info('card', 1, revealV1),
		info('card', 2, revealV1, 'anime'),
	]);
	return {
		...base,
		upgrade: (id, from, params, to) => {
			if (id === 'reveal' && from === 1 && (to === undefined || to === 2))
				return { version: 2, params: { heading: params.title, color: params.color, scale: 1 } };
			if (id === 'card' && from === 1 && (to === undefined || to === 2)) return { version: 2, params };
			return null;
		},
	};
}

function setup() {
	const registries = defaultRegistries(registry());
	const h = new Harness({ ctx: { registries } });
	const r = h.ok([
		{
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 90,
			track: 'V1',
			template: { id: 'reveal', version: 1 },
			ref: '$a',
		},
		{
			type: 'clip.addMotionGraphic',
			at: 100,
			duration: 60,
			track: 'V1',
			template: { id: 'card', version: 1 },
			ref: '$f',
		},
	]);
	return { h, a: r.refs.$a!, f: r.refs.$f!, reg: registries.mgTemplates };
}
const mg = (h: Harness, id: string) => h.seq.clips[id] as Mg;
const F = FLICKS_PER_SECOND / 30;
const fail = (r: ReturnType<Harness['tx']>) => (r.ok ? null : r.errors[0]!);

describe('keyframable params of anime templates (S11:ATP-006)', () => {
	it('numeric (non-integer) and colour params are keyframable on anime templates only', () => {
		const anime = paramsPropertySpecs(info('reveal', 1, revealV1, 'anime'));
		const by = (k: string) => anime.find((s) => s.key === `params.${k}`)!;
		expect(by('color').animatable).toBe('continuous');
		expect(by('size').animatable).toBe('continuous');
		expect(by('count').animatable).toBe('no');
		expect(by('title').animatable).toBe('no');
		expect(by('align').animatable).toBe('no');
		for (const s of paramsPropertySpecs(info('card', 1, revealV1))) expect(s.animatable).toBe('no');
		const schema = clipPropertiesJsonSchema({ kind: 'motion-graphic' } as Clip, {
			template: info('reveal', 1, revealV1, 'anime'),
		}) as { properties: Record<string, Record<string, unknown>> };
		expect(schema.properties['params.color']?.['x-animatable']).toBe('continuous');
		expect(schema.properties['params.title']?.['x-animatable']).toBe('no');
	});

	it('the stopwatch, param.set at frames and the keyframe commands work on params.<name>', () => {
		const { h, a } = setup();
		const target = ['clip', a, 'params', 'color'];
		h.ok([{ type: 'param.set', target, value: [1, 0, 0, 1] }]);
		expect(mg(h, a).params.color).toEqual([1, 0, 0, 1]);
		expect(mg(h, a).paramKeyframes).toBeUndefined();
		const on = h.ok([{ type: 'param.setAnimated', target, animated: true, at: { frames: 0 } }]);
		const k0 = (on.results[0] as { keyframeId: string }).keyframeId;
		expect(mg(h, a).paramKeyframes?.color).toEqual([
			expect.objectContaining({ id: k0, time: 0, value: [1, 0, 0, 1], interpolation: 'linear' }),
		]);
		const set = h.ok([{ type: 'param.set', target, value: [0, 0, 2, 1], at: { frames: 30 } }]);
		expect(set.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');
		expect(mg(h, a).paramKeyframes?.color?.map((k) => [k.time, k.value])).toEqual([
			[0, [1, 0, 0, 1]],
			[30 * F, [0, 0, 1, 1]],
		]);
		expect(animatedTemplateParams(mg(h, a))).toEqual(['color']);
		const spec = resolvePropertySpec('params.color', info('reveal', 1, revealV1, 'anime'))!;
		const mid = resolvePropertyAt({ doc: h.doc, seq: h.seq, clip: mg(h, a) }, spec, 15);
		expect(mid.animated).toBe(true);
		expect(mid.value).toEqual([0.5, 0, 0.5, 1]);
		const add = h.ok([
			{ type: 'keyframe.add', target: ['clip', a, 'params', 'size'], at: { frames: 10 }, value: 150 },
		]);
		const ks = (add.results[0] as { keyframeId: string }).keyframeId;
		const k1 = mg(h, a).paramKeyframes!.color![1]!.id;
		h.ok([
			{ type: 'keyframe.update', keyframeId: k1, value: [0, 1, 0, 1] },
			{ type: 'keyframe.setInterpolation', keyframeIds: [k0], interpolation: 'hold' },
			{ type: 'keyframe.move', keyframeIds: [ks], delta: { frames: 5 } },
		]);
		expect(mg(h, a).paramKeyframes?.color?.[1]?.value).toEqual([0, 1, 0, 1]);
		expect(mg(h, a).paramKeyframes?.color?.[0]?.interpolation).toBe('hold');
		expect(mg(h, a).paramKeyframes?.size?.[0]?.time).toBe(15 * F);
		expect(fail(h.tx([{ type: 'keyframe.update', keyframeId: ks, value: 'big' }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
		h.ok([{ type: 'keyframe.remove', keyframeIds: [ks] }]);
		expect(mg(h, a).paramKeyframes?.size).toBeUndefined();
		expect(mg(h, a).params.size).toBe(150);
		h.ok([{ type: 'param.setAnimated', target, animated: false, at: { frames: 30 } }]);
		expect(mg(h, a).paramKeyframes).toBeUndefined();
		expect(mg(h, a).params.color).toEqual([0, 1, 0, 1]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('integer, string and enum params and fframes template params stay static', () => {
		const { h, a, f } = setup();
		for (const [clip, name] of [
			[a, 'count'],
			[a, 'title'],
			[f, 'color'],
			[f, 'size'],
		] as const) {
			const r = h.tx([{ type: 'param.setAnimated', target: ['clip', clip, 'params', name], animated: true }]);
			expect(fail(r)?.code, `${clip} ${name}`).toBe('E_INVALID_PARAM');
		}
		expect(
			fail(h.tx([{ type: 'param.set', target: ['clip', a, 'params', 'title'], value: 'x'.repeat(41) }]))
				?.code,
		).toBe('E_INVALID_PARAM');
	});

	it('keyframes.prune, split and duplicate handle param keyframes (fresh ids, content time)', () => {
		const { h, a } = setup();
		const target = ['clip', a, 'params', 'size'];
		h.ok([
			{ type: 'keyframe.add', target, at: { frames: 0 }, value: 10 },
			{ type: 'keyframe.add', target, at: { frames: 60 }, value: 70 },
			{ type: 'keyframe.add', target, at: { frames: 200 }, value: 200 },
			{ type: 'keyframe.add', target, at: { frames: 300 }, value: 200 },
		]);
		const pruned = h.ok([{ type: 'keyframes.prune', clipId: a }]);
		expect((pruned.results[0] as { removed: number }).removed).toBe(1);
		const split = h.ok([{ type: 'clip.split', at: 45, clipIds: [a] }]);
		const right = (split.results[0] as { right: string[] }).right[0]!;
		const left = mg(h, a).paramKeyframes!.size!;
		const r = mg(h, right).paramKeyframes!.size!;
		expect(r.map((k) => k.time)).toEqual(left.map((k) => k.time));
		expect(r.map((k) => k.id).some((id) => left.some((l) => l.id === id))).toBe(false);
		expect(checkInvariants(h.doc)).toEqual([]);
		const spec = resolvePropertySpec('params.size', info('reveal', 1, revealV1, 'anime'))!;
		const l44 = resolvePropertyAt({ doc: h.doc, seq: h.seq, clip: mg(h, a) }, spec, 44).value as number;
		const r46 = resolvePropertyAt({ doc: h.doc, seq: h.seq, clip: mg(h, right) }, spec, 46).value as number;
		expect(r46 - l44).toBeCloseTo(2, 6);
	});

	it('evaluates template values and clamps an overshoot, ignoring static parameter keys', () => {
		const tpl = info('reveal', 1, revealV1, 'anime');
		const key = (time: number, value: unknown) => ({
			id: `kf_${time}`,
			time,
			value,
			interpolation: 'linear' as const,
			easeIn: { influence: 1 / 3, slope: 1 },
			easeOut: { influence: 1 / 3, slope: 1 },
		});
		const out = evaluateTemplateParams(
			tpl,
			tpl.defaults,
			{
				size: [key(0, 20), key(100, 180)],
				count: [key(0, 1), key(100, 9)],
				color: [key(0, [1, 0, 0, 1]), key(100, [0, 0, 1, 1])],
			},
			25,
		);
		expect(out).toMatchObject({ size: 60, count: 3, color: [0.75, 0, 0.25, 1] });
		const over = evaluateTemplateParams(
			tpl,
			tpl.defaults,
			{
				size: [
					{ ...key(0, 10), interpolation: 'bezier', easeOut: { influence: 1 / 3, slope: 10 } },
					{ ...key(100, 200), easeIn: { influence: 1 / 3, slope: 0 } },
				],
			},
			50,
		);
		expect(over.size).toBe(200);
	});

	it('the snapshot carries param keyframes for anime templates only (unevaluated)', () => {
		const { h, a, f } = setup();
		h.ok([{ type: 'keyframe.add', target: ['clip', a, 'params', 'size'], at: { frames: 10 }, value: 50 }]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const clips = snap.videoTracks.flatMap((t) => t.clips);
		const sa = clips.find((c) => c.clipId === a)!;
		const sf = clips.find((c) => c.clipId === f)!;
		expect('mg' in sa.source && sa.source.mg.renderer).toBe('anime');
		expect('mg' in sa.source && sa.source.mg.paramKeyframes?.size?.[0]).toMatchObject({
			time: 10 * F,
			value: 50,
		});
		expect('mg' in sf.source && 'paramKeyframes' in sf.source.mg).toBe(false);
		expect('mg' in sf.source && 'renderer' in sf.source.mg).toBe(false);
	});
});

describe('template version upgrade (S11:ATP-009, FIX-005)', () => {
	it('clip.update {template: {version}} migrates params, re-stamps and keeps compatible keyframes', () => {
		const { h, a } = setup();
		h.ok([
			{ type: 'param.set', target: ['clip', a, 'params', 'title'], value: 'Ciao' },
			{
				type: 'keyframe.add',
				target: ['clip', a, 'params', 'color'],
				at: { frames: 0 },
				value: [1, 0, 0, 1],
			},
			{ type: 'keyframe.add', target: ['clip', a, 'params', 'size'], at: { frames: 0 }, value: 20 },
		]);
		const before = h.doc;
		const r = h.ok([{ type: 'clip.update', clipId: a, patch: { template: { version: 2 } } }]);
		expect(mg(h, a).template).toEqual({ id: 'reveal', version: 2, renderer: 'anime' });
		expect(mg(h, a).params).toEqual({ heading: 'Ciao', color: [1, 1, 1, 1], scale: 1 });
		expect(Object.keys(mg(h, a).paramKeyframes ?? {})).toEqual(['color']);
		expect(r.warnings).toEqual([expect.objectContaining({ code: 'W_KEYFRAMES_DROPPED' })]);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect((before.sequences[h.seqId]!.clips[a] as Mg).template.version).toBe(1);
	});
	it('params in the same patch as an upgrade target the new version', () => {
		const { h, a } = setup();
		h.ok([
			{
				type: 'clip.update',
				clipId: a,
				patch: { template: { version: 2 }, params: { heading: 'Hola', scale: 2 } },
			},
		]);
		expect(mg(h, a).template.version).toBe(2);
		expect(mg(h, a).params).toEqual({ heading: 'Hola', color: [1, 1, 1, 1], scale: 2 });
	});
	it('re-stamps the renderer when a new version changes it (fframes → anime)', () => {
		const { h, f } = setup();
		h.ok([{ type: 'clip.update', clipId: f, patch: { template: { version: 2 } } }]);
		expect(mg(h, f).template).toEqual({ id: 'card', version: 2, renderer: 'anime' });
	});
	it('refuses downgrades, versions that are not installed and versions without a path; same version is a no-op', () => {
		const { h, a } = setup();
		expect(h.tx([{ type: 'clip.update', clipId: a, patch: { template: { version: 1 } } }]).ok).toBe(true);
		expect(fail(h.tx([{ type: 'clip.update', clipId: a, patch: { template: { version: 3 } } }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
		h.ok([{ type: 'clip.update', clipId: a, patch: { template: { version: 2 } } }]);
		expect(fail(h.tx([{ type: 'clip.update', clipId: a, patch: { template: { version: 1 } } }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
		const noPath = new Harness({
			ctx: {
				registries: defaultRegistries(
					createStaticMgRegistry([info('x', 1, revealV1), info('x', 2, revealV1)]),
				),
			},
		});
		const id = noPath.ok([
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 30,
				track: 'V1',
				template: { id: 'x', version: 1 },
				ref: '$x',
			},
		]).refs.$x!;
		expect(
			fail(noPath.tx([{ type: 'clip.update', clipId: id, patch: { template: { version: 2 } } }]))?.code,
		).toBe('E_INVALID_PARAM');
	});
});

describe('template upgrade checks the clip canvas against the new version (review fix)', () => {
	const wide = { width: 1920, height: 1080 };
	const square = { width: 1080, height: 1080 };
	function canvasHarness() {
		const reg = createStaticMgRegistry([
			{ ...info('c', 1, revealV1, 'anime'), canvases: [wide, square] },
			{ ...info('c', 2, revealV1, 'anime'), canvases: [wide] },
		]);
		const registries = defaultRegistries({
			...reg,
			upgrade: (id, from, params, to) =>
				id === 'c' && from === 1 && (to === undefined || to === 2) ? { version: 2, params } : null,
		});
		return new Harness({ ctx: { registries } });
	}
	const add = (h: Harness, canvas: unknown) =>
		h.ok([
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 30,
				track: 'V1',
				template: { id: 'c', version: 1 },
				canvas,
				ref: '$c',
			} as never,
		]).refs.$c!;
	const upgrade = (h: Harness, id: string) =>
		h.tx([{ type: 'clip.update', clipId: id, patch: { template: { version: 2 } } }]);
	it('refuses an upgrade whose version lacks the canvas the clip uses', () => {
		const h = canvasHarness();
		const id = add(h, square);
		const e = fail(upgrade(h, id));
		expect(e?.code).toBe('E_INVALID_PARAM');
		expect(mg(h, id).template.version).toBe(1);
		h.ok([{ type: 'clip.update', clipId: id, patch: { template: { version: 2 }, canvas: wide } }]);
		expect(mg(h, id)).toMatchObject({ template: { version: 2 }, canvas: wide });
	});
	it('accepts the same aspect at another size, the sequence canvas, and canvases the old version lacked too', () => {
		const h = canvasHarness();
		const scaled = add(h, { width: 1280, height: 720 });
		expect(upgrade(h, scaled).ok).toBe(true);
		expect(mg(h, scaled).template.version).toBe(2);
		const h2 = canvasHarness();
		expect(h2.seq.settings.width / h2.seq.settings.height).toBeCloseTo(16 / 9, 3);
		const seqCanvas = add(h2, 'sequence');
		expect(upgrade(h2, seqCanvas).ok).toBe(true);
		const h3 = canvasHarness();
		const odd = add(h3, { width: 800, height: 600 });
		expect(upgrade(h3, odd).ok).toBe(true);
	});
});

describe('renderer stamp invariant (S11:ATP-002)', () => {
	function contradicted(): { doc: ProjectDocument; a: string; f: string; reg: MgTemplateRegistry } {
		const { h, a, f, reg } = setup();
		const doc = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
		const seq = Object.values(doc.sequences)[0]!;
		delete (seq.clips[a] as Mg).template.renderer;
		(seq.clips[f] as Mg).template.renderer = 'anime';
		return { doc, a, f, reg };
	}
	it('flags a stamp that contradicts a known registry entry (unknown templates are left alone)', () => {
		const { doc, reg } = contradicted();
		expect(checkInvariants(doc)).toEqual([]);
		const issues = checkInvariants(doc, { mgTemplates: reg });
		expect(issues.map((i) => i.invariant)).toEqual(['INV-012', 'INV-012']);
		const unknown = checkInvariants(doc, { mgTemplates: createStaticMgRegistry([]) });
		expect(unknown).toEqual([]);
	});
	it('repairs the stamps on load (loadProject with the registry) and drops malformed param keyframes', () => {
		const { doc, a, f, reg } = contradicted();
		const seq = Object.values(doc.sequences)[0]!;
		(seq.clips[a] as Mg).paramKeyframes = {
			size: [
				{
					id: 'kf_AAAAAAAAAAAAAAA1',
					time: 10,
					value: 1,
					interpolation: 'linear',
					easeIn: { influence: 0.3, slope: 1 },
					easeOut: { influence: 0.3, slope: 1 },
				},
				{
					id: 'kf_AAAAAAAAAAAAAAA2',
					time: 5,
					value: 2,
					interpolation: 'linear',
					easeIn: { influence: 0.3, slope: 1 },
					easeOut: { influence: 0.3, slope: 1 },
				},
			],
		};
		const envelope = makeEnvelope(doc, { revision: 1, savedAt: 't', platform: 'test' });
		const loaded = loadProject(envelope, { mgTemplates: reg });
		const s = Object.values(loaded.document.sequences)[0]!;
		expect((s.clips[a] as Mg).template.renderer).toBe('anime');
		expect('renderer' in (s.clips[f] as Mg).template).toBe(false);
		expect((s.clips[a] as Mg).paramKeyframes).toBeUndefined();
		expect(loaded.repairs.map((r) => r.action).sort()).toEqual([
			'drop-keyframes',
			'restamp-renderer',
			'restamp-renderer',
		]);
		expect(loaded.issues).toEqual([]);
		const r2 = repairDocument(doc, { next: () => 'x' } as never);
		expect(r2.report.map((r) => r.action)).toEqual(['drop-keyframes']);
		expect(
			(r2.document.sequences[Object.keys(doc.sequences)[0]!]!.clips[a] as Mg).template.renderer,
		).toBeUndefined();
		expect((r2.document.sequences[Object.keys(doc.sequences)[0]!]!.clips[f] as Mg).template.renderer).toBe(
			'anime',
		);
	});
});
