import type { ShellStorage } from '../src/shell/workspaces/storage.ts';

/** Test-local storage adapter for persisted workspace fixtures. */
export function memoryStorage(seed: Record<string, string> = {}): ShellStorage {
	const data = new Map(Object.entries(seed));
	return {
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
	};
}
