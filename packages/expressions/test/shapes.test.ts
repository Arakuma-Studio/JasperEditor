// Expressions on vector shape items (wp shapes): binding into documents and snapshots, AE's content() access path,
// the drawn geometry following the expression, refusal on structured values.
import {
	buildRenderSnapshot,
	evaluate,
	evaluateVectorShape,
	resolveSceneAt,
	shapeGeom,
	type ShapeItem,
} from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { bindDocumentExpressions, loadExpressionEngine, propertyStatusAt, storedTimeAtFrame } from '../src/index.ts';
import { basicDoc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

const snapOpts = { resolveMedia: () => null, resolveFont: () => null };

function shapeDoc() {
	const d = basicDoc();
	d.tx([
		{
			type: 'clip.addShape',
			at: 0,
			duration: 120,
			track: 'V4',
			name: 'Logo',
			shape: {
				type: 'vector',
				contents: [
					{ type: 'group', name: 'Box', contents: [{ type: 'rect', name: 'Body', size: [100, 50] }, { type: 'fill' }] },
					{ type: 'trim', name: 'Trim', end: 100 },
				],
			},
			ref: '$s',
		},
	]);
	const clip = d.doc.sequences[d.seqId]!.clips[d.refs.$s!] as unknown as { shape: { contents: ShapeItem[] } };
	const group = clip.shape.contents[0] as Extract<ShapeItem, { type: 'group' }>;
	return { d, groupId: group.id, rectId: group.contents[0]!.id, trimId: clip.shape.contents[1]!.id };
}

describe('vector shape expressions', () => {
	it('drive item properties in documents and render snapshots; content() reaches nested items', () => {
		const { d, groupId, rectId } = shapeDoc();
		d.tx([
			{ type: 'expression.set', target: ['clip', '$s', 'shape', 'items', rectId, 'size'], text: '[time * 100, 40]' },
			{
				type: 'expression.set',
				target: ['clip', '$s', 'shape', 'items', groupId, 'transform', 'rotation'],
				text: 'content("Box").content("Body").size[0] / 10',
			},
		]);
		const ref = { seq: d.seqId, owner: d.refs.$s!, path: `shape.items.${rectId}.size` };
		const t = storedTimeAtFrame(d.doc, ref, 60);
		expect(propertyStatusAt(d.doc, ref, t)?.value).toEqual([200, 40]);
		const rot = propertyStatusAt(d.doc, { ...ref, path: `shape.items.${groupId}.transform.rotation` }, t);
		expect(rot?.expressionError ?? null).toBeNull();
		expect(rot?.value).toBeCloseTo(20, 9);
		// The bound document and the render snapshot draw the expression's geometry.
		const bound = bindDocumentExpressions(d.doc);
		const clip = bound.sequences[d.seqId]!.clips[d.refs.$s!] as unknown as { shape: { contents: ShapeItem[] } };
		const rect = (clip.shape.contents[0] as Extract<ShapeItem, { type: 'group' }>).contents[0] as Extract<ShapeItem, { type: 'rect' }>;
		expect(evaluate(rect.size, t)).toEqual([200, 40]);
		const snap = buildRenderSnapshot(d.doc, d.seqId, snapOpts);
		const layer = resolveSceneAt(snap, 60).find((l) => l.clip.clipId === d.refs.$s)!;
		const draws = evaluateVectorShape((layer.clip.source as { shape: { contents: ShapeItem[] } }).shape.contents, layer.contentTime);
		const b = shapeGeom.pathBounds(draws[0]!.paths)!;
		// 200×40 rotated by 20°: width = 200·cos20 + 40·sin20.
		expect(b.x1 - b.x0).toBeCloseTo(200 * Math.cos(Math.PI / 9) + 40 * Math.sin(Math.PI / 9), 3);
	});

	it('refuses expressions on gradients and paths', () => {
		const d = basicDoc();
		d.tx([
			{
				type: 'clip.addShape',
				at: 0,
				track: 'V4',
				shape: { type: 'vector', contents: [{ type: 'path', path: 'M0 0 L10 0' }, { type: 'gradientFill' }] },
				ref: '$s',
			},
		]);
		const items = (d.doc.sequences[d.seqId]!.clips[d.refs.$s!] as unknown as { shape: { contents: ShapeItem[] } }).shape.contents;
		expect(() => d.tx([{ type: 'expression.set', target: ['clip', '$s', 'shape', 'items', items[0]!.id, 'path'], text: 'value' }])).toThrow(/E_INVALID_PARAM/);
		expect(() => d.tx([{ type: 'expression.set', target: ['clip', '$s', 'shape', 'items', items[1]!.id, 'colors'], text: 'value' }])).toThrow(/E_INVALID_PARAM/);
	});
});
