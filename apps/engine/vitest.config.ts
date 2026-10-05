import { defineProject } from 'vitest/config';

export default defineProject({
	test: { include: ['test/**/*.test.ts'], environment: 'node', env: { JASPER_CACHE_AUTO_GC: '0' } },
});
