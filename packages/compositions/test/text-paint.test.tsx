// spec 13 SH-004: the text paint plan (fast path vs tile filter), the paint CSS of each pass and the structure the
// text and caption layers draw (pixels: text-paint.e2e.test.ts).
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type TextStyle,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RENDER_OPTIONS,
	paintCss,
	planTextPaint,
	type RenderDoc,
	SequenceComposition,
} from '../src/index.ts';

const RED = [1, 0, 0, 1] as [number, number, number, number];
const base: TextStyle = {
	fontId: 'fnt_1',
	weight: 400,
	italic: false,
	sizePx: 50,
	lineHeight: 1.2,
	trackingEm: 0,
	align: 'left',
	direction: 'auto',
	fill: [1, 1, 1, 1],
	strokes: [],
	background: null,
	shadow: null,
	allCaps: false,
};
const st = (o: Partial<TextStyle>): TextStyle => ({ ...base, ...o });
const stroke = (widthPx: number, position: 'outside' | 'center' | 'inside', color = RED) => ({
	color,
	widthPx,
	position,
});

describe('paint plan', () => {
	it('opaque fills with outside strokes, and centre strokes above them, take the fast path', () => {
		expect(planTextPaint([st({ strokes: [stroke(4, 'outside'), stroke(10, 'outside')] })]).filter).toBe(
			false,
		);
		expect(planTextPaint([st({ strokes: [stroke(4, 'center'), stroke(10, 'outside')] })]).filter).toBe(false);
		expect(planTextPaint([st({ fill: [1, 1, 1, 0.5], strokes: [stroke(4, 'center')] })]).filter).toBe(false);
	});

	it('inside strokes, a translucent fill with an outside stroke, or a centre stroke below an outside one filter', () => {
		expect(planTextPaint([st({ strokes: [stroke(4, 'inside')] })]).filter).toBe(true);
		expect(planTextPaint([st({ fill: [1, 1, 1, 0.99], strokes: [stroke(4, 'outside')] })]).filter).toBe(true);
		// a translucent run anywhere in the text
		expect(
			planTextPaint([
				st({ strokes: [stroke(4, 'outside')] }),
				st({ fill: [0, 0, 1, 0.5], strokes: [stroke(4, 'outside')] }),
			]).filter,
		).toBe(true);
		expect(planTextPaint([st({ strokes: [stroke(10, 'outside'), stroke(4, 'center')] })]).filter).toBe(true);
	});

	it('bands are listed bottom first (last slot first), shadows once per distinct shadow', () => {
		const shadow = { color: RED, angleDeg: 90, distancePx: 2, blurPx: 4, spreadPx: 3 };
		const p = planTextPaint([
			st({ strokes: [stroke(2, 'outside'), stroke(6, 'center'), stroke(8, 'outside')], shadow }),
			st({ strokes: [stroke(2, 'inside')], shadow }),
		]);
		expect(p.bands).toEqual([
			{ slot: 2, position: 'outside' },
			{ slot: 1, position: 'center' },
			{ slot: 0, position: 'inside' },
			{ slot: 0, position: 'outside' },
		]);
		expect(p.shadows).toHaveLength(1);
		expect(p.shadows[0]!.shadow).toMatchObject({ dx: 0, dy: 2, sigma: 2, spreadPx: 3 });
		expect(p.strokeExtent).toBe(8);
	});

	it('paint CSS: centred stroke widths 2w (outside, inside) and w (centre); other spans draw nothing', () => {
		const s = st({ strokes: [stroke(5, 'outside'), stroke(3, 'inside'), stroke(4, 'center')] });
		expect(paintCss(s, { kind: 'band', slot: 0, position: 'outside' })).toMatchObject({
			color: 'transparent',
			WebkitTextStroke: '10.000px rgba(255, 0, 0, 1)',
		});
		expect(paintCss(s, { kind: 'band', slot: 1, position: 'inside' }).WebkitTextStroke).toBe(
			'6.000px rgba(255, 0, 0, 1)',
		);
		expect(paintCss(s, { kind: 'band', slot: 2, position: 'center' }).WebkitTextStroke).toBe(
			'4.000px rgba(255, 0, 0, 1)',
		);
		expect(paintCss(s, { kind: 'band', slot: 0, position: 'inside' }).WebkitTextStroke).toBe(
			'0px transparent',
		);
		expect(paintCss(s, { kind: 'mask' })).toMatchObject({ color: '#fff' });
		expect(paintCss(s, { kind: 'fill' })).toMatchObject({
			color: 'rgba(255, 255, 255, 1)',
			WebkitTextStroke: '0px transparent',
		});
		// shadow silhouette: glyph + outer strokes (5) + spread (3), as a centred stroke of 2 × 8, opaque colour
		const sh = st({
			...s,
			shadow: { color: [0, 0, 0, 0.5], angleDeg: 0, distancePx: 0, blurPx: 0, spreadPx: 3 },
		});
		const key = planTextPaint([sh]).shadows[0]!.key;
		expect(paintCss(sh, { kind: 'shadow', key })).toMatchObject({
			color: 'rgba(0, 0, 0, 1)',
			WebkitTextStroke: '16.000px rgba(0, 0, 0, 1)',
		});
		expect(paintCss(sh, { kind: 'shadow', key: 'other' }).color).toBe('transparent');
	});
});

function snapshot(commands: Command[], captions = false): RenderDoc {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'P', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const { document, result } = applyTransaction(
		doc,
		{ label: 'setup', origin: 'user', sequenceId: seqId, commands },
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, seqId, {
		resolveMedia: () => null,
		resolveFont: () => null,
		...(captions ? { captions: 'visible' as const } : {}),
	});
}
function frame(doc: RenderDoc, f = 5) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: { ...DEFAULT_RENDER_OPTIONS, isPreview: true } }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={30}
			frameToDisplay={f}
		/>,
	);
}
const addText = (style: Record<string, unknown>): Command =>
	({
		type: 'clip.addText',
		at: 0,
		duration: 30,
		track: 'V1',
		content: { text: 'Hello', style },
		box: { width: 400, height: 100, autoSize: 'none' },
	}) as unknown as Command;

describe('text and caption layer structure', () => {
	it('fast path: shadow layer, outside band copy, then the fill copy (the one text block)', () => {
		const r = frame(
			snapshot([
				addText({
					strokes: [stroke(6, 'outside')],
					shadow: { color: RED, angleDeg: 0, distancePx: 4, blurPx: 6, spreadPx: 2 },
				}),
			]),
		);
		const c = r.container;
		expect(c.querySelectorAll('[data-text-block]')).toHaveLength(1);
		expect(c.querySelectorAll('[data-text-copy="band"]')).toHaveLength(1);
		expect(c.querySelectorAll('[data-text-copy="shadow"]')).toHaveLength(1);
		const layer = c.querySelector('[data-text-shadow]') as HTMLElement;
		expect(layer.style.filter).toBe('blur(3.000px)');
		expect(layer.style.transform).toBe('translate(4px, 0px)');
		expect(c.querySelectorAll('[data-text-tile]')).toHaveLength(0);
		r.unmount();
	});

	it('filter path: fill, mask and one tile per band in one filtered element, aligned by whole tiles', () => {
		const r = frame(snapshot([addText({ strokes: [stroke(6, 'inside'), stroke(4, 'outside')] })]));
		const c = r.container;
		// bands bottom first: the last stroke (slot 1) first
		expect([...c.querySelectorAll('[data-text-tile]')].map((e) => e.getAttribute('data-text-tile'))).toEqual([
			'fill',
			'mask',
			'b1outside',
			'b0inside',
		]);
		const offsets = [...c.querySelectorAll('feOffset')].map((e) => Number(e.getAttribute('dx')));
		const T = -offsets[0]!;
		expect(T).toBeGreaterThan(400);
		expect(offsets.slice(0, 3)).toEqual([-T, -2 * T, -3 * T]);
		expect(c.querySelectorAll('[data-text-block]')).toHaveLength(1);
		r.unmount();
	});

	it('captions: every pass is a copy of the page; ids and the active word only on the fill copy', () => {
		const r = frame(
			snapshot(
				[
					{
						type: 'caption.add',
						at: 0,
						duration: 30,
						text: 'one two',
						style: {
							strokes: [stroke(3, 'outside')],
							background: { color: [0, 0, 0, 0.5], paddingPx: 6, radiusPx: 0 },
							shadow: { color: RED, angleDeg: 90, distancePx: 2, blurPx: 2, spreadPx: 1 },
							highlight: { mode: 'karaoke', color: [1, 1, 0, 1] },
						},
					} as unknown as Command,
				],
				true,
			),
			2,
		);
		const c = r.container;
		expect(c.querySelectorAll('[data-caption-page]')).toHaveLength(1);
		expect(c.querySelectorAll('[data-caption-copy]').length).toBeGreaterThanOrEqual(3);
		expect(c.querySelectorAll('[data-caption-copy="background"]')).toHaveLength(1);
		expect(c.querySelector('[data-caption-page]')!.textContent).toBe('one two');
		r.unmount();
	});
});
