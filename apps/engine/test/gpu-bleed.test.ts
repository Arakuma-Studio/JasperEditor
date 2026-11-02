// Spec 19 TL-122 (TL-033): `contentBleed` honours `gpu.padding`. It returned null (full-frame bake) for every GPU effect
// except Gaussian Blur; a moving glow baked the whole frame. Regression tests: the span ones failed before the fix.
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultEffectRegistry,
	defaultRegistries,
	type EffectRegistry,
	gpuPadding,
	type RenderVisualClip,
	textContentPad,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { contentBleed, cropRect, MAX_PADDING_FRAMES } from '../src/layer-bake/layer.ts';

const SEQ = { width: 1920, height: 1080, fps: { num: 30, den: 1 } };
const GLOW = 'jasper.s.glow';

/** A 90-frame title on V1 with `extra` commands after it ('$t' is the title). */
function title(extra: Command[] = []): RenderVisualClip {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'bleed', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const { document, result } = applyTransaction(
		doc,
		{
			label: 'bleed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'clip.addText',
					at: 0,
					duration: 90,
					track: 'V1',
					content: { text: 'Title', style: { sizePx: 100 } },
					transform: { position: [960, 540] },
					ref: '$t',
				} as unknown as Command,
				...extra,
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	const snap = buildRenderSnapshot(document, seqId, { resolveMedia: () => null, resolveFont: () => null });
	return snap.videoTracks.flatMap((t) => t.clips).find((c) => c.kind === 'text')!;
}

const addGlow = (params: Record<string, unknown> = {}): Command =>
	({ type: 'effect.add', target: { clipId: '$t' }, effectId: GLOW, params }) as unknown as Command;

/** The paint the title itself reaches beyond its box. */
function textPad(c: RenderVisualClip): number {
	if (!('text' in c.source)) throw new Error('not a text clip');
	return textContentPad(c.source.text);
}

/** The glow's own padding (largest side) at the given width, as the effect canvas planner computes it. */
function glowPad(c: RenderVisualClip, glowWidth: number): number {
	const spec = defaultEffectRegistry.get(GLOW)!;
	const defaults = Object.fromEntries(spec.params.map((p) => [p.name, p.default]));
	const p = gpuPadding(
		spec,
		{ ...defaults, glowWidth },
		{ width: c.intrinsicBox.width, height: c.intrinsicBox.height, pxScale: 1, fps: 30 },
	);
	return Math.max(p.left, p.top, p.right, p.bottom);
}

/** `c` with the glow width keyed (snapshot clips are frozen): keys are in content time (flicks). */
function withWidthKeys(c: RenderVisualClip, keys: { time: number; value: number }[]): RenderVisualClip {
	const keyframes = keys.map((k, i) => ({ id: `kf_${i}`, interpolation: 'linear', ...k }));
	return {
		...c,
		effects: c.effects.map((fx) => ({
			...fx,
			params: { ...fx.params, glowWidth: { ...fx.params.glowWidth!, keyframes } },
		})),
	} as unknown as RenderVisualClip;
}

describe('contentBleed with Warp Text (spec 19 TL-110)', () => {
	const SPAN = { f0: 0, f1: 90, fps: SEQ.fps };
	const warp = (extra: Command[] = []) =>
		title([
			{
				type: 'effect.add',
				target: { clipId: '$t' },
				effectId: 'jasper.warp-text',
				params: { style: 'arc', bend: 80 },
				ref: '$w',
			} as Command,
			...extra,
		]);

	it('adds what the warp reaches, and keeps the bake cropped', () => {
		const c = warp();
		const text = textContentPad((c.source as { text: never }).text);
		const bleed = contentBleed(c, defaultEffectRegistry, SPAN);
		expect(bleed).not.toBeNull();
		expect(bleed!).toBeGreaterThan(text + 10);
		expect(cropRect(c, { f0: 0, f1: 90 }, SEQ)).not.toBeNull();
	});

	it('takes the largest bend of a keyed warp', () => {
		const still = contentBleed(warp(), defaultEffectRegistry, SPAN)!;
		const keyed = contentBleed(
			warp([
				{ type: 'keyframe.add', target: ['effect', '$w', 'bend'], at: { frames: 0 }, value: 10 } as Command,
				{ type: 'keyframe.add', target: ['effect', '$w', 'bend'], at: { frames: 89 }, value: 100 } as Command,
			]),
			defaultEffectRegistry,
			SPAN,
		)!;
		expect(keyed).toBeGreaterThan(still);
	});

	it('a warp after a glow reaches past what the glow alone asks for', () => {
		const glow = {
			type: 'effect.add',
			target: { clipId: '$t' },
			effectId: GLOW,
		} as Command;
		const alone = contentBleed(title([glow]), defaultEffectRegistry, SPAN)!;
		const both = contentBleed(
			title([
				glow,
				{
					type: 'effect.add',
					target: { clipId: '$t' },
					effectId: 'jasper.warp-text',
					params: { style: 'bulge', bend: 100 },
				} as Command,
			]),
			defaultEffectRegistry,
			SPAN,
		)!;
		expect(both).toBeGreaterThan(alone);
	});
});

describe('contentBleed with GPU effects (TL-122)', () => {
	it('adds the effect’s gpu.padding to the text paint when the frames are known', () => {
		const c = title([addGlow({ glowWidth: 0.4 })]);
		const text = textPad(c);
		const pad = glowPad(c, 0.4);
		expect(pad).toBeGreaterThan(20);
		const bleed = contentBleed(c, defaultEffectRegistry, { f0: 0, f1: 90, fps: SEQ.fps });
		expect(bleed).not.toBeNull();
		expect(bleed!).toBeCloseTo(text + pad, 5);
	});

	it('keeps the conservative null when the frames are not known', () => {
		const c = title([addGlow()]);
		expect(contentBleed(c)).toBeNull();
	});

	it('follows an animated width: the largest padding over the clip’s frames', () => {
		// a width of 0.1 at frame 0 growing to 0.6 at frame 60 (keys are in content time, flicks).
		const c = withWidthKeys(title([addGlow({ glowWidth: 0.1 })]), [
			{ time: 0, value: 0.1 },
			{ time: 60 * (705_600_000 / 30), value: 0.6 },
		]);
		const text = textPad(c);
		const full = contentBleed(c, defaultEffectRegistry, { f0: 0, f1: 90, fps: SEQ.fps })!;
		const early = contentBleed(c, defaultEffectRegistry, { f0: 0, f1: 1, fps: SEQ.fps })!;
		expect(early).toBeCloseTo(text + glowPad(c, 0.1), 3);
		expect(full).toBeGreaterThanOrEqual(text + glowPad(c, 0.6) - 1e-6);
		expect(full).toBeGreaterThan(early);
	});

	it('cropRect crops the bake around the title and its glow instead of rendering the full frame', () => {
		const plain = title();
		const c = title([addGlow({ glowWidth: 0.4 })]);
		const rect = cropRect(c, { f0: 0, f1: 90 }, SEQ);
		expect(rect).not.toBeNull();
		const base = cropRect(plain, { f0: 0, f1: 90 }, SEQ);
		expect(base).not.toBeNull();
		// the glow widens the crop and nothing else did.
		expect(rect!.w).toBeGreaterThan(base!.w);
		expect(rect!.w).toBeLessThan(SEQ.width + 1);
	});

	it('an effect with no GPU realisation, or a padding hook that throws, still means "unknown"', () => {
		const c = title([addGlow()]);
		const broken = {
			get: () => ({
				...defaultEffectRegistry.get(GLOW)!,
				gpu: {
					...defaultEffectRegistry.get(GLOW)!.gpu!,
					padding: () => {
						throw new Error('boom');
					},
				},
			}),
			list: () => [],
		} as unknown as EffectRegistry;
		expect(contentBleed(c, broken, { f0: 0, f1: 90, fps: SEQ.fps })).toBeNull();
		const noGpu = {
			get: () => ({ ...defaultEffectRegistry.get(GLOW)!, gpu: undefined }),
			list: () => [],
		} as unknown as EffectRegistry;
		expect(contentBleed(c, noGpu, { f0: 0, f1: 90, fps: SEQ.fps })).toBeNull();
	});

	it('a longer animated span than MAX_PADDING_FRAMES keeps the full-frame bake', () => {
		const c = withWidthKeys(title([addGlow()]), [
			{ time: 0, value: 0.1 },
			{ time: 1_000_000, value: 0.2 },
		]);
		expect(
			contentBleed(c, defaultEffectRegistry, { f0: 0, f1: MAX_PADDING_FRAMES + 1, fps: SEQ.fps }),
		).toBeNull();
	});

	it('an effect without a padding hook adds nothing', () => {
		const spec = defaultEffectRegistry
			.list()
			.find((s) => s.gpu && !s.gpu.padding && s.appliesTo === 'video' && !s.color);
		expect(spec).toBeDefined();
		const c = title([
			{ type: 'effect.add', target: { clipId: '$t' }, effectId: spec!.id } as unknown as Command,
		]);
		const text = textPad(c);
		expect(contentBleed(c, defaultEffectRegistry, { f0: 0, f1: 90, fps: SEQ.fps })).toBeCloseTo(text, 5);
	});
});
