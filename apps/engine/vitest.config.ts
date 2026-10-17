import { defineProject } from 'vitest/config';

export default defineProject({
	test: {
		setupFiles: ['../../packages/testkit/src/fast-check-setup.ts'],
		include: ['test/**/*.test.ts'],
		environment: 'node',
		env: { JASPER_CACHE_AUTO_GC: '0' },
	},
});
