// three-d: toComp / fromComp / toWorld / fromWorld are 3D-aware — a 3D layer maps through its 3D transform and the
// active camera (After Effects' layer-space transforms of 3D layers).
import type { ExpressionRef } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateExpressionText, loadExpressionEngine, storedTimeAtFrame } from '../src/index.ts';
import { basicDoc, type Doc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

/** Evaluates `text` on the Title's Source Text (a string result keeps every component) and parses the array. */
function val(d: Doc, _owner: string, _path: string, text: string, frame = 60) {
	const ref: ExpressionRef = { seq: d.seqId, owner: d.refs.$title!, path: 'text.content' };
	const r = evaluateExpressionText(d.doc, ref, `JSON.stringify(${text})`, storedTimeAtFrame(d.doc, ref, frame));
	if (r.error) throw new Error(r.error);
	return JSON.parse(String(r.value)) as number[];
}
const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((x, i) => expect(Math.abs(x - b[i]!)).toBeLessThan(eps));

describe('3D layer transforms in expressions', () => {
	it('a 3D layer at its defaults maps like its 2D Motion; toWorld returns [x, y, z]', () => {
		const d = basicDoc();
		d.tx([{ type: 'clip.set3d', clipIds: ['$a'], enabled: true }]);
		close(val(d, '$bg', 'transform.position', 'thisComp.layer("A").toComp([0, 0])').slice(0, 2), [0, 0]);
		close(val(d, '$bg', 'transform.position', 'thisComp.layer("A").toWorld([10, 20])'), [10, 20, 0]);
	});

	it('rotated and pushed back: toWorld / fromWorld and toComp / fromComp round trip', () => {
		const d = basicDoc();
		d.tx([
			{ type: 'clip.set3d', clipIds: ['$a'], enabled: true },
			{ type: 'param.set', target: ['clip', '$a', 'threeD', 'rotationY'], value: 40 },
			{ type: 'param.set', target: ['clip', '$a', 'threeD', 'positionZ'], value: 500 },
		]);
		const w = val(d, '$bg', 'transform.position', 'thisComp.layer("A").toWorld([100, 50])');
		expect(Math.abs(w[2]!)).toBeGreaterThan(1);
		const back = val(d, '$bg', 'transform.position', `thisComp.layer("A").fromWorld([${w.join(',')}])`);
		close(back, [100, 50, 0], 1e-6);
		const c = val(d, '$bg', 'transform.position', 'thisComp.layer("A").toComp([100, 50])');
		const l = val(d, '$bg', 'transform.position', `thisComp.layer("A").fromComp([${c[0]}, ${c[1]}])`);
		close(l.slice(0, 2), [100, 50], 1e-4);
		// The camera depth of a point 500 px behind z = 0 through the default camera (−2666.7): 3166.7.
		expect(val(d, '$bg', 'transform.position', 'thisComp.layer("A").toComp(thisComp.layer("A").transform.anchorPoint)')[2]).toBeCloseTo(3166.6667, 3);
	});

	it('follows the active camera', () => {
		const d = basicDoc();
		d.tx([
			{ type: 'clip.set3d', clipIds: ['$a'], enabled: true },
			{ type: 'clip.addCamera', at: 0, position: [960, 540, -1333.3333333], pointOfInterest: [960, 540, 0] },
		]);
		// Half the default distance: twice the size about the frame centre.
		const p = val(d, '$bg', 'transform.position', 'thisComp.layer("A").toComp([0, 0])');
		close(p.slice(0, 2), [-960, -540], 1e-3);
	});
});
