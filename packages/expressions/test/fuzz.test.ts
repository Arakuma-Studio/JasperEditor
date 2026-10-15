import type { ExpressionRef } from '@jasper/project';
import { describeFuzz, textTarget } from '@jasper/testkit/fuzz';
import { beforeAll } from 'vitest';
import {
	checkExpressionSyntax,
	evaluateExpressionText,
	loadExpressionEngine,
	storedTimeAtFrame,
} from '../src/index.ts';
import { basicDoc } from './fixture.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

const SEEDS = [
	'wiggle(2, 30)',
	'loopOut("cycle")',
	'thisComp.layer("Bg").transform.opacity * 0.5 + time * 10',
	'var s = effect("Slider Control")("Slider"); linear(time, 0, 2, 0, s)',
	'[value[0] + Math.sin(time) * 20, value[1]]',
	'if (time > 1) { ease(time, 1, 2, 0, 360) } else { 0 }',
	'text.sourceText.toUpperCase() + " " + timeToTimecode()',
	'posterizeTime(12); random(0, 100)',
	'seedRandom(index, true); clamp(valueAtTime(time - 0.5), 0, 100)',
	'thisLayer.toComp([0, 0])',
	'function f(x) { return x * 2 } f(3)',
	'String.raw`a` + thisComp.name',
];

describeFuzz('@jasper/expressions', [
	textTarget('syntax check (message or null)', SEEDS, (t) => {
		const s = checkExpressionSyntax(t);
		if (s !== null && typeof s !== 'string') throw new Error('syntax check did not return a message');
	}),
	textTarget(
		'evaluate on a document (value or message)',
		SEEDS,
		(() => {
			const d = basicDoc();
			const refs: ExpressionRef[] = [
				{ seq: d.seqId, owner: d.refs.$a!, path: 'transform.rotation' },
				{ seq: d.seqId, owner: d.refs.$a!, path: 'transform.position' },
				{ seq: d.seqId, owner: d.refs.$title!, path: 'text.content' },
			];
			let i = 0;
			return (t: string) => {
				const ref = refs[i++ % refs.length]!;
				const r = evaluateExpressionText(d.doc, ref, t, storedTimeAtFrame(d.doc, ref, 45));
				if (r.error !== null && typeof r.error !== 'string') throw new Error('error is not a message');
			};
		})(),
		undefined,
		{ iterations: 250, properties: 80, slowMs: 3000 },
	),
]);
