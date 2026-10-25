import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const created: string[] = [];

// Imported before suite teardown hooks: Vitest's stack order closes servers and
// workers first. Keep directories until the file ends to support restart tests.
afterAll(async () => {
	for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

export function tempAppdir(prefix = 'jasper-engine-'): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}
