import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type Animatable,
	BRIGHTNESS_CONTRAST_EFFECT,
	buildRenderSnapshot,
	type Clip,
	CROP_EFFECT,
	checkInvariants,
	clipContentTimeAtFrame,
	clipPropertiesJsonSchema,
	contentTimeAt,
	createEffectRegistry,
	createStaticMgRegistry,
	defaultEffectRegistry,
	defaultRegistries,
	EASE_PRESETS,
	type EffectInstance,
	type EffectSpec,
	effectPropertySpecs,
	evaluate,
	getPropertySpec,
	type ProjectDocument,
	paramsPropertySpecs,
	propertyDefault,
	propertyWriteCommand,
	type Rational,
	resolvePropertyAt,
	resolveSceneAt,
	sequenceFrameOfContentTime,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type VClip = Extract<Clip, { kind: 'solid' }>;
const solid = (at: number, duration: number, track = 'V1') => ({
	type: 'clip.addSolid',
	at,
	duration,
	track,
	color: [1, 0, 0, 1],
});

function withSolid(duration = 100): { h: Harness; id: string } {
	const h = new Harness();
	h.ok([solid(0, duration)]);
	return { h, id: h.clips('V1')[0]!.id };
}
const clipOf = (h: Harness, id: string) => h.seq.clips[id] as VClip;
const rateOf = (h: Harness) => h.seq.settings.frameRate as Rational;
const opacityAt = (h: Harness, id: string, frame: number) => {
	const c = clipOf(h, id);
	return evaluate(c.opacity, contentTimeAt(c, frame, rateOf(h)), { clamp: { min: 0, max: 100 } });
};
function patchDoc(h: Harness, fn: (doc: ProjectDocument) => void) {
	const copy = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
	fn(copy);
	h.doc = copy;
}

describe('effect.add / remove / reorder / setEnabled (S01:FX-020…023)', () => {
	it('AC-10 (blur half): an agent transaction creates a text clip and blurs it through a temp ref', () => {
		const h = new Harness();
		const r = h.ok(
			[
				{
					type: 'clip.addText',
					ref: '$title',
					at: 30,
					duration: 120,
					track: 'V2',
					content: { text: 'Launch Day' },
				},
				{
					type: 'effect.add',
					target: { clipId: '$title' },
					effectId: 'jasper.gaussian-blur',
					params: { radius: 6 },
					ref: '$blur',
				},
			],
			{ origin: { agent: 'editor-assistant' }, label: 'Add blurred title' },
		);
		const clip = h.seq.clips[r.refs.$title!] as Extract<Clip, { kind: 'text' }>;
		expect(r.refs.$blur).toMatch(/^fx_/);
		expect(clip.effects).toHaveLength(1);
		expect(clip.effects[0]).toMatchObject({
			id: r.refs.$blur,
			effectId: 'jasper.gaussian-blur',
			effectVersion: 1,
			enabled: true,
		});
		expect(clip.effects[0]!.params.radius).toEqual({ value: 6, keyframes: [] });
		expect(clip.effects[0]!.params.dimensions).toEqual({ value: 'both', keyframes: [] });
		expect(r.created).toContain(r.refs.$title);
	});

	it('inserts at an index, validates and clamps params, refuses unknown ids and wrong targets', () => {
		const { h, id } = withSolid();
		h.ok([
			{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.black-white' },
			{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.hue-saturation' },
			{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.crop', index: 0, params: { left: 10 } },
		]);
		expect(clipOf(h, id).effects.map((e) => e.effectId)).toEqual([
			'jasper.crop',
			'jasper.black-white',
			'jasper.hue-saturation',
		]);
		const clamped = h.ok([
			{
				type: 'effect.add',
				target: { clipId: id },
				effectId: 'jasper.gaussian-blur',
				params: { radius: 9999 },
			},
		]);
		expect(clamped.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');
		expect(clipOf(h, id).effects[3]!.params.radius!.value).toBe(500);
		const cases: [unknown, string][] = [
			[{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.nope' }, 'E_UNKNOWN_EFFECT'],
			[
				{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.crop', params: { wat: 1 } },
				'E_INVALID_PARAM',
			],
			[
				{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.crop', params: { left: 'x' } },
				'E_INVALID_PARAM',
			],
			[{ type: 'effect.add', target: 'master', effectId: 'jasper.crop' }, 'E_INVALID_PARAM'],
			[{ type: 'effect.add', target: { trackId: 'A1' }, effectId: 'jasper.crop' }, 'E_INVALID_PARAM'],
			// Crop that leaves no pixels violates INV-012 → whole transaction refused.
			[
				{
					type: 'effect.add',
					target: { clipId: id },
					effectId: 'jasper.crop',
					params: { left: 60, right: 50 },
				},
				'E_INVARIANT',
			],
		];
		for (const [cmd, code] of cases) {
			const before = h.doc;
			const res = h.tx([cmd]);
			expect(res.ok, JSON.stringify(cmd)).toBe(false);
			if (!res.ok) expect(res.errors[0]!.code).toBe(code);
			expect(h.doc).toBe(before);
		}
	});

	it('validates animated param overrides (pasted/agent keyframes) field by field', () => {
		const { h, id } = withSolid();
		const F = 705_600_000 / 30;
		const blur = (keyframes: unknown) => ({
			type: 'effect.add',
			target: { clipId: id },
			effectId: 'jasper.gaussian-blur',
			params: { radius: { value: 5, keyframes } },
		});
		const k = (time: unknown, extra: Record<string, unknown> = {}) => ({ time, value: 4, ...extra });
		for (const bad of [
			[k(3.5)],
			[k(-F)],
			[k('0')],
			[k(0, { interpolation: 'weird' })],
			[k(0, { easeIn: 5 })],
			[k(0, { easeOut: { influence: 0, slope: 1 } })],
			[k(0), k(0)],
			'nope',
		]) {
			const before = h.doc;
			const res = h.tx([blur(bad)]);
			expect(res.ok, JSON.stringify(bad)).toBe(false);
			if (!res.ok) expect(res.errors[0]!.code).toBe('E_INVALID_PARAM');
			expect(h.doc).toBe(before);
		}
		h.ok([blur([k(10 * F, { junk: true }), k(0, { interpolation: 'auto-bezier' })])]);
		const radius = clipOf(h, id).effects[0]!.params.radius!;
		expect(radius.keyframes.map((x) => x.time)).toEqual([0, 10 * F]);
		expect(radius.keyframes[1]).not.toHaveProperty('junk');
		expect(radius.keyframes[1]!.easeIn).toEqual(EASE_PRESETS.linear);
		expect(radius.keyframes[0]!.interpolation).toBe('auto-bezier');
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('refuses video effects on audio clips and edits on locked tracks', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 5 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const audio = h.clips('A1')[0]!;
		const video = h.clips('V1')[0]!;
		const r = h.tx([{ type: 'effect.add', target: { clipId: audio.id }, effectId: 'jasper.crop' }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
		const fx = h.ok([{ type: 'effect.add', target: { clipId: video.id }, effectId: 'jasper.crop' }])
			.results[0] as {
			effectInstanceId: string;
		};
		h.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		for (const cmd of [
			{ type: 'effect.add', target: { clipId: video.id }, effectId: 'jasper.crop' },
			{ type: 'effect.remove', effectInstanceId: fx.effectInstanceId },
			{ type: 'effect.setEnabled', effectInstanceId: fx.effectInstanceId, enabled: false },
		]) {
			const res = h.tx([cmd]);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.errors[0]!.code).toBe('E_TRACK_LOCKED');
		}
	});

	it('removes, reorders and bypasses; reorder clamps the index', () => {
		const { h, id } = withSolid();
		const r = h.ok([
			{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.crop', ref: '$a' },
			{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.gaussian-blur', ref: '$b' },
			{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.flip-horizontal', ref: '$c' },
		]);
		const [a, b, c] = [r.refs.$a!, r.refs.$b!, r.refs.$c!];
		h.ok([{ type: 'effect.reorder', effectInstanceId: a, index: 99 }]);
		expect(clipOf(h, id).effects.map((e) => e.id)).toEqual([b, c, a]);
		h.ok([{ type: 'effect.reorder', effectInstanceId: a, index: 0 }]);
		expect(clipOf(h, id).effects.map((e) => e.id)).toEqual([a, b, c]);
		h.ok([{ type: 'effect.setEnabled', effectInstanceId: b, enabled: false }]);
		expect(clipOf(h, id).effects[1]!.enabled).toBe(false);
		h.ok([{ type: 'effect.remove', effectInstanceId: c }]);
		expect(clipOf(h, id).effects.map((e) => e.id)).toEqual([a, b]);
		const missing = h.tx([{ type: 'effect.remove', effectInstanceId: c }]);
		expect(!missing.ok && missing.errors[0]!.code).toBe('E_NOT_FOUND');
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('supports track and master targets with an audio effect registry', () => {
		const gain: EffectSpec = {
			id: 'test.gain',
			version: 1,
			label: 'Gain',
			category: 'Amplitude',
			appliesTo: 'audio',
			params: [
				{
					name: 'db',
					label: 'Gain',
					type: 'number',
					default: 0,
					range: { min: -24, max: 24 },
					unit: 'dB',
					animatable: true,
				},
			],
			preview: {},
			native: null,
			capabilities: { preview: 'webaudio', export: ['remotion'] },
		};
		const effects = createEffectRegistry([...defaultEffectRegistry.list(), gain]);
		const h = new Harness({ ctx: { registries: { ...defaultRegistries(), effects } } });
		const r = h.ok([
			{ type: 'effect.add', target: { trackId: 'A1' }, effectId: 'test.gain', params: { db: -6 }, ref: '$t' },
			{ type: 'effect.add', target: 'master', effectId: 'test.gain', ref: '$m' },
			{
				type: 'param.setAnimated',
				target: ['effect', '$m', 'db'],
				animated: true,
				at: { sequenceFrame: 30 },
			},
			{ type: 'keyframe.add', target: ['effect', '$m', 'db'], at: { sequenceFrame: 60 }, value: 6 },
		]);
		expect(h.seq.audioTracks[0]!.effects![0]!.params.db!.value).toBe(-6);
		const master = h.seq.master.effects[0]!;
		expect(master.id).toBe(r.refs.$m);
		const F = 705_600_000 / 30;
		expect(master.params.db!.keyframes.map((k) => [k.time, k.value])).toEqual([
			[30 * F, 0],
			[60 * F, 6],
		]);
		const vid = h.tx([{ type: 'effect.add', target: { trackId: 'V1' }, effectId: 'test.gain' }]);
		expect(vid.ok).toBe(false);
	});

	it('FX-022: unknown effects are preserved, reorderable, removable and not editable', () => {
		const { h, id } = withSolid();
		h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.crop' }]);
		const future = {
			id: 'fx_000000000000FUTR',
			effectId: 'jasper.hologram',
			effectVersion: 3,
			enabled: true,
			params: { glow: { value: 0.7, keyframes: [] } },
			extra: 'kept',
		};
		patchDoc(h, (doc) => {
			(Object.values(doc.sequences)[0]!.clips[id] as VClip).effects.push(future as never);
		});
		h.ok([{ type: 'effect.reorder', effectInstanceId: future.id, index: 0 }]);
		h.ok([{ type: 'effect.setEnabled', effectInstanceId: future.id, enabled: false }]);
		const kept = clipOf(h, id).effects[0] as EffectInstance & { extra?: string };
		expect(kept).toEqual({ ...future, enabled: false });
		const edit = h.tx([{ type: 'param.set', target: ['effect', future.id, 'glow'], value: 1 }]);
		expect(!edit.ok && edit.errors[0]!.code).toBe('E_UNKNOWN_EFFECT');
		h.ok([{ type: 'effect.remove', effectInstanceId: future.id }]);
		expect(clipOf(h, id).effects.map((e) => e.effectId)).toEqual(['jasper.crop']);
	});
});

describe('keyframes (S01 §12, S03 §12–13)', () => {
	it('AC-EC-1: stopwatch at frame 10 + value at frame 40 gives a linear ramp everywhere', () => {
		const { h, id } = withSolid();
		h.ok([
			{ type: 'param.set', target: ['clip', id, 'opacity'], value: 20 },
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'opacity'],
				animated: true,
				at: { sequenceFrame: 10 },
			},
		]);
		expect(clipOf(h, id).opacity.keyframes.map((k) => k.value)).toEqual([20]);
		h.ok([{ type: 'param.set', target: ['clip', id, 'opacity'], value: 80, at: { sequenceFrame: 40 } }]);
		const snapshot = buildRenderSnapshot(h.doc, h.seqId, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		const clip = clipOf(h, id);
		const ctx = { doc: h.doc, seq: h.seq, clip };
		for (const [frame, want] of [
			[0, 20],
			[10, 20],
			[25, 50],
			[40, 80],
			[99, 80],
		] as const) {
			expect(resolvePropertyAt(ctx, getPropertySpec('opacity')!, frame).value).toBeCloseTo(want, 9);
			expect(resolveSceneAt(snapshot, frame)[0]!.props.opacity).toBeCloseTo(want, 9);
		}
	});

	it('AC-EC-2 / AC-08: Ease Out, Ease In and Easy Ease match the Bézier table', () => {
		const { h, id } = withSolid(200);
		const r = h.ok([
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 0 }, value: 0, ref: '$a' },
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 100 }, value: 100, ref: '$b' },
		]);
		const [a, b] = [r.refs.$a!, r.refs.$b!];
		expect(opacityAt(h, id, 50)).toBeCloseTo(50, 9);
		const easy = { influence: 1 / 3, slope: 0 };
		h.ok([{ type: 'keyframe.setInterpolation', keyframeIds: [a], interpolation: 'bezier', easeOut: easy }]);
		// S01 KF-003 with keyframe-sides: zero outgoing slope into a Linear incoming side, which contributes After
		// Effects' linear ease (influence ⅙ at the average speed): the cubic (0,0) (⅓,0) (⅚,⅚) (1,1).
		expect(opacityAt(h, id, 50)).toBeCloseTo(36.29366604572753, 6);
		// Ease In on the second key (first key back to linear): mirror image — the Linear key no longer cancels it.
		h.ok([{ type: 'keyframe.setInterpolation', keyframeIds: [a], interpolation: 'linear' }]);
		h.ok([{ type: 'keyframe.setInterpolation', keyframeIds: [b], interpolation: 'bezier', easeIn: easy }]);
		expect(opacityAt(h, id, 50)).toBeCloseTo(63.70633395427247, 6);
		expect(clipOf(h, id).opacity.keyframes[0]!.interpolation).toBe('linear');
		// Easy Ease on both keys: symmetric, p(0.5) = 0.5, flat start (AC-08).
		h.ok([
			{
				type: 'keyframe.setInterpolation',
				keyframeIds: [a, b],
				interpolation: 'bezier',
				easeIn: easy,
				easeOut: easy,
			},
		]);
		expect(opacityAt(h, id, 50)).toBeCloseTo(50, 6);
		expect(opacityAt(h, id, 1)).toBeLessThan(1);
	});

	it('keyframe.add replaces at the same time, keyframe.update edits, keyframe.remove of the last key keeps its value', () => {
		const { h, id } = withSolid();
		const r = h.ok([
			{ type: 'keyframe.add', target: ['clip', id, 'transform', 'scale'], at: { frames: 5 }, ref: '$k' },
		]);
		const k = r.refs.$k!;
		const scale = () => clipOf(h, id).transform.scale;
		expect(scale().keyframes).toEqual([
			expect.objectContaining({ id: k, value: 100, interpolation: 'linear' }),
		]);
		const again = h.ok([
			{ type: 'keyframe.add', target: ['clip', id, 'transform', 'scale'], at: { frames: 5 }, value: 150 },
		]);
		expect((again.results[0] as { keyframeId: string }).keyframeId).toBe(k);
		expect(scale().keyframes).toHaveLength(1);
		h.ok([{ type: 'keyframe.update', keyframeId: k, value: 175, interpolation: 'hold' }]);
		expect(scale().keyframes[0]).toMatchObject({ value: 175, interpolation: 'hold' });
		const bad = h.tx([{ type: 'keyframe.update', keyframeId: k, value: [1, 2] }]);
		expect(!bad.ok && bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		h.ok([{ type: 'keyframe.remove', keyframeIds: [k] }]);
		expect(scale()).toEqual({ value: 175, keyframes: [] });
		const gone = h.tx([{ type: 'keyframe.remove', keyframeIds: [k] }]);
		expect(!gone.ok && gone.errors[0]!.code).toBe('E_NOT_FOUND');
	});

	it('keyframe.move shifts by whole frames, replaces a key it lands on and refuses negative times', () => {
		const { h, id } = withSolid();
		const r = h.ok([
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 0 }, value: 0, ref: '$a' },
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 10 }, value: 50, ref: '$b' },
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 20 }, value: 100, ref: '$c' },
		]);
		const F = 705_600_000 / 30;
		h.ok([{ type: 'keyframe.move', keyframeIds: [r.refs.$b!], delta: { frames: 5 } }]);
		expect(clipOf(h, id).opacity.keyframes.map((k) => k.time / F)).toEqual([0, 15, 20]);
		h.ok([{ type: 'keyframe.move', keyframeIds: [r.refs.$b!], delta: { frames: 5 } }]);
		const keys = clipOf(h, id).opacity.keyframes;
		expect(keys.map((k) => [k.id, k.time / F, k.value])).toEqual([
			[r.refs.$a, 0, 0],
			[r.refs.$b, 20, 50],
		]);
		// Agents may pass flicks; they are snapped to the frame grid (S01:KF-005).
		h.ok([{ type: 'keyframe.move', keyframeIds: [r.refs.$a!], delta: { flicks: Math.round(F * 2.4) } }]);
		expect(clipOf(h, id).opacity.keyframes[0]!.time).toBe(2 * F);
		const neg = h.tx([{ type: 'keyframe.move', keyframeIds: [r.refs.$a!], delta: { frames: -10 } }]);
		expect(!neg.ok && neg.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('auto-bezier updates after a neighbour moves and preserves its curve when changed to bezier', () => {
		const { h, id } = withSolid();
		const r = h.ok([
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 0 }, value: 0, ref: '$a' },
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 10 }, value: 50, ref: '$b' },
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 30 }, value: 100, ref: '$c' },
			{
				type: 'keyframe.setInterpolation',
				keyframeIds: ['$a', '$b', '$c'],
				interpolation: 'auto-bezier',
			},
		]);
		expect(opacityAt(h, id, 20)).toBeCloseTo(250 / 3, 6);
		h.ok([{ type: 'keyframe.move', keyframeIds: [r.refs.$c!], delta: { frames: 10 } }]);
		expect(opacityAt(h, id, 25)).toBeCloseTo(84.375, 6);
		const frames = [5, 15, 25, 35];
		const autoCurve = frames.map((frame) => opacityAt(h, id, frame));
		const keyframeIds = [r.refs.$a!, r.refs.$b!, r.refs.$c!];
		h.ok([{ type: 'keyframe.setInterpolation', keyframeIds, interpolation: 'bezier' }]);
		for (const [i, frame] of frames.entries()) expect(opacityAt(h, id, frame)).toBeCloseTo(autoCurve[i]!, 6);
		h.ok([{ type: 'keyframe.setInterpolation', keyframeIds, interpolation: 'auto-bezier' }]);
		// Local maximum → slope 0 (no overshoot, AC-08).
		h.ok([{ type: 'keyframe.update', keyframeId: r.refs.$c!, value: 0 }]);
		for (let f = 0; f <= 40; f++) expect(opacityAt(h, id, f)).toBeLessThanOrEqual(50 + 1e-9);
	});

	it('continuous bezier keeps equal velocity on both sides of a key', () => {
		const { h, id } = withSolid();
		h.ok([
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 0 }, value: 0, ref: '$a' },
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 10 }, value: 50, ref: '$b' },
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 30 }, value: 100, ref: '$c' },
			{
				type: 'keyframe.setInterpolation',
				keyframeIds: ['$b'],
				interpolation: 'continuous-bezier',
				easeOut: { influence: 0.5, slope: 2 },
			},
		]);
		const hFrame = 0.001;
		const incoming = (opacityAt(h, id, 10) - opacityAt(h, id, 10 - hFrame)) / hFrame;
		const outgoing = (opacityAt(h, id, 10 + hFrame) - opacityAt(h, id, 10)) / hFrame;
		expect(incoming).toBeCloseTo(outgoing, 2);
		expect(incoming).toBeCloseTo(5, 2);
	});

	it('AC-EC-3 / AC-06: splitting eased position animation keeps motion identical (≤ 0.001 px)', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10, audio: false });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const id = h.clips('V1')[0]!.id;
		h.ok([
			{
				type: 'keyframe.add',
				target: ['clip', id, 'transform', 'position'],
				at: { frames: 20 },
				value: [100, 200],
				ref: '$a',
			},
			{
				type: 'keyframe.add',
				target: ['clip', id, 'transform', 'position'],
				at: { frames: 200 },
				value: [1700, 900],
				ref: '$b',
			},
			{
				type: 'keyframe.add',
				target: ['clip', id, 'transform', 'position'],
				at: { frames: 260 },
				value: [900, 500],
				ref: '$c',
			},
			{
				type: 'keyframe.setInterpolation',
				keyframeIds: ['$a', '$b'],
				interpolation: 'bezier',
				easeIn: { influence: 0.5, slope: 0 },
				easeOut: { influence: 0.4, slope: 0 },
			},
			{ type: 'keyframe.setInterpolation', keyframeIds: ['$c'], interpolation: 'auto-bezier' },
		]);
		const rate = rateOf(h);
		const posAt = (frame: number) => {
			const c = h.clips('V1').find((x) => x.start <= frame && frame < x.start + x.duration) as Extract<
				Clip,
				{ kind: 'video' }
			>;
			return evaluate(c.transform.position, contentTimeAt(c, frame, rate));
		};
		const before = Array.from({ length: 300 }, (_, f) => posAt(f));
		h.ok([{ type: 'clip.split', at: 120, clipIds: [id] }]);
		const [left, right] = h.clips('V1') as Extract<Clip, { kind: 'video' }>[];
		expect(right!.transform.position.keyframes).toHaveLength(3);
		expect(right!.transform.position.keyframes[0]!.id).not.toBe(left!.transform.position.keyframes[0]!.id);
		const err = (f: number) => Math.hypot(posAt(f)[0] - before[f]![0], posAt(f)[1] - before[f]![1]);
		for (let f = 0; f < 300; f++) expect(err(f)).toBeLessThanOrEqual(0.001);
		// S01 AC-06: trimming the right part's head keeps the remaining frames identical.
		h.ok([{ type: 'clip.trim', clipId: right!.id, edge: 'in', deltaFrames: 10 }]);
		for (let f = 0; f < 300; f++) if (f < 120 || f >= 130) expect(err(f)).toBeLessThanOrEqual(0.001);
	});

	it('keyframes.prune removes keys that cannot affect the visible range (S01:KF-006)', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10, audio: false });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const id = h.clips('V1')[0]!.id;
		const add = (frames: number, value: number, interpolation = 'linear') => ({
			type: 'keyframe.add',
			target: ['clip', id, 'opacity'],
			at: { frames },
			value,
			interpolation,
		});
		h.ok([
			add(0, 0),
			add(20, 40),
			add(50, 10, 'auto-bezier'),
			add(80, 90, 'auto-bezier'),
			add(150, 30),
			add(250, 70),
			add(290, 100),
			{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.gaussian-blur', ref: '$fx' },
			{ type: 'keyframe.add', target: ['effect', '$fx', 'radius'], at: { frames: 5 }, value: 0 },
			{ type: 'keyframe.add', target: ['effect', '$fx', 'radius'], at: { frames: 280 }, value: 50 },
		]);
		// Visible range becomes frames 60…199 of the source after two regular trims.
		h.ok([{ type: 'clip.trim', clipId: id, edge: 'in', deltaFrames: 60 }]);
		h.ok([{ type: 'clip.trim', clipId: id, edge: 'out', deltaFrames: -100 }]);
		const clip = () => h.clips('V1')[0] as Extract<Clip, { kind: 'video' }>;
		const rate = rateOf(h);
		const sample = () =>
			Array.from({ length: clip().duration }, (_, i) => {
				const t = contentTimeAt(clip(), clip().start + i, rate);
				return [
					evaluate(clip().opacity, t),
					evaluate(clip().effects[0]!.params.radius as Animatable<number>, t),
				];
			});
		const before = sample();
		const res = h.ok([{ type: 'keyframes.prune', clipId: id }]);
		const F = 705_600_000 / 30;
		// Keep 20 for the auto-bezier slope at 50, and 250 to interpolate through the visible end.
		expect(clip().opacity.keyframes.map((k) => k.time / F)).toEqual([20, 50, 80, 150, 250]);
		expect(clip().effects[0]!.params.radius!.keyframes).toHaveLength(2);
		expect((res.results[0] as { removed: number }).removed).toBe(2);
		const after = sample();
		after.forEach((v, i) => {
			expect(v[0]).toBeCloseTo(before[i]![0]!, 9);
			expect(v[1]).toBeCloseTo(before[i]![1]!, 9);
		});
	});

	it('keyframe commands on track and master parameters use sequence time', () => {
		const h = new Harness();
		const F = 705_600_000 / 30;
		const r = h.ok([
			{
				type: 'keyframe.add',
				target: ['track', 'A1', 'volumeDb'],
				at: { sequenceFrame: 12 },
				value: -6,
				ref: '$t',
			},
			{
				type: 'keyframe.add',
				target: ['master', 'volumeDb'],
				at: { sequenceFrame: 3 },
				value: -3,
				ref: '$m',
			},
		]);
		expect(h.seq.audioTracks[0]!.volumeDb!.keyframes[0]!.time).toBe(12 * F);
		h.ok([{ type: 'keyframe.move', keyframeIds: [r.refs.$t!, r.refs.$m!], delta: { frames: 2 } }]);
		expect(h.seq.audioTracks[0]!.volumeDb!.keyframes[0]!.time).toBe(14 * F);
		expect(h.seq.master.volumeDb.keyframes[0]!.time).toBe(5 * F);
	});

	it('keyframe edits on a locked track are refused atomically', () => {
		const { h, id } = withSolid();
		const r = h.ok([
			{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 0 }, value: 0, ref: '$a' },
		]);
		h.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		const before = h.doc;
		for (const cmd of [
			{ type: 'keyframe.remove', keyframeIds: [r.refs.$a!] },
			{ type: 'keyframe.move', keyframeIds: [r.refs.$a!], delta: { frames: 1 } },
			{ type: 'keyframe.setInterpolation', keyframeIds: [r.refs.$a!], interpolation: 'hold' },
		]) {
			const res = h.tx([cmd]);
			expect(!res.ok && res.errors[0]!.code, cmd.type).toBe('E_TRACK_LOCKED');
		}
		expect(h.doc).toBe(before);
	});
});

describe('effect registry (S03 §15.4, FX-040)', () => {
	const ctx = { width: 1920, height: 1080, fps: 30 };

	it('maps crop, directional blur and flips to the native FFmpeg protocol', () => {
		const native = (id: string, params: Record<string, unknown>) =>
			defaultEffectRegistry.get(id)!.native!.filter(params as never, ctx);
		expect(native('jasper.crop', { left: 10, top: 5, right: 0, bottom: 12.5 })).toBe(
			'crop=1728:891:192:54,pad=1920:1080:192:54:color=black@0',
		);
		expect(native('jasper.gaussian-blur', { radius: 7.5 })).toBe('gblur=sigma=7.5:sigmaV=7.5');
		expect(native('jasper.gaussian-blur', { radius: 4, dimensions: 'vertical' })).toBe(
			'gblur=sigma=0:sigmaV=4',
		);
		expect(native('jasper.gaussian-blur', { radius: 0 })).toBe('null');
		expect(native('jasper.flip-horizontal', {})).toBe('hflip');
		expect(native('jasper.flip-vertical', {})).toBe('vflip');
	});

	it('brightness/contrast preview transfer equals the canonical formula', () => {
		for (const [b, c] of [
			[0, 0],
			[37, -12],
			[-80, 90],
		]) {
			const m = /slope="([^"]+)" intercept="([^"]+)"/.exec(
				BRIGHTNESS_CONTRAST_EFFECT.preview.svgFilter!({ brightness: b!, contrast: c! }, 'x'),
			)!;
			for (const x of [0, 0.25, 0.5, 1]) {
				const want = (1 + c! / 100) * (x - 0.5) + 0.5 + b! / 200;
				expect(Number(m[1]) * x + Number(m[2])).toBeCloseTo(want, 3);
			}
		}
	});
});

describe('property registry (S03:PRP-001…003 adapted)', () => {
	it('exports a JSON Schema per clip including applied effect params', () => {
		const { h, id } = withSolid();
		h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.crop', ref: '$c' }]);
		const clip = clipOf(h, id);
		const schema = clipPropertiesJsonSchema(clip, { effects: defaultEffectRegistry }) as {
			properties: Record<string, Record<string, unknown>>;
		};
		expect(schema.properties.opacity).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
		expect(schema.properties['transform.position']).toMatchObject({ type: 'array', minItems: 2 });
		expect(schema.properties['solid.color']).toMatchObject({ type: 'array', minItems: 4 });
		expect(schema.properties[`effects.${clip.effects[0]!.id}.left`]).toMatchObject({
			type: 'number',
			maximum: 100,
			'x-unit': '%',
		});
		expect(schema.properties.volumeDb).toBeUndefined();
	});

	it('generates motion-graphic params.* specs from the template schema with defaults', () => {
		const tpl = {
			id: 'lower-third',
			version: 1,
			name: 'Lower third',
			category: 'Titles',
			paramsSchema: z.object({
				title: z.string().max(80).describe('Main line'),
				size: z.number().int().min(10).max(200),
				accent: z.tuple([z.number(), z.number(), z.number(), z.number()]),
				align: z.enum(['left', 'right']),
				showBar: z.boolean(),
			}),
			defaults: { title: 'Name', size: 48, accent: [1, 0.5, 0, 1], align: 'left', showBar: true },
			introFrames: 15,
			outroFrames: 15,
			canvasDefault: 'sequence' as const,
		};
		const specs = paramsPropertySpecs(tpl);
		const by = Object.fromEntries(specs.map((s) => [s.key, s]));
		expect(by['params.title']).toMatchObject({ kind: 'string', label: 'Title', description: 'Main line' });
		expect(by['params.size']).toMatchObject({ kind: 'number', range: { min: 10, max: 200, step: 1 } });
		expect(by['params.accent']!.kind).toBe('color');
		expect(by['params.align']).toMatchObject({ kind: 'enum', options: ['left', 'right'] });
		expect(by['params.showBar']!.ui.control).toBe('toggle');
		expect(by['params.size']!.defaultValue).toBe(48);
		const h = new Harness({
			ctx: { registries: defaultRegistries(createStaticMgRegistry([tpl])) },
		});
		const r = h.ok([
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 90,
				track: 'V2',
				template: { id: 'lower-third', version: 1 },
				params: tpl.defaults,
				ref: '$mg',
			},
		]);
		h.ok([{ type: 'param.set', target: ['clip', r.refs.$mg!, 'params', 'size'], value: 64 }]);
		expect((h.seq.clips[r.refs.$mg!] as Extract<Clip, { kind: 'motion-graphic' }>).params.size).toBe(64);
	});

	it('resolves values at the playhead, computes reset values and picks the write command', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 4, width: 1280, height: 720, audio: false });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 10 }]);
		const clip = h.clips('V1')[0]!;
		h.ok([
			{ type: 'keyframe.add', target: ['clip', clip.id, 'opacity'], at: { frames: 0 }, value: 0 },
			{ type: 'keyframe.add', target: ['clip', clip.id, 'opacity'], at: { frames: 10 }, value: 100 },
		]);
		const c = h.clips('V1')[0]!;
		const ctx = { doc: h.doc, seq: h.seq, clip: c };
		const op = getPropertySpec('opacity')!;
		expect(resolvePropertyAt(ctx, op, 15)).toMatchObject({ value: 50, animated: true, outside: false });
		expect(resolvePropertyAt(ctx, op, 0)).toMatchObject({ value: 0, outside: true });
		expect(propertyDefault(ctx, getPropertySpec('transform.anchor')!)).toEqual([640, 360]);
		expect(propertyDefault(ctx, getPropertySpec('transform.position')!)).toEqual([960, 540]);

		const rate = rateOf(h);
		const t = clipContentTimeAtFrame(c, 25, rate).time;
		expect(sequenceFrameOfContentTime(c, t, rate)).toBe(25);
		const text = h.ok([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'Hi' }, ref: '$t' },
		]);
		const tc = h.seq.clips[text.refs.$t!]!;
		const cmd = propertyWriteCommand(tc, getPropertySpec('text.strokeWidth')!, 6);
		h.ok([cmd, propertyWriteCommand(tc, getPropertySpec('text.sizePx')!, 64)]);
		const style = (h.seq.clips[tc.id] as Extract<Clip, { kind: 'text' }>).content.style;
		expect(style.strokes).toEqual([{ color: [0, 0, 0, 1], widthPx: 6, position: 'outside' }]);
		expect(style.sizePx).toBe(64);
	});

	it('effect param specs map to ParamPaths the handlers accept', () => {
		const { h, id } = withSolid();
		const r = h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.crop', ref: '$c' }]);
		const specs = effectPropertySpecs({ id: r.refs.$c! }, CROP_EFFECT);

		const clip = clipOf(h, id);
		h.ok([propertyWriteCommand(clip, specs[0]!, 25)]);
		expect(clipOf(h, id).effects[0]!.params.left!.value).toBe(25);
		const ctx = { doc: h.doc, seq: h.seq, clip: clipOf(h, id) };
		expect(resolvePropertyAt(ctx, specs[0]!, 0).value).toBe(25);
	});
});
