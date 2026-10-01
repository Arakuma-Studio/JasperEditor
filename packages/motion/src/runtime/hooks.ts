// React bindings of the seek-driven runtime (S11:ANM-004/005, ARCHITECTURE §20.2).
// - useAnimeValues: the value engine. The build animates plain objects; the hook seeks canonically during render
//   and hands frozen copies to React, which renders inline styles from them (anime.js never touches the DOM).
// - useAnimeDom: ref-owned SVG leaves (drawables, morphs, motion paths) built in a layout effect inside a scope
//   rooted at the leaf, reverted on cleanup (StrictMode-safe), seeked in a layout effect per time.
import type { DOMTarget } from 'animejs';
import { createScope } from 'animejs/scope';
import { type RefObject, useLayoutEffect, useMemo, useRef } from 'react';
import { seekCanonical, type Timeline } from './timeline.ts';

function snapshot<T extends Record<string, number>>(target: T): Readonly<T> {
	// String keys only: anime.js marks registered targets with a symbol property.
	const copy = {} as Record<string, number>;
	for (const k of Object.keys(target)) copy[k] = target[k] as number;
	return Object.freeze(copy) as Readonly<T>;
}

/**
 * Value engine: `build` creates fresh target objects and a paused timeline over them (pure; run once per
 * `buildKey`); every render seeks it canonically to `ms` and returns frozen copies of the targets' values, so the
 * result depends only on (`buildKey`, `ms`), never on the order frames are visited.
 */
export function useAnimeValues<T extends Record<string, number>>(
	buildKey: string,
	build: () => { timeline: Timeline; targets: T[] },
	ms: number,
): readonly Readonly<T>[] {
	// `build` is identified by `buildKey` (callers put everything the build reads into the key).
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by buildKey on purpose
	const built = useMemo(build, [buildKey]);
	return useMemo(() => {
		seekCanonical(built.timeline, ms);
		return Object.freeze(built.targets.map(snapshot));
	}, [built, ms]);
}

/**
 * DOM leaves: `build(root)` runs in a layout effect inside `createScope({root})` once `ready` (fonts loaded,
 * layout final) and again when `buildKey` changes; the scope is reverted on cleanup. The timeline is seeked
 * canonically to `ms` in a layout effect (before paint). `build` may return null (nothing to animate).
 */
export function useAnimeDom<E extends Element>(
	ref: RefObject<E | null>,
	buildKey: string,
	build: (root: E) => Timeline | null,
	ms: number,
	ready: boolean,
): void {
	const timeline = useRef<Timeline | null>(null);
	const buildRef = useRef(build);
	buildRef.current = build;
	// Rebuilt when the key or readiness changes (`build` itself is read through a ref).
	// biome-ignore lint/correctness/useExhaustiveDependencies: buildKey identifies the build
	useLayoutEffect(() => {
		const root = ref.current;
		if (!ready || !root) return;
		const scope = createScope({ root: root as unknown as DOMTarget });
		timeline.current = scope.execute(() => buildRef.current(root));
		return () => {
			timeline.current = null;
			scope.revert();
		};
	}, [ref, buildKey, ready]);
	// Re-seek after every rebuild too.
	// biome-ignore lint/correctness/useExhaustiveDependencies: buildKey/ready re-run the seek after a rebuild
	useLayoutEffect(() => {
		if (timeline.current) seekCanonical(timeline.current, ms);
	}, [ms, buildKey, ready]);
}
