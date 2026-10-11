// Use a state update to mount loaded panels: frequent job events can starve Suspense retries
// and repeatedly allocate media players. Callers with their own Suspense boundary can use the lazy component.
import { type ComponentType, type LazyExoticComponent, lazy, useEffect, useState } from 'react';
import type { PanelProps } from './types.ts';

type PanelModule<K extends string> = Record<K, ComponentType<PanelProps>>;

/** A code-split component that can also be loaded explicitly. */
export type Loadable<P> = {
	/** Starts (or joins) the download; a failed download is tried again by the next call. */
	load(): Promise<ComponentType<P>>;
	/** The component once it has loaded, else null. */
	loaded(): ComponentType<P> | null;
};

/** Wraps a dynamic import: one download shared by every caller, retried after a failure. */
export function loadable<P>(load: () => Promise<ComponentType<P>>): Loadable<P> {
	let promise: Promise<ComponentType<P>> | null = null;
	let component: ComponentType<P> | null = null;
	return {
		load() {
			promise ??= load().then(
				(c) => {
					component = c;
					return c;
				},
				(e) => {
					promise = null;
					throw e;
				},
			);
			return promise;
		},
		loaded: () => component,
	};
}

export type LoadState<P> =
	| { status: 'loading' }
	| { status: 'ready'; Component: ComponentType<P> }
	| { status: 'failed'; error: unknown };

/** The component of `source` once loaded, through state (see the header for why not Suspense). */
export function useLoaded<P>(source: Loadable<P>): LoadState<P> {
	const [state, setState] = useState<LoadState<P>>(() => {
		const c = source.loaded();
		return c ? { status: 'ready', Component: c } : { status: 'loading' };
	});
	useEffect(() => {
		const c = source.loaded();
		if (c) {
			setState((s) => (s.status === 'ready' && s.Component === c ? s : { status: 'ready', Component: c }));
			return;
		}
		let live = true;
		setState((s) => (s.status === 'loading' ? s : { status: 'loading' }));
		source.load().then(
			(Component) => live && setState({ status: 'ready', Component }),
			(error) => live && setState({ status: 'failed', error }),
		);
		return () => {
			live = false;
		};
	}, [source]);
	return state;
}

export type LazyPanel = LazyExoticComponent<ComponentType<PanelProps>> & Loadable<PanelProps>;

/** Whether a panel component can be loaded explicitly (every `lazyPanel` can). */
export function isLoadable(c: unknown): c is Loadable<PanelProps> {
	return (
		!!c &&
		typeof (c as Partial<Loadable<PanelProps>>).load === 'function' &&
		typeof (c as Partial<Loadable<PanelProps>>).loaded === 'function'
	);
}

/** `lazyPanel(() => import('./X.tsx'), 'X')`: the named export `X` as a lazily loaded panel component. */
export function lazyPanel<K extends string>(load: () => Promise<PanelModule<K>>, name: K): LazyPanel {
	const source = loadable<PanelProps>(() =>
		load().then((m) => {
			const c = m[name];
			if (!c) throw new Error(`The panel module has no export “${name}”`);
			return c;
		}),
	);
	const component = lazy(() => source.load().then((c) => ({ default: c }))) as LazyPanel;
	component.load = source.load;
	component.loaded = source.loaded;
	return component;
}
