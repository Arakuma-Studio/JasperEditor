import { describe, expect, it } from 'vitest';
import { Harness } from './helpers.ts';

describe('synthetic references', () => {
	it('keep a synthetic its project item still uses when its last clip goes', () => {
		const h = new Harness({ seed: 9 });
		h.ok([{ type: 'synthetic.create', kind: 'black-video' }]);
		const item = Object.values(h.doc.items).find((it) => it.kind === 'synthetic')!;
		h.ok([{ type: 'clip.place', source: { projectItemId: item.id }, at: 0 }]);
		const clip = h.clips('V1')[0]!.id;
		h.ok([{ type: 'clip.lift', clipIds: [clip] }]);
		expect(h.doc.synthetics[(item as { syntheticId: string }).syntheticId]).toBeDefined();
	});
});
