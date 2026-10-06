import { CACHE_KINDS } from '@jasper/api';
import { describe, expect, it } from 'vitest';
import type { EntryRef } from '../src/cache/layout.ts';
import type { ProjectCacheRefs } from '../src/cache/project-refs.ts';
import { indexProjectCacheRefs } from '../src/cache/reference-index.ts';

const fingerprint = 'a'.repeat(64);
const refs = (keys: string[]): ProjectCacheRefs => ({
	fingerprints: new Set(keys),
	mgRenderKeys: new Set(keys),
	bundleHashes: new Set(keys),
});

describe('cache project reference index', () => {
	it('matches the scan across cache kinds, shared references, and recorded-only references', () => {
		const computed = new Map([
			['project-1', refs([fingerprint, 'render-1', 'bundle-1'])],
			['project-2', refs([fingerprint, 'render-2', 'bundle-1'])],
			['project-3', refs([])],
		]);
		for (const kind of CACHE_KINDS) {
			for (const key of [fingerprint, `${fingerprint}/poster.jpg`, 'render-1', 'bundle-1', 'missing']) {
				const entry: EntryRef = { id: `${kind}:${key}`, kind, key };
				const recorded = new Map([[entry.id, new Set(['recorded-only', 'project-2'])]]);
				const expected = new Set(recorded.get(entry.id));
				for (const [projectId, r] of computed) {
					if (kind === 'media-cache' || kind === 'proxies') {
						if (r.fingerprints.has(key.slice(0, 64))) expected.add(projectId);
					} else if (kind === 'mg-renders') {
						if (r.mgRenderKeys.has(key)) expected.add(projectId);
					} else if (kind === 'mg-posters') {
						if (r.bundleHashes.has(key)) expected.add(projectId);
					}
				}
				// Check insertion order too: existing recorded references precede inferred references.
				expect([...indexProjectCacheRefs(computed, recorded)(entry)]).toEqual([...expected]);
			}
		}
	});

	it('does not mix key namespaces or expose mutable index sets', () => {
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
			const first = lookup(entry);
			expect([...first]).toEqual([project]);
			first.clear();
			first.add('unrelated');
			expect([...lookup(entry)]).toEqual([project]);
		}
	});

	it('rebuilding reflects saved or live project changes and removed projects', () => {
		const computed = new Map([['project', refs([fingerprint])]]);
		const entry: EntryRef = { id: `media-cache:${fingerprint}`, kind: 'media-cache', key: fingerprint };
		expect([...indexProjectCacheRefs(computed, new Map())(entry)]).toEqual(['project']);
		computed.set('project', refs(['b'.repeat(64)]));
		expect([...indexProjectCacheRefs(computed, new Map())(entry)]).toEqual([]);
		computed.set('project', refs([fingerprint]));
		computed.delete('project');
		expect([...indexProjectCacheRefs(computed, new Map())(entry)]).toEqual([]);
	});
});
