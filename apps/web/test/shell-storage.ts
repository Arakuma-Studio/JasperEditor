import type { ShellStorage } from '../src/shell/workspaces/storage.ts';

export function memoryStorage(seed: Record<string, string> = {}): ShellStorage {
	const data = new Map(Object.entries(seed));
	return {
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
	};
}
