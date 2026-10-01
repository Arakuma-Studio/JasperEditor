// ShapeLayer (S11:SHP-004, wp-m2-shapes): inline SVG geometry from @remotion/shapes inside LayerBox, stroke
// position with the exact visible width (inside = clip, outside = mask, both at 2× width; center = 1×), keyframes
// evaluated at the content time, and the degenerate cases. DOM assertions under happy-dom; the pixel check
// against an analytic reference is the REMOTION_E2E still test in apps/engine/test/shapes-remotion.e2e.test.ts.
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type RenderSnapshot,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { makeEllipse, makeRect } from '@remotion/shapes';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, SequenceComposition } from '../src/index.ts';

const FPS = 30;

/** A 1080p30 document built with real commands; returns the snapshot. */
function docWith(commands: unknown[]): {
	snap: RenderSnapshot;
	doc: ProjectDocument;
	refs: Record<string, string>;
} {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'S', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{ label: 'setup', origin: 'user', commands },
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	const seqId = Object.keys(document.sequences)[0]!;
	return {
		doc: document,
		refs: result.refs,
		snap: buildRenderSnapshot(document, seqId, { resolveMedia: () => null, resolveFont: () => null }),
	};
}

function renderAt(snap: RenderSnapshot, frame: number) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc: snap, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={snap.settings.width}
			compositionHeight={snap.settings.height}
			durationInFrames={Math.max(1, snap.durationFrames)}
			fps={FPS}
			frameToDisplay={frame}
		/>,
	);
}

const add = (shape: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	type: 'clip.addShape',
	at: 0,
	duration: 60,
	track: 'V1',
	shape,
	ref: '$s',
	...extra,
});

function layerOf(root: HTMLElement, clipId: string) {
	const box = root.querySelector<HTMLElement>(`[data-clip-id="${clipId}"]`)!;
	const svg = box.querySelector('svg[data-shape]');
	const g = svg?.querySelector(':scope > g');
	return {
		box,
		svg,
		translate: g?.getAttribute('transform'),
		fill: svg?.querySelector('[data-shape-part="fill"]') ?? null,
		stroke: svg?.querySelector('[data-shape-part="stroke"]') ?? null,
	};
}

describe('ShapeLayer geometry', () => {
	it('draws a rectangle path from makeRect, centred in the layer box, with the fill colour', () => {
		const { snap, refs } = docWith([
			add({ type: 'rect', size: [400, 200], fill: [1, 0, 0, 0.5], cornerRadius: 30 }),
		]);
		const r = renderAt(snap, 10);
		const l = layerOf(r.container, refs.$s!);
		expect(l.box.style.width).toBe('400px');
		expect(l.box.style.height).toBe('200px');
		expect(l.svg?.getAttribute('data-shape')).toBe('rect');
		expect(l.svg?.getAttribute('viewBox')).toBe('0 0 400 200');
		expect(l.translate).toBe('translate(0 0)');
		expect(l.fill?.getAttribute('d')).toBe(makeRect({ width: 400, height: 200, cornerRadius: 30 }).path);
		expect(l.fill?.getAttribute('fill')).toBe('rgba(255, 0, 0, 0.5)');
		expect(l.stroke).toBeNull();
	});

	it('draws an ellipse from makeEllipse; the corner radius is clamped to half the shorter side', () => {
		const { snap, refs } = docWith([
			add({ type: 'rect', size: [100, 40], cornerRadius: 500 }, { ref: '$r' }),
			add({ type: 'ellipse', size: [300, 100] }, { ref: '$e', track: 'V2' }),
		]);
		const root = renderAt(snap, 0).container;
		const rect = layerOf(root, refs.$r!);
		expect(rect.fill?.getAttribute('d')).toBe(makeRect({ width: 100, height: 40, cornerRadius: 20 }).path);
		const ell = layerOf(root, refs.$e!);
		expect(ell.svg?.getAttribute('data-shape')).toBe('ellipse');
		expect(ell.fill?.getAttribute('d')).toBe(makeEllipse({ rx: 150, ry: 50 }).path);
	});

	it.each([
		['center', 10, 'translate(5 5)', null, null],
		['inside', 20, 'translate(0 0)', 'clip', null],
		['outside', 20, 'translate(10 10)', null, 'mask'],
	] as const)(
		'stroke %s: stroke-width %d, geometry offset %s',
		(position, strokeWidth, translate, clip, mask) => {
			const { snap, refs } = docWith([
				add({ type: 'rect', size: [200, 100], stroke: { color: [0, 0, 1, 1], width: 10, position } }),
			]);
			const l = layerOf(renderAt(snap, 0).container, refs.$s!);
			const box = { center: [210, 110], inside: [200, 100], outside: [220, 120] }[position];
			expect([l.box.style.width, l.box.style.height]).toEqual([`${box[0]}px`, `${box[1]}px`]);
			expect(l.translate).toBe(translate);
			expect(l.stroke?.getAttribute('stroke-width')).toBe(String(strokeWidth));
			expect(l.stroke?.getAttribute('stroke')).toBe('rgba(0, 0, 255, 1)');
			expect(l.stroke?.getAttribute('fill')).toBe('none');
			expect(l.stroke?.getAttribute('stroke-linejoin')).toBe('miter');
			const path = makeRect({ width: 200, height: 100 }).path;
			expect(l.stroke?.getAttribute('d')).toBe(path);
			// The fill is drawn first, under the stroke.
			expect(l.fill?.compareDocumentPosition(l.stroke!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
			const clipRef = l.stroke?.getAttribute('clip-path');
			const maskRef = l.stroke?.getAttribute('mask');
			if (clip) {
				const id = /^url\(#(.+)\)$/.exec(clipRef ?? '')![1]!;
				const cp = l.svg!.querySelector(`clipPath[id="${id}"] path`);
				expect(cp?.getAttribute('d')).toBe(path);
			} else expect(clipRef).toBeNull();
			if (mask) {
				const id = /^url\(#(.+)\)$/.exec(maskRef ?? '')![1]!;
				const m = l.svg!.querySelector(`mask[id="${id}"]`)!;
				expect(m.getAttribute('maskUnits')).toBe('userSpaceOnUse');
				// White everywhere around the stroke band, black inside the shape: only the outer half shows.
				const rect = m.querySelector('rect')!;
				expect(rect.getAttribute('fill')).toBe('white');
				expect(Number(rect.getAttribute('x'))).toBeLessThanOrEqual(-10);
				expect(Number(rect.getAttribute('width'))).toBeGreaterThanOrEqual(220);
				expect(m.querySelector('path')?.getAttribute('d')).toBe(path);
				expect(m.querySelector('path')?.getAttribute('fill')).toBe('black');
			} else expect(maskRef).toBeNull();
		},
	);

	it('evaluates keyframed size and colour at the content time (frame-dependent layer)', () => {
		const { snap, doc, refs } = docWith([add({ type: 'ellipse', size: [100, 100] })]);
		const id = refs.$s!;
		const seqId = snap.sequenceId;
		const ids = createCounterIdSource(100);
		const { document, result } = applyTransaction(
			doc,
			{
				label: 'keys',
				origin: 'user',
				commands: [
					{
						type: 'param.setAnimated',
						target: ['clip', id, 'shape', 'size'],
						animated: true,
						at: { sequenceFrame: 0 },
					},
					{
						type: 'param.setAnimated',
						target: ['clip', id, 'shape', 'fill'],
						animated: true,
						at: { sequenceFrame: 0 },
					},
					{
						type: 'param.set',
						target: ['clip', id, 'shape', 'size'],
						value: [300, 200],
						at: { sequenceFrame: 20 },
					},
					{
						type: 'param.set',
						target: ['clip', id, 'shape', 'fill'],
						value: [0, 0, 0, 1],
						at: { sequenceFrame: 20 },
					},
				],
			},
			{ ids, now: () => 't', revision: 1, registries: defaultRegistries() },
		);
		expect(result.ok).toBe(true);
		const keyed = buildRenderSnapshot(document, seqId, { resolveMedia: () => null, resolveFont: () => null });
		const at = (frame: number) => layerOf(renderAt(keyed, frame).container, id);
		// The box is the largest size; the geometry is centred in it.
		const start = at(0);
		expect(start.box.style.width).toBe('300px');
		expect(start.translate).toBe('translate(100 50)');
		expect(start.fill?.getAttribute('d')).toBe(makeEllipse({ rx: 50, ry: 50 }).path);
		const mid = at(10);
		expect(mid.translate).toBe('translate(50 25)');
		expect(mid.fill?.getAttribute('d')).toBe(makeEllipse({ rx: 100, ry: 75 }).path);
		expect(mid.fill?.getAttribute('fill')).toBe('rgba(128, 128, 128, 1)');
		const end = at(30);
		expect(end.translate).toBe('translate(0 0)');
		expect(end.fill?.getAttribute('fill')).toBe('rgba(0, 0, 0, 1)');
	});

	it('draws nothing for a zero size, no fill path for "None", no stroke path for width 0', () => {
		const { snap, refs } = docWith([
			add({ type: 'rect', size: [0, 50] }, { ref: '$a' }),
			add(
				{ type: 'ellipse', fill: null, stroke: { color: [1, 1, 1, 1], width: 0 } },
				{ ref: '$b', track: 'V2' },
			),
		]);
		const root = renderAt(snap, 0).container;
		expect(layerOf(root, refs.$a!).svg).toBeNull();
		const b = layerOf(root, refs.$b!);
		expect(b.svg).not.toBeNull();
		expect(b.fill).toBeNull();
		expect(b.stroke).toBeNull();
	});

	it('gives every layer its own clip/mask ids', () => {
		const stroke = { color: [1, 1, 1, 1], width: 4, position: 'inside' };
		const { snap, refs } = docWith([
			add({ type: 'rect', stroke }, { ref: '$a' }),
			add({ type: 'rect', stroke }, { ref: '$b', track: 'V2' }),
		]);
		const root = renderAt(snap, 0).container;
		const a = layerOf(root, refs.$a!).stroke?.getAttribute('clip-path');
		const b = layerOf(root, refs.$b!).stroke?.getAttribute('clip-path');
		expect(a).toMatch(/^url\(#shape-/);
		expect(a).not.toBe(b);
	});
});
