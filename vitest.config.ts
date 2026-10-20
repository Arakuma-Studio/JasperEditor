import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// At most 4 test files at once (default: one per core); pass --maxWorkers=N to change.
		maxWorkers: 4,
		projects: ['packages/*', 'apps/*', 'scripts'],
	},
});
