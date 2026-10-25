// v7 → v8: Crop applies in stack order from v8 on; v7 always applied it first, so the step moves listed-later
// Crop effects to the front and v7 projects keep their look (docs/project-files.md, schema history).
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/index.ts';

type Rec = Record<string, unknown>;
const step = MIGRATIONS.find((m) => m.from === 7)!;
const fx = (id: string, effectId: string) => ({ id, effectId, effectVersion: 1, enabled: true, params: {} });
const run = (effects: unknown) => {
	const doc: Rec = { sequences: { s: { clips: { c: { kind: 'video', effects } } } } };
	return ((((step.migrate(doc).sequences as Rec).s as Rec).clips as Rec).c as Rec).effects;
};

describe('migration v7 → v8 (Crop in stack order)', () => {
	it('moves Crop effects listed after others to the front, keeping both groups in order', () => {
		const out = run([
			fx('a', 'jasper.mirror'),
			fx('b', 'jasper.crop'),
			fx('c', 'jasper.gaussian-blur'),
			fx('d', 'jasper.crop'),
		]);
		expect((out as Rec[]).map((e) => e.id)).toEqual(['b', 'd', 'a', 'c']);
	});
	it('leaves stacks whose Crop effects are already first, or that have none, untouched', () => {
		const first = [fx('b', 'jasper.crop'), fx('a', 'jasper.mirror')];
		expect(run(first)).toEqual(first);
		const none = [fx('a', 'jasper.mirror')];
		expect(run(none)).toEqual(none);
		expect(run([fx('b', 'jasper.crop')])).toHaveLength(1);
	});
	it('ignores malformed documents instead of throwing', () => {
		expect(() =>
			step.migrate({ sequences: { s: null, t: { clips: { c: null, d: { effects: 'x' } } } } }),
		).not.toThrow();
		expect(() => step.migrate({})).not.toThrow();
		expect(run([null, 3, fx('b', 'jasper.crop')])).toEqual([fx('b', 'jasper.crop'), null, 3]);
	});
});
