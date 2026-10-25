// Effect-point expressions use arc-length timing in layer pixels (wp-notes/spatial-points.md), including
// pre-expression valueAtTime. These literals come from independent
// adaptive Simpson integration of |(1920·3(1−t)², 1080·3t²)|, not the production evaluator's arc table.
import {
	type Animatable,
	buildRenderSnapshot,
	type EffectInstance,
	evaluate,
	resolveSceneAt,
	type SolidClip,
	type Vec2,
} from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { bindDocumentExpressions, bindSnapshotExpressions, loadExpressionEngine } from '../src/index.ts';
import { basicDoc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

function rig(text: string) {
	const d = basicDoc();
	d.tx([{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.transform', ref: '$fx' }]);
	const target = ['effect', '$fx', 'position'];
	d.tx([
		{
			type: 'keyframe.add',
			target,
			value: [0, 0],
			at: { sequenceFrame: 30 },
			spatial: { mode: 'bezier', inTangent: [0, 0], outTangent: [1, 0] },
		},
		{
			type: 'keyframe.add',
			target,
			value: [1, 1],
			at: { sequenceFrame: 90 },
			spatial: { mode: 'bezier', inTangent: [0, -1], outTangent: [0, 0] },
		},
		{ type: 'expression.set', target, text },
	]);
	const point = (doc: typeof d.doc) =>
		(doc.sequences[d.seqId]!.clips[d.refs.$a!] as SolidClip & { effects: EffectInstance[] }).effects.find(
			(e) => e.id === d.refs.$fx,
		)!.params.position as Animatable<Vec2>;
	return { d, point };
}

const at = (frame: number) => (frame - 30) * 23_520_000;
const expectPoint = (got: Vec2, expected: Vec2) => {
	// KF-031 approximation budget is 0.25 px, independently of the expression or evaluator implementation.
	expect(Math.hypot((got[0] - expected[0]) * 1920, (got[1] - expected[1]) * 1080)).toBeLessThan(0.25);
};

describe('expressions on effect points', () => {
	it('value and valueAtTime are the metric-evaluated (rendered) path', () => {
		const { d, point } = rig('valueAtTime(time - 0.25)');
		const bound = point(bindDocumentExpressions(d.doc));
		for (const [frame, expected] of [
			[45, [0.177079651957084, 0.000248858296084]],
			[60, [0.531159709163455, 0.011110765096814]],
			[75, [0.876429942588553, 0.126440931706836]],
			[100, [1, 1]],
		] as [number, Vec2][])
			expectPoint(evaluate(bound, at(frame)), expected);
		const snap = bindSnapshotExpressions(
			JSON.parse(
				JSON.stringify(
					buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null }),
				),
			),
		);
		const layer = resolveSceneAt(snap, 75).find((l) => l.clip.clipId === d.refs.$a)!;
		expectPoint(
			layer.props.effects.find((e) => e.id === d.refs.$fx)!.params.position as Vec2,
			[0.876429942588553, 0.126440931706836],
		);
	});
});
