// ui-perf: the memoised expression lookups (per clip / per sequence flags, owner index, owner-scoped location) give
// exactly what a scan of the whole document gives, through random chains of edits.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	documentExpressions,
	documentHasActiveExpressions,
	documentHasAnyExpressions,
	type EffectInstance,
	type ExpressionRef,
	locateExpressionTarget,
	type ProjectDocument,
	paramPathToExpressionRef,
	sequenceAnimatables,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const active = (e: { text: string; enabled: boolean } | undefined) =>
	!!e?.enabled && e.text.trim().length > 0;

/** The pre-ui-perf whole-document scans. */
const reference = {
	any: (doc: ProjectDocument) => !documentExpressions(doc).next().done,
	active: (doc: ProjectDocument) => {
		for (const e of documentExpressions(doc)) if (active(e.expression)) return true;
		return false;
	},
	locate: (doc: ProjectDocument, ref: ExpressionRef) => {
		const seq = doc.sequences[ref.seq];
		if (!seq) return null;
		for (const loc of sequenceAnimatables(ref.seq, seq))
			if (loc.ref.owner === ref.owner && loc.ref.path === ref.path) return loc;
		return null;
	},
	effectOwner: (doc: ProjectDocument, fxId: string) => {
		for (const [seqId, seq] of Object.entries(doc.sequences)) {
			for (const [id, c] of Object.entries(seq.clips))
				if (((c as { effects?: EffectInstance[] }).effects ?? []).some((e) => e.id === fxId))
					return { seq: seqId, owner: id };
			for (const t of [...seq.videoTracks, ...seq.audioTracks])
				if ((t.effects ?? []).some((e) => e.id === fxId)) return { seq: seqId, owner: `track:${t.id}` };
			if (seq.master.effects.some((e) => e.id === fxId)) return { seq: seqId, owner: 'master' };
		}
		return null;
	},
};

describe('memoised expression lookups', () => {
	it('equal the whole-document scans after every edit', () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 99 })), {
					minLength: 1,
					maxLength: 14,
				}),
				(steps) => {
					const h = new Harness();
					const r = h.ok([
						{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
						{ type: 'clip.addSolid', at: 100, duration: 90, track: 'V1', color: [0, 1, 0, 1], ref: '$b' },
						{ type: 'clip.addText', at: 0, duration: 90, track: 'V2', content: { text: 'Hi' }, ref: '$t' },
						{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.slider-control', ref: '$s' },
						{ type: 'effect.add', target: { clipId: '$b' }, effectId: 'jasper.gaussian-blur', ref: '$g' },
					]);
					const { $a: a, $b: b, $t: t, $s: s, $g: g } = r.refs as Record<string, string>;
					for (const [op, n] of steps) {
						const clip = [a, b][n % 2]!;
						switch (op) {
							case 0:
								h.ok([
									{
										type: 'expression.set',
										target: ['clip', clip, 'transform', 'rotation'],
										text: `time*${n}`,
									},
								]);
								break;
							case 1:
								h.tx([{ type: 'expression.clear', target: ['clip', clip, 'transform', 'rotation'] }]);
								break;
							case 2:
								h.tx([
									{
										type: 'expression.setEnabled',
										target: ['clip', clip, 'transform', 'rotation'],
										enabled: n % 2 === 0,
									},
								]);
								break;
							case 3:
								h.ok([
									{ type: 'expression.set', target: ['effect', s, 'slider'], text: n % 3 ? 'time' : ' ' },
								]);
								break;
							case 4:
								h.ok([{ type: 'clip.move', clipIds: [clip], deltaFrames: 1 + (n % 5) }]);
								break;
							case 5:
								h.ok([{ type: 'param.set', target: ['clip', clip, 'opacity'], value: n }]);
								break;
							case 6:
								h.ok([{ type: 'expression.set', target: ['clip', t, 'text', 'content'], text: `"${n}"` }]);
								break;
							default:
								h.tx([{ type: 'effect.remove', effectInstanceId: g }]);
						}
						const doc = h.doc;
						expect(documentHasAnyExpressions(doc)).toBe(reference.any(doc));
						expect(documentHasActiveExpressions(doc)).toBe(reference.active(doc));
						for (const fx of [s, g]) {
							const ref = paramPathToExpressionRef(doc, ['effect', fx, 'slider']);
							const want = reference.effectOwner(doc, fx);
							expect(ref ? { seq: ref.seq, owner: ref.owner } : null).toEqual(want);
						}
						for (const loc of sequenceAnimatables(h.seqId, h.seq))
							expect(locateExpressionTarget(doc, loc.ref)).toEqual(reference.locate(doc, loc.ref));
						expect(locateExpressionTarget(doc, { seq: h.seqId, owner: 'clp_missing', path: 'opacity' })).toBe(
							null,
						);
					}
				},
			),
			{ numRuns: 40 },
		);
	});
});
