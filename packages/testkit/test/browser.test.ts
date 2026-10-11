import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { bundleForBrowser } from '../src/browser.ts';

it('bundles TypeScript with definitions and an optional browser global', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'testkit-browser-'));
	try {
		const entry = join(dir, 'entry.ts');
		writeFileSync(entry, 'export const value: string = process.env.NODE_ENV + suffix;');
		const script = await bundleForBrowser(entry, { suffix: '"-fixture"' }, { globalName: 'Fixture' });
		const result: { value: string } = runInNewContext(`${script}\nFixture`);
		expect(result.value).toBe('production-fixture');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
