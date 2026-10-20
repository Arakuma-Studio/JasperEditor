import {
	buildRenderSnapshot,
	contentTimeAt,
	evaluate,
	evaluateKeyframes,
	type RenderSnapshot,
	type RenderVisualSource,
	resolveSceneAt,
	type SolidClip,
	sourceTextAt,
	type TextClip,
} from '@jasper/project';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	bindDocumentExpressions,
	bindSnapshotExpressions,
	evaluateExpressionText,
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
		const seq = bound.sequences[d.seqId]!;
		const a = seq.clips[d.refs.$a!] as SolidClip;
		const rawA = d.doc.sequences[d.seqId]!.clips[d.refs.$a!] as SolidClip;
		const t = storedTimeAtFrame(d.doc, { seq: d.seqId, owner: d.refs.$a!, path: 'transform.rotation' }, 60);
		expect(evaluate(a.transform.rotation, t)).toBeCloseTo(180, 9);
		expect(evaluate(rawA.transform.rotation, t)).toBe(0);
		expect(evaluateKeyframes(a.transform.rotation, t)).toBe(0);
		const p = evaluate(a.transform.position, t) as number[];
		expect(p[0]).toBe(1002);
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
		const title = bound.sequences[d.seqId]!.clips[d.refs.$title!] as TextClip;
		const ref = { seq: d.seqId, owner: d.refs.$title!, path: 'text.content' };
		expect(sourceTextAt(title.content, storedTimeAtFrame(d.doc, ref, 75))).toBe('00:00:02:15');
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
		const src = text.source as Extract<RenderVisualSource, { text: TextClip['content'] }>;
		expect(sourceTextAt(src.text, contentTimeAt(text, 45, { num: 30, den: 1 }))).toBe('00:00:01:15');
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
	it('pick-whip references evaluate to the target property', () => {
		const d = rigged();
		d.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 300,
				track: 'V4',
				content: { text: 'Reader' },
				ref: '$reader',
			},
		]);
		const cases = [
			['$a', 'transform.rotation', '$bg', 'transform.rotation', 180],
			['$a', `effects.${d.refs.$slider}.slider`, '$bg', 'transform.rotation', 42],
			['$bg', 'opacity', '$bg', 'transform.rotation', 100],
			['$title', 'text.content', '$reader', 'text.content', '00:00:02:00'],
		] as const;
		for (const [target, path, owner, ownerPath, value] of cases) {
			const from = { seq: d.seqId, owner: d.refs[owner]!, path: ownerPath };
			const text = pickWhipExpression(d.doc, from, { seq: d.seqId, owner: d.refs[target]!, path });
			expect(text).not.toBeNull();
			expect(evaluateExpressionText(d.doc, from, text!, storedTimeAtFrame(d.doc, from, 60))).toEqual({
				value,
				error: null,
			});
		}
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

describe('agent property reads', () => {
	it('clip.properties reports the expression, its error and the post-expression value', async () => {
		const { runAgentQuery } = await import('@jasper/project');
		const d = rigged();
		d.tx([{ type: 'expression.set', target: ['clip', '$a', 'opacity'], text: 'bad(' }]);
		const r = runAgentQuery({ doc: d.doc, revision: 1 }, 'clip.properties', {
			clipId: d.refs.$a!,
			frame: 60,
			keys: ['transform.rotation', 'opacity'],
		}) as {
			properties: {
				key: string;
				value: unknown;
				evaluated: unknown;
				expression?: unknown;
				expressionError?: string;
			}[];
		};
		const props = r.properties;
		const rot = props.find((p) => p.key === 'transform.rotation')!;
		expect(rot.value).toBe(0);
		expect(rot.evaluated).toBe(180);
		expect(rot.expression).toEqual({ text: 'time * 90', enabled: true });
		const op = props.find((p) => p.key === 'opacity')!;
		expect(op.evaluated).toBe(100);
		expect(op.expressionError).toMatch(/^Error at line 1/);
	});
});
