// What the model receives must not grow unnoticed: every context stays within eval/budget.json. Lower a budget when its
// context shrinks, and raise one only with an eval case that shows the extra bytes pay.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { measureContexts } from '../eval/measure.ts';

const budget = JSON.parse(readFileSync(new URL('../eval/budget.json', import.meta.url), 'utf8')) as {
	contexts: Record<string, number>;
	tool: number;
};

describe('model-visible bytes', () => {
	it('stay within the budget per context, and no tool outweighs the cap', async () => {
		const { contexts, tools } = await measureContexts();
		const over = contexts
			.filter((c) => c.total > (budget.contexts[c.context] ?? 0))
			.map((c) => `${c.context}: ${c.total} > ${budget.contexts[c.context] ?? 'no budget'}`);
		expect(over).toEqual([]);
		expect(tools.filter((t) => t.total > budget.tool).map((t) => `${t.name}: ${t.total}`)).toEqual([]);
	}, 120_000);
});
