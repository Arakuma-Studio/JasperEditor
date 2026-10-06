import type { EntryRef } from './layout.ts';
import type { ProjectCacheRefs } from './project-refs.ts';

/**
 * Build once per scan, after merging saved and live project references. Classification
 * then visits only matching projects instead of every project for every cache entry.
 * Callers receive their own mutable set; none of these indexes outlive the scan.
 */
export function indexProjectCacheRefs(
	computed: ReadonlyMap<string, ProjectCacheRefs>,
	recorded: ReadonlyMap<string, ReadonlySet<string>>,
): (entry: EntryRef) => Set<string> {
	const fingerprints = new Map<string, Set<string>>();
	const renderKeys = new Map<string, Set<string>>();
	const bundleHashes = new Map<string, Set<string>>();
	const add = (index: Map<string, Set<string>>, keys: ReadonlySet<string>, projectId: string) => {
		for (const key of keys) {
			let projects = index.get(key);
			if (!projects) index.set(key, (projects = new Set()));
			projects.add(projectId);
		}
	};
	for (const [projectId, refs] of computed) {
		add(fingerprints, refs.fingerprints, projectId);
		add(renderKeys, refs.mgRenderKeys, projectId);
		add(bundleHashes, refs.bundleHashes, projectId);
	}
	return (entry) => {
		const out = new Set(recorded.get(entry.id) ?? []);
		const projects =
			entry.kind === 'media-cache' || entry.kind === 'proxies'
				? fingerprints.get(entry.key.slice(0, 64))
				: entry.kind === 'mg-renders'
					? renderKeys.get(entry.key)
					: entry.kind === 'mg-posters'
						? bundleHashes.get(entry.key)
						: undefined;
		if (projects) for (const projectId of projects) out.add(projectId);
		return out;
	};
}
