// Shape preferences (S11:SHP-007, S03:TXT-020): "Resize shapes by size" (Program monitor handles edit
// `shape.size` instead of Motion scale, so the stroke keeps its width) and the Size link toggle of Properties ▸
// Shape. Per-user UI state in localStorage, never in the project (S05:SH-010).
import { useSyncExternalStore } from 'react';

export type ShapePrefs = {
	/** Handles of a selected shape edit its size instead of Motion scale (default off = Premiere parity). */
	resizeBySize: boolean;
	/** Properties ▸ Shape ▸ Size keeps the aspect ratio when one side is edited. */
	linkSize: boolean;
};

const SHAPE_PREFS_KEY = 'jasper:shape-prefs';
const DEFAULTS: ShapePrefs = { resizeBySize: false, linkSize: false };

function load(): ShapePrefs {
	try {
		const o = JSON.parse(globalThis.localStorage?.getItem(SHAPE_PREFS_KEY) ?? '{}') as Record<
			string,
			unknown
		>;
		return {
			resizeBySize: typeof o.resizeBySize === 'boolean' ? o.resizeBySize : DEFAULTS.resizeBySize,
			linkSize: typeof o.linkSize === 'boolean' ? o.linkSize : DEFAULTS.linkSize,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

let state: ShapePrefs = load();
const listeners = new Set<() => void>();

export const shapePrefs = {
	get: (): ShapePrefs => state,
	set(patch: Partial<ShapePrefs>): void {
		state = { ...state, ...patch };
		try {
			globalThis.localStorage?.setItem(SHAPE_PREFS_KEY, JSON.stringify(state));
		} catch {
			/* storage unavailable: keep in memory */
		}
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function useShapePrefs(): ShapePrefs {
	return useSyncExternalStore(shapePrefs.subscribe, shapePrefs.get, shapePrefs.get);
}
