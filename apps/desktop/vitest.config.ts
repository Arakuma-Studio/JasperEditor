import { defineProject } from 'vitest/config';

export default defineProject({
	esbuild: { include: /\.[cm]?tsx?$/ },
	test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
