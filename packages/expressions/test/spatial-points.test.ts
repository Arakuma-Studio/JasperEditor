// spatial-points: expressions on effect point params (value, valueAtTime, velocity, speed) follow the same
// arc-length timing in layer pixels as the renderers (docs/wp-notes/spatial-points.md).
import {
	type Animatable,
	buildRenderSnapshot,
	evaluate,
	type EffectInstance,
	FLICKS_PER_SECOND,
	resolveSceneAt,
	type SolidClip,
	type Vec2,
} from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { bindDocumentExpressions, bindSnapshotExpressions, loadExpressionEngine, storedTimeAtFrame } from '../src/index.ts';
import { basicDoc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

const M = { metric: [1920, 1080] as const };

function rig(text: string) {
	const d = basicDoc();
	d.tx([{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.transform', ref: '$fx' }]);
	const target = ['effect', '$fx', 'position'];
	d.tx([
		{ type: 'keyframe.add', target, value: [0.2, 0.5], at: { sequenceFrame: 30 } },
		{ type: 'keyframe.add', target, value: [0.5, 0.2], at: { sequenceFrame: 60 } },
		{ type: 'keyframe.add', target, value: [0.8, 0.5], at: { sequenceFrame: 90 } },
		{ type: 'expression.set', target, text },
	]);
	const raw = () =>
		((d.doc.sequences[d.seqId]!.clips[d.refs.$a!] as SolidClip & { effects: EffectInstance[] }).effects.find(
			(e) => e.id === d.refs.$fx,
		)!.params.position as Animatable<Vec2>);
	const ref = { seq: d.seqId, owner: d.refs.$a!, path: `effects.${d.refs.$fx!}.position` };
	return { d, raw, ref };
}

describe('expressions on effect points', () => {
	it('value and valueAtTime are the metric-evaluated (rendered) path', () => {
		const { d, raw, ref } = rig('valueAtTime(time - 0.25)');
		const bound = bindDocumentExpressions(d.doc);
		const fx = (bound.sequences[d.seqId]!.clips[d.refs.$a!] as SolidClip & { effects: EffectInstance[] }).effects.find(
			(e) => e.id === d.refs.$fx,
		)!;
		for (const frame of [45, 60, 75, 100]) {
			const t = storedTimeAtFrame(d.doc, ref, frame);
			const want = evaluate(raw(), t - 0.25 * FLICKS_PER_SECOND, M);
			const got = evaluate(fx.params.position as Animatable<Vec2>, t) as Vec2;
			expect(got[0]).toBeCloseTo(want[0], 9);
			expect(got[1]).toBeCloseTo(want[1], 9);
			// Between the keys the keyframed path is curved and differs from the metric-free reading.
			if (frame === 45 || frame === 75) expect(evaluate(raw(), t, M)).not.toEqual(evaluate(raw(), t));
		}
		// Render snapshots (preview, Remotion, export) resolve the same values.
		const snap = bindSnapshotExpressions(
			JSON.parse(JSON.stringify(buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null }))),
		);
		const layer = resolveSceneAt(snap, 75).find((l) => l.clip.clipId === d.refs.$a)!;
		const t75 = storedTimeAtFrame(d.doc, ref, 75);
		const want = evaluate(raw(), t75 - 0.25 * FLICKS_PER_SECOND, M);
		const got = layer.props.effects.find((e) => e.id === d.refs.$fx)!.params.position as number[];
		expect(got[0]).toBeCloseTo(want[0], 9);
		expect(got[1]).toBeCloseTo(want[1], 9);
	});

	it('velocity is the derivative of the metric-evaluated path (normalised units per second)', () => {
		const { d, raw, ref } = rig('velocity');
		const bound = bindDocumentExpressions(d.doc);
		const fx = (bound.sequences[d.seqId]!.clips[d.refs.$a!] as SolidClip & { effects: EffectInstance[] }).effects.find(
			(e) => e.id === d.refs.$fx,
		)!;
		const t = storedTimeAtFrame(d.doc, ref, 50);
		const v = evaluate(fx.params.position as Animatable<Vec2>, t) as Vec2;
		const h = 1e-3 * FLICKS_PER_SECOND;
		const a = evaluate(raw(), t - h, M);
		const b = evaluate(raw(), t + h, M);
		const want: Vec2 = [(b[0] - a[0]) / 2e-3, (b[1] - a[1]) / 2e-3];
		expect(v[0]).toBeCloseTo(want[0], 2);
		expect(v[1]).toBeCloseTo(want[1], 2);
	});
});
