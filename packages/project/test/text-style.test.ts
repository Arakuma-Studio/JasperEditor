// spec 13 SH-004: text paint geometry (strokes, shadow spread), its invariants and repair, and the text measurer
// contract of the commands (layoutText, text.relayout).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Clip,
	checkInvariants,
	drawnStrokes,
	loadProject,
	MAX_SHADOW_SPREAD_PX,
	MAX_TEXT_STROKES,
	repairDocument,
	repairTextStyle,
	resolveTextShadow,
	strokeOuterPx,
	type TextMeasurer,
	textPaintExtent,
	textStrokeExtent,
	textStyleIssues,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;
const red = [1, 0, 0, 1] as [number, number, number, number];

describe('paint geometry', () => {
	it('draws every readable stroke with a positive width, in list order, at most MAX_TEXT_STROKES', () => {
		const strokes = [
			{ color: red, widthPx: 4, position: 'outside' },
			{ color: red, widthPx: 0, position: 'outside' },
			{ color: red, widthPx: 6, position: 'inside' },
			{ color: [1, 0, 0] as never, widthPx: 3, position: 'center' },
			{ color: red, widthPx: Number.NaN, position: 'center' },
			{ color: red, widthPx: 8, position: 'diagonal' as never },
			{ color: red, widthPx: 10, position: 'center' },
		];
		expect(drawnStrokes({ strokes } as never).map((s) => [s.slot, s.widthPx, s.position])).toEqual([
			[0, 4, 'outside'],
			[2, 6, 'inside'],
			[6, 10, 'center'],
		]);
		const many = Array.from({ length: 20 }, () => ({ color: red, widthPx: 1, position: 'outside' as const }));
		expect(drawnStrokes({ strokes: many })).toHaveLength(MAX_TEXT_STROKES);
	});

	it('outer extents: outside w, centre w / 2, inside 0; the shadow adds offset + spread + 3 σ', () => {
		expect(strokeOuterPx({ widthPx: 10, position: 'outside' })).toBe(10);
		expect(strokeOuterPx({ widthPx: 10, position: 'center' })).toBe(5);
		expect(strokeOuterPx({ widthPx: 10, position: 'inside' })).toBe(0);
		const s = {
			strokes: [
				{ color: red, widthPx: 4, position: 'outside' as const },
				{ color: red, widthPx: 20, position: 'center' as const },
			],
			shadow: { color: red, angleDeg: 0, distancePx: 3, blurPx: 10, spreadPx: 7 },
		};
		expect(textStrokeExtent(s)).toBe(10);
		// 3 (offset) + 10 (strokes) + 7 (spread) + 3 × 5 (σ = blur / 2)
		expect(textPaintExtent(s)).toBe(35);
		expect(textPaintExtent({ strokes: [], shadow: null })).toBe(0);
	});

	it('resolves the shadow: angle 0 = right, 90 = down, σ = blur / 2, spread clamped, transparent = none', () => {
		const sh = resolveTextShadow({ color: [0, 0, 0, 0.8], angleDeg: 90, distancePx: 10, blurPx: 250, spreadPx: 26.87 });
		expect(sh).toMatchObject({ dx: 0, dy: 10, sigma: 125, spreadPx: 26.87, color: [0, 0, 0, 0.8] });
		expect(resolveTextShadow({ color: red, angleDeg: 0, distancePx: 5, blurPx: 0 })).toMatchObject({ dx: 5, dy: 0, spreadPx: 0 });
		expect(resolveTextShadow({ color: red, angleDeg: 0, distancePx: 0, blurPx: 0, spreadPx: -4 })!.spreadPx).toBe(0);
		expect(resolveTextShadow({ color: red, angleDeg: 0, distancePx: 0, blurPx: 0, spreadPx: 1e9 })!.spreadPx).toBe(MAX_SHADOW_SPREAD_PX);
		expect(resolveTextShadow({ color: [0, 0, 0, 0], angleDeg: 0, distancePx: 0, blurPx: 0 })).toBeNull();
		expect(resolveTextShadow(null)).toBeNull();
	});
});

describe('invariants and repair (schema v9: shadow.spreadPx, strokes[])', () => {
	it('flags spreads out of range and stroke lists over the limit', () => {
		expect(textStyleIssues({ shadow: { spreadPx: -1 } })).toHaveLength(1);
		expect(textStyleIssues({ shadow: { spreadPx: MAX_SHADOW_SPREAD_PX + 1 } })).toHaveLength(1);
		expect(textStyleIssues({ shadow: { spreadPx: 26.87 } })).toEqual([]);
		expect(textStyleIssues({ strokes: Array.from({ length: MAX_TEXT_STROKES + 1 }, () => ({})) })).toHaveLength(1);
		expect(textStyleIssues(null)).toEqual([]);
	});

	it('repair always yields a style without issues (property)', () => {
		fc.assert(
			fc.property(
				fc.record({
					strokes: fc.option(fc.array(fc.constant({ color: red, widthPx: 1, position: 'outside' }), { maxLength: 40 }), { nil: undefined }),
					shadow: fc.option(
						fc.record({ spreadPx: fc.oneof(fc.double(), fc.constant('x' as unknown as number), fc.constant(undefined)) }),
						{ nil: null },
					),
				}),
				(style) => {
					const s = structuredClone(style) as Record<string, unknown>;
					repairTextStyle(s);
					expect(textStyleIssues(s)).toEqual([]);
				},
			),
		);
	});

	it('a project with a negative spread and 20 strokes loads repaired, with the repairs reported', () => {
		const h = new Harness();
		h.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hi' }, ref: '$t' }]);
		const id = Object.keys(h.seq.clips)[0]!;
		const doc = structuredClone(h.doc);
		const clip = doc.sequences[h.seqId]!.clips[id] as TextClip;
		clip.content.style.shadow = { color: red, angleDeg: 0, distancePx: 0, blurPx: 4, spreadPx: -3 };
		clip.content.style.strokes = Array.from({ length: 20 }, () => ({ color: red, widthPx: 2, position: 'outside' as const }));
		expect(checkInvariants(doc).map((i) => i.invariant)).toContain('INV-012');
		const repaired = repairDocument(doc, h.ids);
		const style = (repaired.document.sequences[h.seqId]!.clips[id] as TextClip).content.style;
		expect(style.shadow?.spreadPx).toBe(0);
		expect(style.strokes).toHaveLength(MAX_TEXT_STROKES);
		expect(repaired.report.filter((r) => r.action === 'repair-text-style')).toHaveLength(2);
		const loaded = loadProject(doc);
		expect(loaded.issues).toEqual([]);
		expect(loaded.repairs.some((r) => r.action === 'repair-text-style')).toBe(true);
	});

	it('refuses a transaction that sets a negative spread (E_INVARIANT); a valid spread round-trips', () => {
		const h = new Harness();
		const id = h.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hi' }, ref: '$t' }]).refs.$t!;
		const bad = h.tx([
			{
				type: 'clip.update',
				clipId: id,
				patch: { content: { style: { shadow: { color: red, angleDeg: 0, distancePx: 0, blurPx: 0, spreadPx: -1 } } } },
			},
		]);
		expect(bad.ok).toBe(false);
		h.ok([
			{
				type: 'clip.update',
				clipId: id,
				patch: { content: { style: { shadow: { color: red, angleDeg: 90, distancePx: 0, blurPx: 250, spreadPx: 26.87 } } } },
			},
		]);
		expect((h.seq.clips[id] as TextClip).content.style.shadow?.spreadPx).toBe(26.87);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('caption track defaults and caption style presets are checked too', () => {
		const h = new Harness();
		h.ok([{ type: 'caption.add', at: 0, duration: 30, text: 'Hi' }]);
		const doc = structuredClone(h.doc);
		const track = doc.sequences[h.seqId]!.captionTracks[0]!;
		track.styleDefaults = { ...(track.styleDefaults ?? ({} as never)), shadow: { color: red, angleDeg: 0, distancePx: 0, blurPx: 0, spreadPx: -2 } } as never;
		doc.settings.captionStylePresets = [{ id: 'p1', name: 'P', style: { shadow: { color: red, angleDeg: 0, distancePx: 0, blurPx: 0, spreadPx: 1e7 } } }];
		const issues = checkInvariants(doc).filter((i) => i.invariant === 'INV-012');
		expect(issues.length).toBeGreaterThanOrEqual(2);
		const r = repairDocument(doc, h.ids);
		expect(checkInvariants(r.document).filter((i) => i.invariant === 'INV-012')).toEqual([]);
	});
});

/** A measurer with known metrics: 0.6 em per character, line height × size per line; null for `pending` text. */
function fakeMeasurer(calls: unknown[] = []): TextMeasurer {
	return {
		measure(content, box, fonts) {
			calls.push({ text: content.text, family: fonts[content.style.fontId]?.family, autoSize: box.autoSize });
			if (content.text.includes('pending')) return null;
			const lines = content.text.split('\n');
			const w = Math.max(...lines.map((l) => l.length)) * content.style.sizePx * 0.6;
			return { width: box.autoSize === 'width' ? Math.ceil(w) : box.width, height: Math.ceil(lines.length * content.style.sizePx * content.style.lineHeight) };
		},
	};
}

describe('text measurer contract (S01:KND-006, SH-004)', () => {
	it('point text takes the measured box, the default anchor follows it, and the font table reaches the measurer', () => {
		const calls: unknown[] = [];
		const h = new Harness({ ctx: { textMeasurer: fakeMeasurer(calls) } });
		const id = h.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hello', style: { sizePx: 100 } }, ref: '$t' }]).refs.$t!;
		const c = h.seq.clips[id] as TextClip;
		expect(c.box).toMatchObject({ width: 300, height: 120 });
		expect(c.layoutPending).toBeUndefined();
		expect(c.transform.anchor.value).toEqual([150, 60]);
		expect(calls[0]).toMatchObject({ text: 'Hello', family: 'Source Sans 3', autoSize: 'width' });
		h.ok([{ type: 'clip.update', clipId: id, patch: { content: { text: 'Hello world' } } }]);
		const c2 = h.seq.clips[id] as TextClip;
		expect(c2.box.width).toBe(660);
		expect(c2.transform.anchor.value).toEqual([330, 60]);
	});

	it('a custom anchor stays; a measurer that cannot measure (or answers nonsense) leaves an estimate, pending', () => {
		const h = new Harness({ ctx: { textMeasurer: fakeMeasurer() } });
		const id = h.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hello', style: { sizePx: 100 } }, transform: { anchor: [10, 10] }, ref: '$t' }]).refs.$t!;
		h.ok([{ type: 'clip.update', clipId: id, patch: { content: { text: 'Hello again' } } }]);
		expect((h.seq.clips[id] as TextClip).transform.anchor.value).toEqual([10, 10]);
		h.ok([{ type: 'clip.update', clipId: id, patch: { content: { text: 'pending text' } } }]);
		expect((h.seq.clips[id] as TextClip).layoutPending).toBe(true);
		const nan = new Harness({ ctx: { textMeasurer: { measure: () => ({ width: Number.NaN, height: 4 }) } } });
		const id2 = nan.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'x' }, ref: '$t' }]).refs.$t!;
		expect((nan.seq.clips[id2] as TextClip).layoutPending).toBe(true);
		const thrower = new Harness({ ctx: { textMeasurer: { measure: () => { throw new Error('boom'); } } } });
		const id3 = thrower.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'x' }, ref: '$t' }]).refs.$t!;
		expect((thrower.seq.clips[id3] as TextClip).layoutPending).toBe(true);
	});

	it('text.relayout measures every pending clip (headless-made) once a measurer is there; refuses non-text clips', () => {
		const headless = new Harness();
		const a = headless.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Alpha', style: { sizePx: 50 } }, ref: '$t' }]).refs.$t!;
		const b = headless.ok([{ type: 'clip.addText', at: 30, duration: 30, track: 'V2', content: { text: 'Beta beta', style: { sizePx: 50 } }, ref: '$t' }]).refs.$t!;
		expect((headless.seq.clips[a] as TextClip).layoutPending).toBe(true);
		// no measurer: nothing changes, a warning says why
		const none = headless.ok([{ type: 'text.relayout' }]);
		expect(none.warnings.map((w) => w.code)).toContain('W_LAYOUT_PENDING');
		expect((headless.seq.clips[a] as TextClip).layoutPending).toBe(true);
		const before = headless.doc;
		const r = headless.ok([{ type: 'text.relayout' }], { ctx: { textMeasurer: fakeMeasurer() } });
		expect(r.results[0]).toEqual({ measured: 2, pending: [] });
		expect((headless.seq.clips[a] as TextClip).box).toMatchObject({ width: 150, height: 60 });
		expect((headless.seq.clips[b] as TextClip).box.width).toBe(270);
		expect((headless.seq.clips[a] as TextClip).layoutPending).toBeUndefined();
		expect(checkInvariants(headless.doc)).toEqual([]);
		// the previous document is untouched (undo restores it)
		expect((before.sequences[headless.seqId]!.clips[a] as TextClip).layoutPending).toBe(true);
		// measuring again changes nothing
		const again = headless.tx([{ type: 'text.relayout', clipIds: [a] }], { ctx: { textMeasurer: fakeMeasurer() } });
		expect(again.ok && again.changed).toEqual([]);
		const solid = headless.ok([{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V3', color: red, ref: '$s' }]).refs.$s!;
		const refused = headless.tx([{ type: 'text.relayout', clipIds: [solid] }], { ctx: { textMeasurer: fakeMeasurer() } });
		expect(refused.ok).toBe(false);
		expect(!refused.ok && refused.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(headless.tx([{ type: 'text.relayout', clipIds: [] }]).ok).toBe(false);
	});
});

describe('first-stroke property rows keep the other strokes (regression: they replaced the whole list)', () => {
	it('Stroke Width and Stroke Color edit strokes[0] only; width 0 hides it while others exist', () => {
		const h = new Harness();
		const blue = [0, 0, 1, 1] as [number, number, number, number];
		const id = h.ok([
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V1',
				content: {
					text: 'Hi',
					style: {
						strokes: [
							{ color: red, widthPx: 4, position: 'outside' },
							{ color: blue, widthPx: 12, position: 'inside' },
						],
					},
				},
				ref: '$t',
			},
		]).refs.$t!;
		const strokes = () => (h.seq.clips[id] as TextClip).content.style.strokes;
		h.ok([{ type: 'param.set', target: ['clip', id, 'text', 'strokeWidth'], value: 9 }]);
		expect(strokes()).toEqual([
			{ color: red, widthPx: 9, position: 'outside' },
			{ color: blue, widthPx: 12, position: 'inside' },
		]);
		h.ok([{ type: 'param.set', target: ['clip', id, 'text', 'strokeColor'], value: [0, 1, 0, 1] }]);
		expect(strokes()[1]).toEqual({ color: blue, widthPx: 12, position: 'inside' });
		expect(strokes()[0]!.color).toEqual([0, 1, 0, 1]);
		h.ok([{ type: 'param.set', target: ['clip', id, 'text', 'strokeWidth'], value: 0 }]);
		expect(strokes()).toHaveLength(2);
		expect(strokes()[0]!.widthPx).toBe(0);
		expect(drawnStrokes({ strokes: strokes() }).map((s) => s.slot)).toEqual([1]);
	});
});
