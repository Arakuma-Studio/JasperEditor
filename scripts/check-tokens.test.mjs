import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkRepo } from './check-tokens.mjs';

it('reports raw UI colors while allowing theme tokens and documented exceptions', () => {
	const root = mkdtempSync(join(tmpdir(), 'tokens-'));
	mkdirSync(join(root, 'packages/ui/src/theme'), { recursive: true });
	mkdirSync(join(root, 'apps/web/src/shell'), { recursive: true });
	writeFileSync(join(root, 'packages/ui/src/theme/tokens.css'), ':root { --pr-bg-app: #000000; }');
	writeFileSync(join(root, 'apps/web/src/shell/Brand.tokens.ts'), "export const color = '#ffffff';");
	writeFileSync(
		join(root, 'apps/web/src/shell/Bad.tsx'),
		"export const x = <div className='bg-neutral-800' style={{ color: '#ff0000' }} />;\n" +
			"export const data = '#00ff00'; // tokens-allow: document color\n",
	);
	expect(checkRepo(root).map(({ file, rule, line }) => ({ file, rule, line }))).toEqual([
		{ file: 'apps/web/src/shell/Bad.tsx', rule: 'hex-color', line: 1 },
		{ file: 'apps/web/src/shell/Bad.tsx', rule: 'tailwind-palette', line: 1 },
	]);
});
