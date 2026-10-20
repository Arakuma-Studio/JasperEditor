import { defineProject } from 'vitest/config';

export default defineProject({
	esbuild: { include: /\.[cm]?tsx?$/ },
	test: {
		setupFiles: ['../../packages/testkit/src/fast-check-setup.ts'],
		include: ['test/**/*.test.ts'],
		environment: 'node',
	},
});
