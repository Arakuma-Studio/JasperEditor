// docs/expressions.md carries the generated language reference; the reference names functions the prelude defines.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PRELUDE } from '../src/prelude.ts';
import { EXPRESSION_REFERENCE, expressionReferenceMarkdown } from '../src/reference.ts';

it('docs/expressions.md ends with the generated reference', () => {
	const doc = readFileSync(join(__dirname, '../../../docs/expressions.md'), 'utf8');
	expect(doc.trimEnd().endsWith(expressionReferenceMarkdown().trimEnd())).toBe(true);
});

it('every global in the reference exists in the prelude', () => {
	for (const e of EXPRESSION_REFERENCE.filter((r) => r.scope === 'global' && r.name !== 'Math'))
		expect(
			PRELUDE.includes(`function ${e.name}(`) ||
				PRELUDE.includes(`var ${e.name}`) ||
				PRELUDE.includes(`'${e.name}'`) ||
				PRELUDE.includes(`__global('${e.name}'`),
			e.name,
		).toBe(true);
});
