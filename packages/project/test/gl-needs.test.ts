// Spec 19 TL-125 / TL-123: `snapshotGlNeeds` — what of a render document needs WebGL2. The Remotion service asked
// `docHasColorEffects`, which read only the enabled colour / GPU effects of top-level clips, so a nest clip whose
// sequence held the effect, a GPU transition, a masked effect, a blend mode or a 3D layer was not seen.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	BLEND_MODES,
	createEffectRegistry,
	defaultEffectRegistry,
	FX_NEEDS_FLOAT,
	fxFloatRefusal,
	GL_NEEDS_MAX_DEPTH,
	isCssBlend,
	planGpuEffect,
	snapshotGlNeeds,
	validateGpuEffect,
} from '../src/index.ts';

const GLOW = 'jasper.s.glow';
const GRADE = 'jasper.lumetri';
const fx = (effectId: string, extra: Record<string, unknown> = {}) => ({
	id: `fx_${effectId}`,
	effectId,
	effectVersion: 1,
	enabled: true,
	params: {},
	...extra,
});
const clip = (clipId: string, extra: Record<string, unknown> = {}) => ({
	clipId,
	effects: [],
	blendMode: 'normal',
	source: { solid: {} },
	...extra,
});
const snap = (clips: unknown[], extra: Record<string, unknown> = {}) => ({
	videoTracks: [{ trackId: 'V1', clips, ...extra }],
});
const nested = (inner: unknown) => clip('nest', { source: { nest: { snapshot: inner } } });
const ids = (doc: unknown) => snapshotGlNeeds(doc).map((n) => `${n.kind}:${n.id}`);

describe('snapshotGlNeeds', () => {
	it('is empty for a document that needs no WebGL', () => {
		expect(ids(snap([clip('a'), clip('b', { effects: [fx('jasper.crop')] })]))).toEqual([]);
		expect(ids(snap([clip('a', { effects: [fx(GLOW, { enabled: false })] })]))).toEqual([]);
		expect(ids({})).toEqual([]);
	});

	it('finds enabled GPU and colour effects of top-level clips (what docHasColorEffects found)', () => {
		const needs = snapshotGlNeeds(snap([clip('a', { effects: [fx(GLOW), fx(GRADE)] })]));
		expect(needs.map((n) => [n.kind, n.id, n.clipId])).toEqual([
			['effect', GLOW, 'a'],
			['effect', GRADE, 'a'],
		]);
	});

	it('finds them inside nested sequences, at any depth (regression: docHasColorEffects stopped at the top)', () => {
		const deep = nested(snap([nested(snap([clip('inner', { effects: [fx(GLOW)] })]))]));
		expect(snapshotGlNeeds(snap([deep])).map((n) => [n.id, n.clipId])).toEqual([[GLOW, 'inner']]);
	});

	it('finds GPU transitions, masked CSS effects, blend modes CSS cannot draw, 3D layers and matte tracks', () => {
		const hard = BLEND_MODES.find((m) => !isCssBlend(m))!;
		expect(ids(snap([clip('a')], { transitions: [{ id: 't1', effectId: 'jasper.push' }] }))).toEqual([
			'transition:jasper.push',
		]);
		const mask = (mode = 'add') => ({
			mode,
			path: { value: { closed: true, vertices: [{}, {}, {}] }, keyframes: [] },
		});
		expect(ids(snap([clip('a', { effects: [fx('jasper.crop', { masks: [mask()] })] })]))).toEqual([
			'effect-masks:jasper.crop',
		]);
		expect(ids(snap([clip('a', { masks: [mask()] })]))).toEqual(['masks:masks']);
		// a mask that draws nothing (mode none, an open path) needs no WebGL
		expect(
			ids(
				snap([
					clip('a', {
						masks: [
							mask('none'),
							{ mode: 'add', path: { value: { closed: false, vertices: [{}, {}] }, keyframes: [] } },
						],
					}),
				]),
			),
		).toEqual([]);
		expect(ids(snap([clip('a', { blendMode: hard })]))).toEqual([`blend:${hard}`]);
		expect(ids(snap([clip('a', { blendMode: 'normal' })]))).toEqual([]);
		expect(ids(snap([clip('a', { threeD: { enabled: true } })]))).toEqual(['3d:3d']);
		expect(
			ids({
				...snap([clip('a')]),
				matteTracks: [{ trackId: 'V2', clips: [clip('m', { effects: [fx(GLOW)] })] }],
			}),
		).toEqual([`effect:${GLOW}`]);
	});

	it('marks effects that require float render targets with their refusal', () => {
		const glow = defaultEffectRegistry.get(GLOW)!;
		const registry = createEffectRegistry([
			...defaultEffectRegistry.list().filter((s) => s.id !== GLOW),
			{ ...glow, gpu: { ...glow.gpu!, requiresFloat: 'TITLE_LOOK_NEEDS_FLOAT' } },
		]);
		const [n] = snapshotGlNeeds(snap([clip('a', { effects: [fx(GLOW)] })]), registry);
		expect(n!.float).toMatchObject({ code: 'TITLE_LOOK_NEEDS_FLOAT' });
		const [plain] = snapshotGlNeeds(snap([clip('a', { effects: [fx(GLOW)] })]));
		expect(plain!.float).toBeUndefined();
	});

	it('is bounded in depth and safe on cycles', () => {
		let doc: unknown = snap([clip('deepest', { effects: [fx(GLOW)] })]);
		for (let i = 0; i < GL_NEEDS_MAX_DEPTH + 4; i++) doc = snap([nested(doc)]);
		expect(ids(doc)).toEqual([]);
		const loop = snap([]) as { videoTracks: { clips: unknown[] }[] };
		loop.videoTracks[0]!.clips.push(nested(loop), clip('x', { effects: [fx(GLOW)] }));
		expect(snapshotGlNeeds(loop)).toHaveLength(1);
	});

	it('never throws on any input (fuzz)', () => {
		fc.assert(
			fc.property(fc.anything({ maxDepth: 6 }), (doc) => {
				expect(Array.isArray(snapshotGlNeeds(doc))).toBe(true);
			}),
		);
	});
});

describe('GpuEffect.requiresFloat (TL-123)', () => {
	const glow = defaultEffectRegistry.get(GLOW)!;
	const floatSpec = (requiresFloat: boolean | string) => ({ ...glow, gpu: { ...glow.gpu!, requiresFloat } });

	it('names a refusal code: the effect’s own, else FX_NEEDS_FLOAT; none when not declared', () => {
		expect(fxFloatRefusal(glow)).toBeNull();
		expect(fxFloatRefusal(floatSpec(true))).toMatchObject({ code: FX_NEEDS_FLOAT });
		expect(fxFloatRefusal(floatSpec('TITLE_LOOK_NEEDS_FLOAT'))!.message).toContain('Glow');
		expect(fxFloatRefusal(floatSpec('TITLE_LOOK_NEEDS_FLOAT'))!.code).toBe('TITLE_LOOK_NEEDS_FLOAT');
	});

	it('validation accepts a capitalised code and rejects anything else', () => {
		expect(
			validateGpuEffect(floatSpec('TITLE_LOOK_NEEDS_FLOAT')).filter((m) => /requiresFloat/.test(m)),
		).toEqual([]);
		expect(validateGpuEffect(floatSpec(true)).filter((m) => /requiresFloat/.test(m))).toEqual([]);
		expect(validateGpuEffect(floatSpec('needs float')).filter((m) => /requiresFloat/.test(m))).toHaveLength(
			1,
		);
	});

	it('the plan carries the code for the host, and effects that do not declare it carry none', () => {
		const ctx = {
			width: 1920,
			height: 1080,
			pxScale: 1,
			fps: 30,
			frame: 0,
			duration: 30,
			seed: 0.5,
			progress: 0,
		};
		const params = Object.fromEntries(glow.params.map((p) => [p.name, p.default]));
		const canvas = { width: 1920, height: 1080 };
		expect(
			planGpuEffect(floatSpec('X_NEEDS_FLOAT') as never, { id: 'fx_1', params }, ctx, canvas).requiresFloat,
		).toBe('X_NEEDS_FLOAT');
		expect(planGpuEffect(glow, { id: 'fx_1', params }, ctx, canvas).requiresFloat).toBeUndefined();
	});
});
