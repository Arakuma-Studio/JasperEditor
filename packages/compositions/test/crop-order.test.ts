// @vitest-environment node
// Crop in stack order (schema v8) on the composition paths: the CSS wrapper stages, the fx canvas chain (hard crop
// steps, the feathered crop's shader stand-in), the colour-stage hand-over, adjustment layers, and a v7 project that
// lists its Crop after another effect rendering exactly as v7 did after load (docs/wp-notes/crop-order.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	buildRenderSnapshot,
	CURRENT_SCHEMA_VERSION,
	clipContentTime,
	defaultEffectRegistry,
	type EffectParams,
	loadProject,
	type ResolvedEffect,
	resolveLayerProps,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { CROP_FEATHER_GPU, cropChainSpec, cropNeedsChain } from '../src/fx/builtins.ts';
import { clipDrawsThroughCanvas } from '../src/fx/flat-plan.ts';
import { type FxStep, planLayerFx } from '../src/fx/plan.ts';
import { adjustmentChainEffects, adjustmentCropRegion } from '../src/layers/AdjustmentScope.tsx';
import { effectStages } from '../src/pipeline.ts';

const fx = (id: string, effectId: string, params: EffectParams = {}, enabled = true): ResolvedEffect => ({
	id,
	effectId,
	effectVersion: 1,
	enabled,
	params,
});
const crop = (params: EffectParams, id = 'c') => fx(id, 'jasper.crop', params);
const mirror = fx('m', 'jasper.mirror', { reflectionCenter: [0.5, 0.5], reflectionAngle: 0 });
const flipH = fx('f', 'jasper.flip-horizontal');
const blur = fx('b', 'jasper.gaussian-blur', { radius: 6, dimensions: 'both', repeatEdge: false });
const tint = fx('t', 'jasper.brightness-contrast', { brightness: 20, contrast: 0 });

const plan = (effects: ResolvedEffect[], extra: Partial<Parameters<typeof planLayerFx>[1]> = {}) =>
	planLayerFx(effects, {
		registry: defaultEffectRegistry,
		gpu: 'ok',
		ctx: { width: 640, height: 360, pxScale: 1, fps: 30 },
		...extra,
	});
const describeStep = (s: FxStep) =>
	s.kind === 'gpu'
		? `gpu:${s.fx.effectId}`
		: s.kind === 'lut'
			? `lut:${s.effects.map((e) => e.effectId).join('+')}`
			: s.kind === 'css' || s.kind === 'crop' || s.kind === 'flip'
				? `${s.kind}:${s.fx.effectId}`
				: s.kind;

describe('CSS stages (effectStages) follow the stack', () => {
	it('nests a crop where it sits: before or after a flip', () => {
		expect(effectStages([crop({ left: 30 }), flipH], 'x').map((s) => s.effectId)).toEqual([
			'jasper.crop',
			'jasper.flip-horizontal',
		]);
		expect(effectStages([flipH, crop({ left: 30 })], 'x').map((s) => s.effectId)).toEqual([
			'jasper.flip-horizontal',
			'jasper.crop',
		]);
	});
	it('a feathered crop draws its hard clip-path here (the feather is the chain’s)', () => {
		const [s] = effectStages([crop({ left: 10, top: 0, right: 0, bottom: 0, feather: 12 })], 'x');
		expect(s?.style.clipPath).toBe('inset(0% 0% 0% 10%)');
	});
});

describe('fx chain (planLayerFx) keeps the crop at its stack position', () => {
	it('Mirror → Crop and Crop → Mirror give the steps in that order', () => {
		// After the last shader effect the crop is the CSS stage drawn on the chain's output: still after the Mirror.
		const a = plan([mirror, crop({ left: 30 })]);
		expect(a?.steps.map(describeStep)).toEqual(['gpu:jasper.mirror']);
		expect(a?.cssEffects.map((e) => e.effectId)).toEqual(['jasper.crop']);
		const b = plan([crop({ left: 30 }), mirror]);
		expect(b?.steps.map(describeStep)).toEqual(['crop:jasper.crop', 'gpu:jasper.mirror']);
		expect(b?.cssEffects).toEqual([]);
	});

	it('a hard crop after the last shader effect stays a CSS stage after the chain (still in order)', () => {
		const p = plan([mirror, flipH, crop({ left: 30 })]);
		expect(p?.steps.map(describeStep)).toEqual(['gpu:jasper.mirror']);
		expect(p?.cssEffects.map((e) => e.effectId)).toEqual(['jasper.flip-horizontal', 'jasper.crop']);
	});

	it('a crop with Edge Feather takes the chain as the shader stand-in, alone or anywhere in the stack', () => {
		const alone = plan([crop({ left: 10, feather: 8 })]);
		expect(alone?.active).toBe(true);
		const step = alone?.steps[0];
		expect(step?.kind).toBe('gpu');
		expect(step?.kind === 'gpu' && step.spec.gpu).toBe(CROP_FEATHER_GPU);
		const after = plan([flipH, crop({ left: 10, feather: 8 }), tint]);
		expect(after?.steps.map(describeStep)).toEqual([
			'flip:jasper.flip-horizontal',
			'gpu:jasper.crop',
			'lut:jasper.brightness-contrast',
		]);
		// Without feather the same stack needs no chain (colour stage + CSS stages are exact).
		expect(plan([flipH, crop({ left: 10 }), tint])).toBeNull();
	});

	it('keeps the feathered path on frames where a keyframed feather evaluates to 0', () => {
		const p = plan([crop({ left: 10, feather: 0 })], { featheredCrops: new Set(['c']) });
		expect(p?.steps.map(describeStep)).toEqual(['gpu:jasper.crop']);
		expect(plan([crop({ left: 10, feather: 0 })])).toBeNull();
	});

	it('without WebGL the feathered crop falls back to its hard clip with the chip', () => {
		const p = plan([crop({ left: 10, feather: 8 })], { gpu: 'unavailable' });
		expect(p?.active).toBe(false);
		expect(p?.bypassed).toEqual([{ fxId: 'c', effectId: 'jasper.crop', reason: 'gpu-unavailable' }]);
		expect(p?.cssEffects.map((e) => e.id)).toEqual(['c']);
	});

	it('a failed stand-in shader degrades to the hard crop as a CSS stage, with the failure chip', () => {
		const p = plan([crop({ left: 10, feather: 8 }), mirror], { failed: (id) => id === 'jasper.crop' });
		expect(p?.steps.map(describeStep)).toEqual(['gpu:jasper.mirror']);
		expect(p?.bypassed).toEqual([{ fxId: 'c', effectId: 'jasper.crop', reason: 'shader-failed' }]);
		expect(p?.cssEffects.map((e) => e.id)).toEqual(['c']);
	});

	it('a crop before a pixel-mixing effect that precedes a colour run takes the chain (the colour stage would cut later)', () => {
		const ordered = [crop({ left: 20 }), blur, tint];
		expect([...cropNeedsChain(ordered, (e) => defaultEffectRegistry.get(e.effectId))]).toEqual(['c']);
		expect(plan(ordered)?.steps.map(describeStep)).toEqual([
			'crop:jasper.crop',
			'css:jasper.gaussian-blur',
			'lut:jasper.brightness-contrast',
		]);
		// After the blur the colour stage's CSS crop is already in place.
		expect(plan([blur, crop({ left: 20 }), tint])).toBeNull();
		// No colour effect: the CSS stages are exact.
		expect(plan([crop({ left: 20 }), blur])).toBeNull();
	});

	it('cropChainSpec only applies to Crop', () => {
		const spec = defaultEffectRegistry.get('jasper.crop')!;
		expect(cropChainSpec(spec, { feather: 0 })).toBeNull();
		expect(cropChainSpec(spec, { feather: 0 }, true)?.gpu).toBe(CROP_FEATHER_GPU);
		expect(cropChainSpec(defaultEffectRegistry.get('jasper.gaussian-blur')!, { feather: 3 })).toBeNull();
	});

	it('the stand-in’s uniforms are the insets and the feather in canvas pixels', () => {
		const u = CROP_FEATHER_GPU.uniforms!(
			{ left: 10, top: 20, right: 30, bottom: 5, feather: 12 },
			{ width: 640, height: 360, pxScale: 0.5, fps: 30, frame: 0, duration: 1, seed: 0, progress: 0 },
		);
		expect(u).toEqual({ u_cfInsets: [0.1, 0.2, 0.3, 0.05], u_cfFeather: 6 });
	});
});

describe('flat compositor', () => {
	it('a DOM layer with a feathered crop draws through its own canvas (the feather runs in the chain)', () => {
		const anim = (value: unknown, keyframes: unknown[] = []) => ({ value, keyframes });
		const text = (feather: ReturnType<typeof anim>) =>
			({
				kind: 'text',
				source: { text: {} },
				masks: [],
				effects: [
					{
						id: 'c',
						effectId: 'jasper.crop',
						effectVersion: 1,
						enabled: true,
						params: { left: anim(10), feather },
					},
				],
			}) as unknown as Parameters<typeof clipDrawsThroughCanvas>[0];
		expect(clipDrawsThroughCanvas(text(anim(0)), null)).toBe(false);
		expect(clipDrawsThroughCanvas(text(anim(5)), null)).toBe(true);
		expect(clipDrawsThroughCanvas(text(anim(0, [{ value: 0 }, { value: 9 }])), null)).toBe(true);
	});
});

describe('adjustment layers', () => {
	it('crops leave the chain unless an effect that mixes pixels follows them (then a hard cut stays in place)', () => {
		expect(adjustmentChainEffects([crop({ left: 20, feather: 4 }), tint]).map((e) => e.id)).toEqual(['t']);
		const cut = adjustmentChainEffects([crop({ left: 20, feather: 4 }), blur]);
		expect(cut.map((e) => e.id)).toEqual(['c:cut', 'b']);
		expect(cut[0]?.params.feather).toBe(0);
		expect(adjustmentChainEffects([blur, crop({ left: 20 })]).map((e) => e.id)).toEqual(['b']);
	});

	it('the region: hard windows intersect, feathered ones are kept with their feather, flips after mirror them', () => {
		const r = adjustmentCropRegion([
			crop({ left: 20 }, 'a'),
			crop({ top: 10, right: 5 }, 'b'),
			crop({ bottom: 30, feather: 9 }, 'c'),
			flipH,
		]);
		expect(r.insets).toEqual([0.05, 0.1, 0.2, 0]);
		expect(r.feather).toEqual([{ insets: [0, 0, 0, 0.3], feather: 9 }]);
		expect(adjustmentCropRegion([flipH, crop({ left: 20 })]).insets).toEqual([0.2, 0, 0, 0]);
		expect(adjustmentCropRegion([tint])).toEqual({ insets: null, feather: [] });
	});
});

describe('a v7 project with Crop listed after another effect', () => {
	it('loads with Crop first and renders it first, as v7 did', () => {
		const file = JSON.parse(
			readFileSync(join(__dirname, '../../project/test/fixtures/schema-v7.jasper'), 'utf8'),
		) as { document: { sequences: Record<string, { clips: Record<string, { effects?: unknown[] }> }> } };
		const seqId = 'seq_000000000000SEQ1';
		const clipId = 'clp_00000000000VC001';
		const anim = (value: unknown) => ({ value, keyframes: [] });
		file.document.sequences[seqId]!.clips[clipId]!.effects = [
			{
				id: 'fx_0000000000000001',
				effectId: 'jasper.flip-horizontal',
				effectVersion: 1,
				enabled: true,
				params: {},
			},
			{
				id: 'fx_0000000000000002',
				effectId: 'jasper.gaussian-blur',
				effectVersion: 1,
				enabled: true,
				params: { radius: anim(4), dimensions: anim('both'), repeatEdge: anim(false) },
			},
			{
				id: 'fx_0000000000000003',
				effectId: 'jasper.crop',
				effectVersion: 1,
				enabled: true,
				params: { left: anim(30), top: anim(0), right: anim(0), bottom: anim(0), feather: anim(0) },
			},
		];
		const loaded = loadProject(file);
		expect(loaded.readOnly).toBe(false);
		expect(loaded.repairs).toEqual([]);
		expect(loaded.document.sequences[seqId]!.clips[clipId]).toMatchObject({
			effects: [{ id: 'fx_0000000000000003' }, { id: 'fx_0000000000000001' }, { id: 'fx_0000000000000002' }],
		});
		expect(loaded.document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		const snap = buildRenderSnapshot(loaded.document, seqId, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId)!;
		const props = resolveLayerProps(clip, clipContentTime(clip, clip.start, snap.settings.fps));
		expect(props.effects.map((e) => e.effectId)).toEqual([
			'jasper.crop',
			'jasper.flip-horizontal',
			'jasper.gaussian-blur',
		]);
		// v7 drew the crop first, so the flip mirrors its window: the same picture after load.
		expect(effectStages(props.effects, 'v7').map((s) => s.effectId)).toEqual([
			'jasper.crop',
			'jasper.flip-horizontal',
			'jasper.gaussian-blur',
		]);
		expect(props.crop).toEqual({ left: 0, top: 0, right: 30, bottom: 0 });
		expect(plan(props.effects, { capture: true })?.steps.map(describeStep)).toEqual([
			'crop:jasper.crop',
			'flip:jasper.flip-horizontal',
			'css:jasper.gaussian-blur',
		]);
	});
});
