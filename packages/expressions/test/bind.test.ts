// Binding: the shared evaluate(), render snapshots (also after JSON, as in the Remotion renderer), scene resolution
// and determinism across evaluation orders.
import {
	buildRenderSnapshot,
	contentTimeAt,
	evaluate,
	evaluateKeyframes,
	type RenderSnapshot,
	resolveSceneAt,
	sourceTextAt,
} from '@jasper/project';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	bindDocumentExpressions,
	bindSnapshotExpressions,
	evaluateSelectorExpression,
	loadExpressionEngine,
	pickWhipExpression,
	propertyStatusAt,
	storedTimeAtFrame,
} from '../src/index.ts';
import { basicDoc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

const snapOpts = { resolveMedia: () => null, resolveFont: () => null };

function rigged() {
	const d = basicDoc();
	d.tx([
		{ type: 'expression.set', target: ['clip', '$a', 'transform', 'rotation'], text: 'time * 90' },
		{
			type: 'expression.set',
			target: ['clip', '$a', 'transform', 'position'],
			text: 'value + [effect("Slider Control")("Slider"), wiggle(3, 20)[1] - value[1]]',
		},
		{ type: 'expression.set', target: ['clip', '$title', 'text', 'content'], text: 'timeToTimecode()' },
		{ type: 'expression.set', target: ['clip', '$bg', 'opacity'], text: 'linear(time, 0, 2, 0, 100)' },
	]);
	return d;
}

describe('documents', () => {
	it('evaluate() of a bound document returns post-expression values; the raw document is untouched', () => {
		const d = rigged();
		const bound = bindDocumentExpressions(d.doc);
		expect(bindDocumentExpressions(d.doc)).toBe(bound);
		const seq = bound.sequences[d.seqId]!;
		const a = seq.clips[d.refs.$a!] as never as { transform: { rotation: never; position: never } };
		const rawA = d.doc.sequences[d.seqId]!.clips[d.refs.$a!] as never as { transform: { rotation: never } };
		const t = storedTimeAtFrame(d.doc, { seq: d.seqId, owner: d.refs.$a!, path: 'transform.rotation' }, 60);
		expect(evaluate(a.transform.rotation, t)).toBeCloseTo(180, 9);
		expect(evaluate(rawA.transform.rotation, t)).toBe(0);
		expect(evaluateKeyframes(a.transform.rotation, t)).toBe(0);
		const p = evaluate(a.transform.position, t) as number[];
		expect(p[0]).toBe(1002);
		// JSON never sees the binding.
		expect(JSON.stringify(bound)).toBe(JSON.stringify(d.doc));
	});
	it('a disabled expression renders the keyframed value; status reports errors', () => {
		const d = rigged();
		d.tx([
			{ type: 'expression.setEnabled', target: ['clip', '$a', 'transform', 'rotation'], enabled: false },
		]);
		const ref = { seq: d.seqId, owner: d.refs.$a!, path: 'transform.rotation' };
		const t = storedTimeAtFrame(d.doc, ref, 60);
		expect(propertyStatusAt(d.doc, ref, t)?.value).toBe(0);
		d.tx([{ type: 'expression.set', target: ['clip', '$a', 'transform', 'rotation'], text: 'nope(' }]);
		const st = propertyStatusAt(d.doc, ref, t)!;
		expect(st.value).toBe(0);
		expect(st.expressionError).toMatch(/^Error at line 1/);
		expect(st.expression).toEqual({ text: 'nope(', enabled: true });
	});
	it('Source Text expressions', () => {
		const d = rigged();
		const bound = bindDocumentExpressions(d.doc);
		const title = bound.sequences[d.seqId]!.clips[d.refs.$title!] as never as { content: never };
		const ref = { seq: d.seqId, owner: d.refs.$title!, path: 'text.content' };
		expect(sourceTextAt(title.content, storedTimeAtFrame(d.doc, ref, 75))).toBe('00:00:02:15');
	});
	it('commands: clear, empty text, undo-friendly storage', () => {
		const d = rigged();
		d.tx([{ type: 'expression.clear', target: ['clip', '$a', 'transform', 'rotation'] }]);
		const a = d.doc.sequences[d.seqId]!.clips[d.refs.$a!] as never as {
			transform: { rotation: { expression?: unknown } };
		};
		expect(a.transform.rotation.expression).toBeUndefined();
		d.tx([{ type: 'expression.set', target: ['clip', '$a', 'transform', 'position'], text: '  ' }]);
		const b = d.doc.sequences[d.seqId]!.clips[d.refs.$a!] as never as {
			transform: { position: { expression?: unknown } };
		};
		expect(b.transform.position.expression).toBeUndefined();
		expect(() =>
			d.tx([{ type: 'expression.set', target: ['clip', '$a', 'transform', 'flipH'], text: '1' }]),
		).toThrow(/not animatable/);
	});
});

describe('render snapshots', () => {
	it('carry the world, drop Expression Controls and bind after JSON', () => {
		const d = rigged();
		const snap = buildRenderSnapshot(d.doc, d.seqId, snapOpts);
		expect(snap.expressions).toBeDefined();
		const aClip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === d.refs.$a)!;
		expect(aClip.effects).toEqual([]);
		const json = JSON.parse(JSON.stringify(snap)) as RenderSnapshot;
		const bound = bindSnapshotExpressions(json);
		for (const frame of [30, 47, 60, 99, 149]) {
			const live = resolveSceneAt(snap, frame).map((l) => l.props);
			const remote = resolveSceneAt(bound, frame).map((l) => l.props);
			expect(remote).toEqual(live);
		}
		const scene = resolveSceneAt(bound, 60);
		const a = scene.find((l) => l.clip.clipId === d.refs.$a)!;
		expect(a.props.transform!.rotation).toBeCloseTo(180, 9);
		const bg = scene.find((l) => l.clip.clipId === d.refs.$bg)!;
		expect(bg.props.opacity).toBe(100);
		expect(resolveSceneAt(bound, 15).find((l) => l.clip.clipId === d.refs.$bg)!.props.opacity).toBeCloseTo(
			25,
			9,
		);
		const text = bound.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === d.refs.$title)!;
		const src = text.source as unknown as { text: never };
		expect(sourceTextAt(src.text, contentTimeAt(text, 45, { num: 30, den: 1 }))).toBe('00:00:01:15');
	});
	it('documents without expressions keep plain snapshots', () => {
		const d = basicDoc();
		const snap = buildRenderSnapshot(d.doc, d.seqId, snapOpts);
		expect(snap.expressions).toBeUndefined();
		expect(bindSnapshotExpressions(snap)).toBe(snap);
	});
	it('values do not depend on evaluation order (fresh worlds, shuffled frames)', () => {
		const d = rigged();
		const reference = (() => {
			const s = bindSnapshotExpressions(
				JSON.parse(JSON.stringify(buildRenderSnapshot(d.doc, d.seqId, snapOpts))),
			);
			return Array.from({ length: 40 }, (_, f) => resolveSceneAt(s, 30 + f * 3).map((l) => l.props));
		})();
		fc.assert(
			fc.property(fc.shuffledSubarray([...Array(40).keys()], { minLength: 40, maxLength: 40 }), (order) => {
				const s = bindSnapshotExpressions(
					JSON.parse(JSON.stringify(buildRenderSnapshot(d.doc, d.seqId, snapOpts))),
				);
				for (const i of order)
					expect(resolveSceneAt(s, 30 + i * 3).map((l) => l.props)).toEqual(reference[i]);
			}),
			{ numRuns: 8, seed: 7 },
		);
	});
});

describe('pick-whip and the Expression Selector API', () => {
	it('pick-whip references', () => {
		const d = rigged();
		const from = { seq: d.seqId, owner: d.refs.$bg!, path: 'transform.rotation' };
		expect(
			pickWhipExpression(d.doc, from, { seq: d.seqId, owner: d.refs.$a!, path: 'transform.rotation' }),
		).toBe('thisComp.layer("A").transform.rotation');
		expect(
			pickWhipExpression(d.doc, from, {
				seq: d.seqId,
				owner: d.refs.$a!,
				path: `effects.${d.refs.$slider}.slider`,
			}),
		).toBe('thisComp.layer("A").effect("Slider Control")("Slider")');
		expect(pickWhipExpression(d.doc, from, { seq: d.seqId, owner: d.refs.$bg!, path: 'opacity' })).toBe(
			'transform.opacity',
		);
		expect(
			pickWhipExpression(d.doc, from, { seq: d.seqId, owner: d.refs.$title!, path: 'text.content' }),
		).toBe('thisComp.layer("Title").text.sourceText');
	});
	it('selector amounts per unit', () => {
		const d = basicDoc();
		const at = { sequenceId: d.seqId, clipId: d.refs.$title!, selectorId: 'anim1' };
		const r = evaluateSelectorExpression(d.doc, at, 'textIndex / textTotal * 100', 0, {
			textIndex: 2,
			textTotal: 4,
			selectorValue: [100, 100, 100],
		});
		expect(r).toEqual({ ok: true, amount: [50, 50, 50] });
		const v = evaluateSelectorExpression(d.doc, at, 'selectorValue * 0.5', 0, {
			textIndex: 1,
			textTotal: 4,
			selectorValue: [100, 80, 60],
		});
		expect(v).toEqual({ ok: true, amount: [50, 40, 30] });
		const rand = (i: number) =>
			evaluateSelectorExpression(d.doc, at, 'random(100)', 0, {
				textIndex: i,
				textTotal: 4,
				selectorValue: [100, 100, 100],
			});
		expect(rand(1)).toEqual(rand(1));
		expect(rand(1)).not.toEqual(rand(2));
		expect(
			evaluateSelectorExpression(d.doc, at, '"x"', 0, {
				textIndex: 1,
				textTotal: 1,
				selectorValue: [100, 100, 100],
			}).ok,
		).toBe(false);
	});
});
