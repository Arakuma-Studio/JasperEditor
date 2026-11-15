import { defineProject } from 'vitest/config';

export default defineProject({
	test: {
		setupFiles: ['../../packages/testkit/src/fast-check-setup.ts'],
		include: ['test/**/*.test.ts'],
		environment: 'node',
		// engine tests run real ffmpeg exports and engines; 5 s is too short for one on any machine
		testTimeout: 120_000,
		env: { JASPER_CACHE_AUTO_GC: '0' },
	},
});
