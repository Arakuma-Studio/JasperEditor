// The engine-backed MCP tests run in parallel workers, and other checkouts run the same suite on the same machine: a
// fixed default port lets one file's jasper-mcp talk to another file's engine (sound-packs and sound-check-ack both
// defaulted to 49563 and failed with ENGINE_NOT_FOUND when they overlapped; Final verification A). Every file takes
// `testPort()` (a free port; its MCP_*_TEST_PORT still pins one).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('MCP test ports', () => {
	it('no test file defaults to a fixed engine port', () => {
		const fixed = readdirSync(here)
			.filter((f) => f.endsWith('.test.ts'))
			.filter((f) => /PORT\s*\?\?\s*\d{4,5}\b/.test(readFileSync(join(here, f), 'utf8')));
		expect(fixed).toEqual([]);
	});
});
