import { defineProject } from 'vitest/config';

// Loudness standards tests process minutes of 48 kHz audio and need more than Vitest's default timeout on loaded CI.
export default defineProject({
	test: {
		setupFiles: ['../testkit/src/fast-check-setup.ts'],
		include: ['test/**/*.test.ts'],
		environment: 'node',
		testTimeout: 60_000,
	},
});
