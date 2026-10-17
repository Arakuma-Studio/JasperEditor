import { defineProject } from 'vitest/config';

export default defineProject({
	test: {
		setupFiles: ['src/fast-check-setup.ts'],
		include: ['test/**/*.test.ts'],
		environment: 'node',
		testTimeout: 60_000,
	},
});
