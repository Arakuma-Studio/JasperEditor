// Code-split panel bodies (ARCHITECTURE §13 "Startup": dynamic import per panel component, S05:PERF-001).
// The dock renders them inside <Suspense> with a skeleton, so the shell paints before panel code loads.
import { type ComponentType, type LazyExoticComponent, lazy } from 'react';
import type { PanelProps } from './types.ts';

type PanelModule<K extends string> = Record<K, ComponentType<PanelProps>>;

/** `lazyPanel(() => import('./X.tsx'), 'X')`: the named export `X` as a lazily loaded panel component. */
export function lazyPanel<K extends string>(
	load: () => Promise<PanelModule<K>>,
	name: K,
): LazyExoticComponent<ComponentType<PanelProps>> {
	return lazy(() => load().then((m) => ({ default: m[name] })));
}
