import { defineProject } from 'vitest/config';

// The integration suite boots a real engine and jasper-mcp processes (renders and exports included).
export default defineProject({
	test: {
		setupFiles: ['../../packages/testkit/src/fast-check-setup.ts'],
		include: ['test/**/*.test.ts', 'eval/**/*.test.ts'],
		environment: 'node',
		testTimeout: 300_000,
		// The suites exercise every toolset; a session advertises only core by default (spec 18 AF-CTX-001), so the
		// in-process servers here advertise all. toolsets.test.ts covers the default with an explicit `core`.
		env: { JASPER_MCP_TOOLSETS: 'all' },
		hookTimeout: 180_000,
	},
});
