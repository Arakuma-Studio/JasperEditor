// @vitest-environment node
// The animation spec requires anime.js in its own cacheable web chunk.
import { describe, expect, it } from 'vitest';
import config from '../vite.config.ts';

describe('web build chunk contract (S11:ANM-023)', () => {
	it('puts anime.js subpath modules in vendor-anime', () => {
		const output = config.build?.rollupOptions?.output;
		const chunk = !Array.isArray(output) ? output?.manualChunks : undefined;
		expect(typeof chunk).toBe('function');
		if (typeof chunk !== 'function') return;
		for (const module of [
			'/repo/node_modules/animejs/dist/modules/timeline/index.js',
			'/repo/node_modules/animejs/dist/modules/svg/index.js',
		]) {
			expect(chunk(module, {} as never)).toBe('vendor-anime');
		}
	});
});
