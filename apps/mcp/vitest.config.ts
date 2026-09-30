import { defineProject } from 'vitest/config';

// The integration suite boots a real engine and jasper-mcp processes (renders and exports included).
export default defineProject({
	test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 300_000, hookTimeout: 180_000 },
});
