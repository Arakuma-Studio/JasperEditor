// Expression commands (expression.set / clear / setEnabled, effect.rename), Expression Controls, snapshot
// handling, invariants and repair. Evaluation itself is tested in packages/expressions.
import { describe, expect, it } from 'vitest';
import {
	buildEffectPreset,
	buildRenderSnapshot,
	checkInvariants,
	createCounterIdSource,
	documentHasActiveExpressions,
	EXPRESSION_CONTROL_EFFECTS,
	evaluate,
	expressionRefToParamPath,
	isAnimated,
	paramPathToExpressionRef,
	parseEffectPreset,
	repairDocument,
	sequenceAnimatables,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

function setup() {
	const h = new Harness();
	const r = h.ok([
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [1, 0, 0, 1], name: 'A', ref: '$a' },
		{ type: 'clip.addText', at: 0, duration: 90, track: 'V2', content: { text: 'Hi' }, name: 'T', ref: '$t' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.slider-control', ref: '$s' },
	]);
	return { h, a: r.refs.$a!, t: r.refs.$t!, s: r.refs.$s! };
}

const anim = (h: Harness, clipId: string, ...path: string[]) => {
	let v: unknown = h.seq.clips[clipId];
	for (const k of path) v = (v as Record<string, unknown>)[k];
	return v as { value: unknown; keyframes: unknown[]; expression?: { text: string; enabled: boolean } };
};

describe('commands', () => {
	it('set, disable, clear: stored on the Animatable, the input document untouched', () => {
		const { h, a } = setup();
		const before = h.doc;
		h.ok([{ type: 'expression.set', target: ['clip', a, 'transform', 'rotation'], text: 'time * 90' }]);
		expect(anim(h, a, 'transform', 'rotation').expression).toEqual({ text: 'time * 90', enabled: true });
		expect(
			(before.sequences[h.seqId]!.clips[a] as never as { transform: { rotation: object } }).transform
				.rotation,
		).not.toHaveProperty('expression');
		h.ok([{ type: 'expression.setEnabled', target: ['clip', a, 'transform', 'rotation'], enabled: false }]);
		expect(anim(h, a, 'transform', 'rotation').expression?.enabled).toBe(false);
		expect(isAnimated(anim(h, a, 'transform', 'rotation') as never)).toBe(false);
		h.ok([{ type: 'expression.clear', target: ['clip', a, 'transform', 'rotation'] }]);
		expect(anim(h, a, 'transform', 'rotation').expression).toBeUndefined();
	});
	it('effect params, Source Text, masks, transitions', () => {
		const { h, a, t, s } = setup();
		h.ok([
			{ type: 'expression.set', target: ['effect', s, 'slider'], text: 'time' },
			{ type: 'expression.set', target: ['clip', t, 'text', 'content'], text: 'timeToTimecode()' },
		]);
		expect(
			(h.seq.clips[a] as never as { effects: { params: { slider: { expression: unknown } } }[] }).effects[0]!
				.params.slider.expression,
		).toEqual({ text: 'time', enabled: true });
		expect((h.seq.clips[t] as never as { content: { expression: unknown } }).content.expression).toEqual({
			text: 'timeToTimecode()',
			enabled: true,
		});
	});
	it('refusals: static properties, faders, audio effects, template params, missing expression', () => {
		const { h, a } = setup();
		const fail = (cmd: unknown) => {
			const r = h.tx([cmd]);
			expect(r.ok).toBe(false);
			return r.ok ? '' : r.errors[0]!.message;
		};
		expect(fail({ type: 'expression.set', target: ['clip', a, 'transform', 'flipH'], text: '1' })).toMatch(
			/not animatable/,
		);
		const track = h.seq.audioTracks[0]!.id;
		expect(fail({ type: 'expression.set', target: ['track', track, 'volumeDb'], text: '0' })).toMatch(
			/Audio Track Mixer/,
		);
		expect(fail({ type: 'expression.set', target: ['master', 'volumeDb'], text: '0' })).toMatch(
			/Audio Track Mixer/,
		);
		expect(fail({ type: 'expression.setEnabled', target: ['clip', a, 'opacity'], enabled: true })).toMatch(
			/no expression/,
		);
		expect(fail({ type: 'expression.set', target: ['clip', a, 'params', 'x'], text: '1' })).toMatch(
			/template parameters/,
		);
	});
	it('effect.rename', () => {
		const { h, a, s } = setup();
		h.ok([{ type: 'effect.rename', effectInstanceId: s, name: 'Speed' }]);
		const fx = () => (h.seq.clips[a] as never as { effects: { name?: string }[] }).effects[0]!;
		expect(fx().name).toBe('Speed');
		h.ok([{ type: 'effect.rename', effectInstanceId: s, name: null }]);
		expect(fx().name).toBeUndefined();
	});
	it('expressions travel with duplicated / pasted effect params', () => {
		const { h, a } = setup();
		const r = h.ok([
			{
				type: 'effect.add',
				target: { clipId: a },
				effectId: 'jasper.slider-control',
				params: { slider: { value: 3, keyframes: [], expression: { text: 'value * 2', enabled: true } } },
			},
		]);
		const id = (r.results[0] as { effectInstanceId: string }).effectInstanceId;
		const fx = (
			h.seq.clips[a] as never as { effects: { id: string; params: { slider: { expression: unknown } } }[] }
		).effects.find((e) => e.id === id)!;
		expect(fx.params.slider.expression).toEqual({ text: 'value * 2', enabled: true });
		expect(
			h.tx([
				{
					type: 'effect.add',
					target: { clipId: a },
					effectId: 'jasper.slider-control',
					params: { slider: { value: 3, keyframes: [], expression: { text: 1 } } },
				},
			]).ok,
		).toBe(false);
	});
});

describe('effect presets', () => {
	it('carry expressions of intrinsic properties and effect params', () => {
		const { h, a, s } = setup();
		h.ok([
			{ type: 'expression.set', target: ['clip', a, 'opacity'], text: 'wiggle(2, 20)' },
			{ type: 'expression.set', target: ['effect', s, 'slider'], text: 'time * 10' },
		]);
		const built = buildEffectPreset(h.doc, a, {
			name: 'P',
			type: 'anchor-in',
			sections: { opacity: true, effectIds: [s] },
			id: 'fxp_TEST',
		});
		const parsed = parseEffectPreset(JSON.parse(JSON.stringify(built)));
		expect(parsed.ok).toBe(true);
		const r = h.ok([
			{ type: 'clip.addSolid', at: 100, duration: 30, track: 'V1', color: [0, 0, 0, 1], ref: '$b' },
		]);
		const b = r.refs.$b!;
		h.ok([{ type: 'effect.applyPreset', preset: (parsed as { preset: unknown }).preset, clipIds: [b] }]);
		expect(anim(h, b, 'opacity').expression).toEqual({ text: 'wiggle(2, 20)', enabled: true });
		const fx = (h.seq.clips[b] as never as { effects: { params: { slider: { expression: unknown } } }[] })
			.effects[0]!;
		expect(fx.params.slider.expression).toEqual({ text: 'time * 10', enabled: true });
	});
});

describe('Expression Controls', () => {
	it('are passthrough, applied with clip-centred points, and left out of render snapshots', () => {
		expect(EXPRESSION_CONTROL_EFFECTS.map((e) => e.label)).toEqual([
			'Slider Control',
			'Angle Control',
			'Checkbox Control',
			'Color Control',
			'Point Control',
			'3D Point Control',
			'Layer Control',
			'Dropdown Menu Control',
		]);
		for (const e of EXPRESSION_CONTROL_EFFECTS) expect(e.passthrough).toBe(true);
		const { h, a } = setup();
		const r = h.ok([
			{ type: 'effect.add', target: { clipId: a }, effectId: 'jasper.point-control' },
			{ type: 'effect.add', target: { clipId: a }, effectId: 'jasper.point3d-control' },
		]);
		const fxs = (h.seq.clips[a] as never as { effects: { params: { point?: { value: unknown } } }[] })
			.effects;
		expect(fxs[1]!.params.point!.value).toEqual([960, 540]);
		expect(fxs[2]!.params.point!.value).toEqual([960, 540, 0]);
		expect(r.ok).toBe(true);
		h.ok([{ type: 'effect.add', target: { clipId: a }, effectId: 'jasper.gaussian-blur' }]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === a)!;
		expect(clip.effects.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur']);
	});
	it('3D points validate as three numbers', () => {
		const { h, a } = setup();
		const r = h.ok([
			{ type: 'effect.add', target: { clipId: a }, effectId: 'jasper.point3d-control', ref: '$p' },
		]);
		const p = r.refs.$p!;
		expect(h.tx([{ type: 'param.set', target: ['effect', p, 'point'], value: [1, 2] }]).ok).toBe(false);
		expect(h.tx([{ type: 'param.set', target: ['effect', p, 'point'], value: [1, 2, 3] }]).ok).toBe(true);
	});
});

describe('model helpers', () => {
	it('snapshots carry the world only with active expressions; unbound evaluation is the keyframed value', () => {
		const { h, a } = setup();
		const opts = { resolveMedia: () => null, resolveFont: () => null };
		expect(buildRenderSnapshot(h.doc, h.seqId, opts).expressions).toBeUndefined();
		h.ok([{ type: 'expression.set', target: ['clip', a, 'opacity'], text: '50' }]);
		expect(documentHasActiveExpressions(h.doc)).toBe(true);
		const snap = buildRenderSnapshot(h.doc, h.seqId, opts);
		expect(snap.expressions?.sequences[h.seqId]).toBeDefined();
		// No engine installed in this package's tests: the stored value renders.
		expect(evaluate(anim(h, a, 'opacity') as never, 0)).toBe(100);
	});
	it('ParamPath ↔ ExpressionRef round trip for every expression location', () => {
		const { h } = setup();
		for (const loc of sequenceAnimatables(h.seqId, h.seq)) {
			if (loc.ref.owner === 'master' || loc.kind === 'text') continue;
			const back = paramPathToExpressionRef(h.doc, expressionRefToParamPath(loc.ref), h.seqId);
			expect(back).toEqual(loc.ref);
		}
	});
	it('invariants flag and repair drops malformed or misplaced expressions', () => {
		const { h, a } = setup();
		const doc = JSON.parse(JSON.stringify(h.doc));
		const seq = doc.sequences[h.seqId];
		seq.clips[a].transform.rotation.expression = { text: 5 };
		seq.master.volumeDb.expression = { text: '0', enabled: true };
		const expr = (d: unknown) =>
			checkInvariants(d as never).filter((i) => (i as { invariant?: string }).invariant === 'INV-EXPR');
		expect(
			expr(doc)
				.map((i) => i.message)
				.sort(),
		).toEqual([
			'INV-EXPR: Malformed expression (expected {text, enabled})',
			'INV-EXPR: This property does not take expressions',
		]);
		const { document, report } = repairDocument(doc, createCounterIdSource(99));
		expect(report.filter((r) => r.action === 'drop-expression')).toHaveLength(2);
		expect(expr(document)).toEqual([]);
	});
});
