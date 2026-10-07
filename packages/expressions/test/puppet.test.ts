// sim-warp: expressions on Puppet pin properties — evaluated through the shared evaluate() in bound documents and
// render snapshots (after JSON), reachable as effect("Puppet")("Puppet Pin 1").position, mesh params refused.
import { buildRenderSnapshot, evaluate, type RenderSnapshot, resolvePuppet } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { bindDocumentExpressions, bindSnapshotExpressions, evaluateExpressionText, loadExpressionEngine, storedTimeAtFrame } from '../src/index.ts';
import { basicDoc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

function rigged() {
	const d = basicDoc();
	d.tx([
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.puppet', ref: '$pup' },
		{ type: 'puppet.addPin', effectInstanceId: '$pup', position: [0.2, 0.5], ref: '$pin1' },
		{ type: 'puppet.addPin', effectInstanceId: '$pup', position: [0.8, 0.5], ref: '$pin2' },
	]);
	d.tx([{ type: 'expression.set', target: ['puppetPin', '$pin2', 'position'], text: '[0.8, 0.5 + time * 0.1]' }]);
	return d;
}

describe('puppet pin expressions', () => {
	it('bound documents and snapshots evaluate the pin expression', () => {
		const d = rigged();
		const bound = bindDocumentExpressions(d.doc);
		const clip = bound.sequences[d.seqId]!.clips[d.refs.$a!] as never as { effects: { puppet: { pins: { position: never }[] } }[] };
		const pup = clip.effects.find((e) => e.puppet)!.puppet;
		const t = storedTimeAtFrame(d.doc, { seq: d.seqId, owner: d.refs.$a!, path: `puppet.${d.refs.$pin2}.position` }, 60);
		expect((evaluate(pup.pins[1]!.position, t) as number[])[1]).toBeCloseTo(0.7, 6);
		// The renderer's resolved puppet sees it too (snapshot after JSON).
		const snap = JSON.parse(JSON.stringify(buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null }))) as RenderSnapshot;
		const b = bindSnapshotExpressions(snap);
		const c = b.videoTracks.flatMap((tr) => tr.clips).find((x) => x.clipId === d.refs.$a)!;
		const fx = c.effects.find((e) => (e as { puppet?: unknown }).puppet)! as never as { puppet: never };
		expect(resolvePuppet(fx.puppet, t).pins[1]!.position[1]).toBeCloseTo(0.7, 6);
	});
	it('other properties read pins by name; mesh params refuse expressions', () => {
		const d = rigged();
		const r = evaluateExpressionText(d.doc, { seq: d.seqId, owner: d.refs.$a!, path: 'transform.rotation' }, 'effect("Puppet")("Puppet Pin 1").position[0] * 100', 0);
		expect(r.error).toBeNull();
		expect(r.value as number).toBeCloseTo(20, 6);
		d.tx([{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.liquify', ref: '$lq' }]);
		expect(() => d.tx([{ type: 'expression.set', target: ['effect', '$lq', 'distortionMesh'], text: '[]' }])).toThrow(/mesh/);
	});
});
