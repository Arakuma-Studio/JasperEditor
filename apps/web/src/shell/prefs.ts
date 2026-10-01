// UI preferences (S05 §2.2 uiPrefsStore, DT-003/005): theme, contrast, density, label preset, tooltips,
// forced layout mode. Stored under the same localStorage key that public/theme-boot.js reads before first
// paint, and applied as data attributes on <html> so switching updates every surface without reload.
import { useSyncExternalStore } from 'react';
import type { LayoutMode } from './layout-mode.ts';

export type UiPrefs = {
	theme: 'darkest' | 'dark';
	contrast: 'normal' | 'high';
	density: 'normal' | 'touch';
	labels: 'default' | 'classic' | 'vibrant';
	tooltips: boolean;
	/** Force a layout mode (MB-001); null = automatic. */
	layoutMode: LayoutMode | null;
	/** Show workspace tabs in the header (WS-012). */
	showWorkspaceTabs: boolean;
};

const UI_PREFS_KEY = 'jasper:ui-prefs';

const DEFAULT_PREFS: UiPrefs = {
	theme: 'darkest',
	contrast: 'normal',
	density: 'normal',
	labels: 'default',
	tooltips: true,
	layoutMode: null,
	showWorkspaceTabs: true,
};

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Tolerant parse: unknown keys and bad values fall back to defaults. */
export function parsePrefs(raw: unknown): UiPrefs {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	return {
		theme: pick(o.theme, ['darkest', 'dark'], 'darkest'),
		contrast: pick(o.contrast, ['normal', 'high'], 'normal'),
		density: pick(o.density, ['normal', 'touch'], 'normal'),
		labels: pick(o.labels, ['default', 'classic', 'vibrant'], 'default'),
		tooltips: typeof o.tooltips === 'boolean' ? o.tooltips : true,
		layoutMode:
			o.layoutMode === null || o.layoutMode === undefined
				? null
				: pick<LayoutMode>(o.layoutMode, ['desktop', 'compact', 'tablet', 'phone'], 'desktop'),
		showWorkspaceTabs: typeof o.showWorkspaceTabs === 'boolean' ? o.showWorkspaceTabs : true,
	};
}

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

function load(): UiPrefs {
	try {
		return parsePrefs(JSON.parse(storage()?.getItem(UI_PREFS_KEY) ?? '{}'));
	} catch {
		return { ...DEFAULT_PREFS };
	}
}

/** Applies the prefs as data attributes on the root element (DT-003/005). */
export function applyPrefs(
	p: UiPrefs,
	el: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
	if (!el) return;
	el.setAttribute('data-pr-theme', p.theme);
	el.setAttribute('data-pr-contrast', p.contrast);
	el.setAttribute('data-pr-density', p.density);
	el.setAttribute('data-pr-labels', p.labels);
}

let state: UiPrefs = load();
const listeners = new Set<() => void>();

export const prefsStore = {
	get: (): UiPrefs => state,
	set(patch: Partial<UiPrefs>): void {
		state = { ...state, ...patch };
		try {
			storage()?.setItem(UI_PREFS_KEY, JSON.stringify(state));
		} catch {
			/* quota / private mode: keep in memory */
		}
		applyPrefs(state);
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function useUiPrefs(): UiPrefs {
	return useSyncExternalStore(prefsStore.subscribe, prefsStore.get, prefsStore.get);
}
