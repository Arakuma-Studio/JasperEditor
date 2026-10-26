// spec 13 SH-004 / AS-070: the layer bake of a measured, unanimated title is cropped to its box grown by the glyph
// ink, stroke and shadow extents — not the 10 %-of-height bleed (textperf: 1080×760 for a 130 px caption).
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type RenderVisualClip,
	type TextMeasurer,
	textPaintExtent,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { contentBleed, cropRect, textInkPad, tightTextCrop } from '../src/layer-bake/layer.ts';

/** The textperf caption: 130 px, 30 px outside stroke, shadow distance 12 / blur 8, on a 1080 × 1920 short. */
const STYLE = {
	sizePx: 130,
	weight: 800,
	strokes: [{ color: [0.6, 0, 0.9, 1], widthPx: 30, position: 'outside' }],
	shadow: { color: [0, 0, 0, 0.8], angleDeg: 90, distancePx: 12, blurPx: 8 },
};
/** A measurer that lays the line out at 0.6 em per character (what the browser measures, in shape). */
const measurer: TextMeasurer = {
	measure: (c, box) => ({
		width: box.autoSize === 'width' ? Math.ceil(c.text.length * c.style.sizePx * 0.6) : box.width,
		height: Math.ceil(c.style.sizePx * c.style.lineHeight),
	}),
};

function caption(o: { measured: boolean; extra?: Command[] }): RenderVisualClip {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'crop', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const { document, result } = applyTransaction(
		doc,
		{
			label: 'crop',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'sequence.updateSettings',
					sequenceId: seqId,
					settings: { width: 1080, height: 1920 },
				} as Command,
				{
					type: 'clip.addText',
					at: 0,
					duration: 30,
					track: 'V1',
					content: { text: 'Hola amigos', style: STYLE },
					transform: { position: [540, 1500] },
					ref: '$t',
				} as unknown as Command,
				...(o.extra ?? []),
			],
		},
		{
			ids,
			now: () => 't',
			revision: 0,
			registries: defaultRegistries(),
			...(o.measured ? { textMeasurer: measurer } : {}),
		},
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	const snap = buildRenderSnapshot(document, seqId, { resolveMedia: () => null, resolveFont: () => null });
	return snap.videoTracks.flatMap((t) => t.clips).find((c) => c.kind === 'text')!;
}

const SEQ = { width: 1080, height: 1920, fps: { num: 30, den: 1 } };

describe('text bake crop (spec 13 SH-004)', () => {
	it('a measured static caption is cropped to box + ink + stroke + shadow: ≈ 2.3× fewer pixels than before', () => {
		const c = caption({ measured: true });
		expect(tightTextCrop(c)).toBe(true);
		const box = c.intrinsicBox;
		expect(box).toMatchObject({ width: 858, height: 156 });
		// paint: max(30, 12 + 30 + 0 + 3 × 4) = 54; ink: ceil(130 × (0.35 + 0.025)) + 2 = 51
		expect(textPaintExtent(STYLE as never)).toBe(54);
		expect(textInkPad({ sizePx: 130, lineHeight: 1.2 })).toBe(51);
		expect(contentBleed(c)).toBe(105);
		const rect = cropRect(c, { f0: 0, f1: 30 }, SEQ)!;
		// height: 156 + 2 × 105 + 2 × 2 (anti-aliasing) = 370 → even-aligned
		expect(rect.h).toBeLessThanOrEqual(372);
		expect(rect.h).toBeGreaterThanOrEqual(370);
		expect(rect.w).toBe(1072); // 858 + 2 × 105 + 2 × 2
		const pending = caption({ measured: false });
		expect(tightTextCrop(pending)).toBe(false);
		const old = cropRect(pending, { f0: 0, f1: 30 }, SEQ)!;
		// the estimated box keeps the 10 % frame bleed (192 px per side), as before
		expect(old.h).toBeGreaterThanOrEqual(156 + 2 * 192);
		expect((old.w * old.h) / (rect.w * rect.h)).toBeGreaterThan(1.9);
	});

	it('animated text, animators and a fixed box keep the frame bleed (their glyphs may move or overflow)', () => {
		const anim = caption({
			measured: true,
			extra: [
				{
					type: 'clip.update',
					clipIds: ['$t'],
					patch: { textAnimation: { in: { preset: 'fade', durationFrames: 10 } } },
				} as Command,
			],
		});
		expect(tightTextCrop(anim)).toBe(false);
		const fixed = caption({
			measured: true,
			extra: [{ type: 'clip.update', clipIds: ['$t'], patch: { box: { autoSize: 'none' } } } as Command],
		});
		expect(tightTextCrop(fixed)).toBe(false);
	});

	it('the shadow spread and blur widen the crop (3 σ of the Gaussian, σ = blur / 2)', () => {
		const c = caption({
			measured: true,
			extra: [
				{
					type: 'clip.update',
					clipIds: ['$t'],
					patch: {
						content: {
							style: {
								sizePx: 98,
								strokes: [{ color: [0.68, 0, 1, 1], widthPx: 11.5, position: 'outside' }],
								shadow: {
									color: [0.13, 0.11, 0.35, 0.8],
									angleDeg: 90,
									distancePx: 0,
									blurPx: 250,
									spreadPx: 26.87,
								},
							},
						},
					},
				} as Command,
			],
		});
		// 0 + 11.5 + 26.87 + 3 × 125 = 413.37 (the user's subtitle look: a very soft shadow reaches far)
		expect(contentBleed(c)).toBeCloseTo(413.37 + textInkPad({ sizePx: 98, lineHeight: 1.2 }), 5);
	});
});
