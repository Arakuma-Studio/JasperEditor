import { defineProject } from 'vitest/config';
import { hasThreadCpuTimer } from './test/cpu-time.ts';

export default defineProject({
	test: {
		// CPU budgets need an executing-thread clock when workers share a process.
		pool: process.platform === 'linux' && hasThreadCpuTimer() ? 'threads' : 'forks',
		setupFiles: ['../testkit/src/fast-check-setup.ts'],
		include: ['test/**/*.test.ts'],
		environment: 'node',
		testTimeout: 60_000,
	},
});
