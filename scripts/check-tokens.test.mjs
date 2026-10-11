import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkRepo } from './check-tokens.mjs';

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tempRoot = () => {
	const root = mkdtempSync(join(tmpdir(), 'tokens-'));
	roots.push(root);
	return root;
};

it('reports raw UI colors while allowing theme tokens and documented exceptions', () => {
	const root = tempRoot();
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

it('does not silently pass when a source directory cannot be scanned', () => {
	const root = tempRoot();
	mkdirSync(join(root, 'packages/ui'), { recursive: true });
	writeFileSync(join(root, 'packages/ui/src'), 'not a directory');
	expect(() => checkRepo(root)).toThrow(/ENOTDIR/);
});
