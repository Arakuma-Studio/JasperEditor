import { expect, it } from 'vitest';
import { checkExpressionSyntax } from '../src/index.ts';

it('rejects deep nesting instead of overflowing', () => {
	for (const count of [65, 1000, 100_000]) {
		const parens = `${'('.repeat(count)}1${')'.repeat(count)}`;
		expect(checkExpressionSyntax(parens)).toMatch(/nested too deeply/);
	}
	expect(checkExpressionSyntax(`${'('.repeat(62)}a + b${')'.repeat(62)}`)).toBeNull();
});
