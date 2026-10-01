// React binding for the extension registries (re-renders hosts when entries are (un)registered).
import type { Clip } from '@jasper/project';
import { useSyncExternalStore } from 'react';
import { type ClipBadgeState, clipBadgeFor, clipBadgeProviders } from './index.ts';
import type { Registry } from './registry.ts';

export function useRegistry<T extends { id: string; order?: number }>(reg: Registry<T>): readonly T[] {
	return useSyncExternalStore(reg.subscribe, reg.list, reg.list);
}

const badgeSubscribe = (cb: () => void) => {
	const offs = [clipBadgeProviders.subscribe(cb), ...clipBadgeProviders.list().map((p) => p.subscribe?.(cb))];
	return () => {
		for (const off of offs) off?.();
	};
};
const badgeVersion = () => clipBadgeProviders.list().reduce((n, p) => n * 31 + (p.version?.() ?? 0), 0);

/** The provider badge of a clip (M2, wp-m2-mg); re-renders when a provider's state changes. */
export function useClipBadge(clip: Clip): ClipBadgeState | null {
	useSyncExternalStore(badgeSubscribe, badgeVersion, badgeVersion);
	return clipBadgeFor(clip);
}
