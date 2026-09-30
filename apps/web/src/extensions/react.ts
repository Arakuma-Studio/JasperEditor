// React binding for the extension registries (re-renders hosts when entries are (un)registered).
import { useSyncExternalStore } from 'react';
import type { Registry } from './registry.ts';

export function useRegistry<T extends { id: string; order?: number }>(reg: Registry<T>): readonly T[] {
	return useSyncExternalStore(reg.subscribe, reg.list, reg.list);
}
