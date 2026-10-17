import { defineProject } from 'vitest/config';

export default defineProject({
	test: {
		setupFiles: ['../testkit/src/fast-check-setup.ts'],
		include: ['test/**/*.test.{ts,tsx}'],
		environment: 'happy-dom',
	},
});
