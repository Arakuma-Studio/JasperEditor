import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempAppdir(prefix = 'jasper-engine-'): string {
	return mkdtempSync(join(tmpdir(), prefix));
}
