// Code-split panel bodies (ARCHITECTURE §13 "Startup": dynamic import per panel component, S05:PERF-001).
// The dock shows a skeleton until a panel's code has loaded, so the shell paints before panel code does.
//
// polish: a panel is mounted through state once its module has loaded (`useLoaded`), not through React.lazy +
// <Suspense>. A Suspense retry renders in a lane React never lets expire and restarts whenever any other update
// arrives; with updates arriving faster than the panel renders (job progress events while the machine is busy), the
// panel never appeared — the skeleton stayed for minutes and every abandoned attempt of the Program monitor left
// eight <audio> elements behind (Chrome then refused new media players). A state update renders in a blocking lane
// and cannot be starved. The lazy component is kept for callers that render one inside their own <Suspense>.
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

type LoadState<P> =
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

type LazyPanel = LazyExoticComponent<ComponentType<PanelProps>> & Loadable<PanelProps>;

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
