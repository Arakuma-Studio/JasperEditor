import { describe, expect, it } from 'vitest';
import type { EntryRef } from '../src/cache/layout.ts';
import { indexProjectCacheRefs } from '../src/cache/reference-index.ts';

const fingerprint = 'a'.repeat(64);

describe('cache project reference index', () => {
	it('does not mix references with the same key in different cache namespaces', () => {
		const computed = new Map([
			[
				'media',
				{
					fingerprints: new Set([fingerprint]),
					mgRenderKeys: new Set<string>(),
					bundleHashes: new Set<string>(),
				},
			],
			[
				'render',
				{
					fingerprints: new Set<string>(),
					mgRenderKeys: new Set([fingerprint]),
					bundleHashes: new Set<string>(),
				},
			],
			[
				'bundle',
				{
					fingerprints: new Set<string>(),
					mgRenderKeys: new Set<string>(),
					bundleHashes: new Set([fingerprint]),
				},
			],
		]);
		const lookup = indexProjectCacheRefs(computed, new Map());
		for (const [kind, project] of [
			['media-cache', 'media'],
			['proxies', 'media'],
			['mg-renders', 'render'],
			['mg-posters', 'bundle'],
		] as const) {
			const entry: EntryRef = { id: `${kind}:${fingerprint}`, kind, key: fingerprint };
			expect([...lookup(entry)]).toEqual([project]);
		}
	});
});
