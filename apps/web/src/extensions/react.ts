// React binding for the extension registries (re-renders hosts when entries are (un)registered).
import type { Clip } from '@jasper/project';
import { useSyncExternalStore } from 'react';
import { type ClipBadgeState, clipBadgeFor, clipBadgeProviders } from './index.ts';
import type { Registry } from './registry.ts';

export function useRegistry<T extends { id: string; order?: number }>(reg: Registry<T>): readonly T[] {
	return useSyncExternalStore(reg.subscribe, reg.list, reg.list);
}

// ui-perf: one subscription to the providers for every clip view (each used to subscribe on its own, and a
// provider's subscription may run a timer: hundreds of them on a long timeline, re-created on every scroll).
const badgeListeners = new Set<() => void>();
let badgeOff: (() => void) | null = null;
const notifyBadges = () => {
	for (const l of [...badgeListeners]) l();
};
function subscribeProviders(): () => void {
	let offs: ((() => void) | undefined)[] = [];
	const attach = () => {
		for (const off of offs) off?.();
		offs = clipBadgeProviders.list().map((p) => p.subscribe?.(notifyBadges));
	};
	attach();
	const offRegistry = clipBadgeProviders.subscribe(() => {
		attach();
		notifyBadges();
	});
	return () => {
		offRegistry();
		for (const off of offs) off?.();
		offs = [];
	};
}
const badgeSubscribe = (cb: () => void) => {
	badgeListeners.add(cb);
	badgeOff ??= subscribeProviders();
	return () => {
		badgeListeners.delete(cb);
		if (badgeListeners.size === 0 && badgeOff) {
			badgeOff();
			badgeOff = null;
		}
	};
};
const badgeVersion = () => clipBadgeProviders.list().reduce((n, p) => n * 31 + (p.version?.() ?? 0), 0);

/** The provider badge of a clip (M2, wp-m2-mg); re-renders when a provider's state changes. */
export function useClipBadge(clip: Clip): ClipBadgeState | null {
	useSyncExternalStore(badgeSubscribe, badgeVersion, badgeVersion);
	return clipBadgeFor(clip);
}
