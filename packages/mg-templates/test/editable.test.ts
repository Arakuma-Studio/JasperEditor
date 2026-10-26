// Program-monitor editing contract (WP7b canvas-edit): reading `data-template-param` / `data-template-marks`.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readEditableParam, TEMPLATE_MARKS_ATTR, TEMPLATE_PARAM_ATTR } from '../src/index.ts';

const el = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => attrs[n] ?? null });

describe('readEditableParam', () => {
	it('reads the param and the marks flag', () => {
		expect(TEMPLATE_PARAM_ATTR).toBe('data-template-param');
		expect(TEMPLATE_MARKS_ATTR).toBe('data-template-marks');
		expect(readEditableParam(el({ 'data-template-param': 'text', 'data-template-marks': 'true' }))).toEqual({
			param: 'text',
			marks: true,
		});
		expect(readEditableParam(el({ 'data-template-param': 'displayName' }))).toEqual({
			param: 'displayName',
			marks: false,
		});
		expect(
			readEditableParam(el({ 'data-template-param': 'text', 'data-template-marks': 'yes' }))!.marks,
		).toBe(false);
	});

	it('ignores missing and malformed names', () => {
		expect(readEditableParam(el({}))).toBeNull();
		for (const bad of ['', ' ', 'a b', '1abc', 'x'.repeat(65), 'a"]', 'a.b'])
			expect(readEditableParam(el({ 'data-template-param': bad })), bad).toBeNull();
	});

	it('never throws and only returns identifiers (fast-check)', () => {
		fc.assert(
			fc.property(
				fc.string({ unit: 'binary', maxLength: 100 }),
				fc.string({ maxLength: 8 }),
				(name, marks) => {
					const r = readEditableParam(el({ 'data-template-param': name, 'data-template-marks': marks }));
					if (r) {
						expect(r.param).toBe(name);
						expect(/^[A-Za-z_$][\w$]*$/.test(r.param)).toBe(true);
						expect(r.marks).toBe(marks === 'true');
					}
				},
			),
		);
	});
});
