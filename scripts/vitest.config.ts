import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		setupFiles: ['../packages/testkit/src/fast-check-setup.ts'],
		name: 'scripts',
		include: ['**/*.test.{ts,mjs}'],
	},
});
