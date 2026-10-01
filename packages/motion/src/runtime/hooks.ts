// React bindings of the seek-driven runtime (S11:ANM-004/005, ARCHITECTURE §20.2).
// - useAnimeValues: the value engine. The build animates plain objects; the hook seeks canonically during render
//   and hands frozen copies to React, which renders inline styles from them (anime.js never touches the DOM).
// - useAnimeDom: ref-owned SVG leaves (drawables, morphs, motion paths) built in a layout effect inside a scope
//   rooted at the leaf, reverted on cleanup (StrictMode-safe), seeked in a layout effect per time.
import type { DOMTarget } from 'animejs';
import { createScope } from 'animejs/scope';
import { type RefObject, useLayoutEffect, useMemo, useRef } from 'react';
import { seekCanonical, type Timeline } from './timeline.ts';

/**
 * Values handed to React are rounded to 1e-6 (anime.js rounds the strings it writes to 4 decimals, but not plain
 * object numbers): eased from-values carry float noise (`1.0000000000000002`, `-2.7e-15`), so without rounding
 * a unit at rest would not render exactly like the un-animated layer (S11:ANM-009), and tiny numbers stringify in
 * exponent notation, which not every CSS parser accepts in inline styles. `+ 0` turns -0 into 0.
 */
const SCALE = 1e6;
export const roundValue = (v: number): number => (Number.isFinite(v) ? Math.round(v * SCALE) / SCALE + 0 : v);

function snapshot<T extends Record<string, number>>(target: T): Readonly<T> {
	// String keys only: anime.js marks registered targets with a symbol property.
	const copy = {} as Record<string, number>;
	for (const k of Object.keys(target)) copy[k] = roundValue(target[k] as number);
	return Object.freeze(copy) as Readonly<T>;
}

type Built<T> = { timeline: Timeline; targets: T[] };

/** Seeked values per build and seek time (the values are a pure function of both; see `valuesAt`). */
const valueCache = new WeakMap<object, Map<number, readonly unknown[]>>();
/** Distinct seek times remembered per build: a 10 s clip at 60 fps, beyond that the oldest entries go. */
const VALUE_CACHE_SIZE = 600;

/**
 * Frozen copies of the targets of `built` seeked canonically to `ms`. Cached per (build, ms): revisits (scrubbing,
 * StrictMode double renders, Player re-renders of the same frame) return the same frozen array without seeking.
 */
export function valuesAt<T extends Record<string, number>>(
	built: Built<T>,
	ms: number,
): readonly Readonly<T>[] {
	const t = Number.isFinite(ms) ? ms : 0;
	let cache = valueCache.get(built);
	if (!cache) valueCache.set(built, (cache = new Map()));
	const hit = cache.get(t);
	if (hit) return hit as readonly Readonly<T>[];
	seekCanonical(built.timeline, t);
	const values = Object.freeze(built.targets.map(snapshot));
	if (cache.size >= VALUE_CACHE_SIZE) cache.delete(cache.keys().next().value!);
	cache.set(t, values);
	return values;
}

/**
 * Value engine: `build` creates fresh target objects and a paused timeline over them (pure; run once per
 * `buildKey`); every render seeks it canonically to `ms` and returns frozen copies of the targets' values, so the
 * result depends only on (`buildKey`, `ms`), never on the order frames are visited.
 *
 * Safe under StrictMode and concurrent rendering: a discarded or doubled render only re-runs the pure build, and
 * each result is copied right after its own seek, so an interleaved render at another time cannot leak into it.
 */
export function useAnimeValues<T extends Record<string, number>>(
	buildKey: string,
	build: () => Built<T>,
	ms: number,
): readonly Readonly<T>[] {
	// `build` is identified by `buildKey` (callers put everything the build reads into the key).
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by buildKey on purpose
	const built = useMemo(build, [buildKey]);
	return useMemo(() => valuesAt(built, ms), [built, ms]);
}

/** Attribute names of `root` and its descendants before a build (to undo what reverting the scope leaves). */
function attributeNames(root: Element): Map<Element, Set<string>> {
	const out = new Map<Element, Set<string>>();
	for (const el of [root, ...root.querySelectorAll('*')])
		out.set(el, new Set(Array.from(el.attributes, (a) => a.name)));
	return out;
}

/**
 * DOM leaves: `build(root)` runs in a layout effect inside `createScope({root})` once `ready` (fonts loaded,
 * layout final) and again when `buildKey` changes; the scope is reverted on cleanup. The timeline is seeked
 * canonically to `ms` in a layout effect (before paint). `build` may return null (nothing to animate).
 *
 * Every build starts from pristine targets (R-ANM §1/§3): reverting the scope restores animated values, and the
 * attributes the build added outside its tweens (`createDrawable`'s `pathLength`, `stroke-dasharray`…) are
 * removed, so a StrictMode re-mount or a rebuild draws exactly what the first build drew. The leaf element must
 * stay the same node while built (its React attributes that the build reads belong in `buildKey`).
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
		const before = attributeNames(root);
		const scope = createScope({ root: root as unknown as DOMTarget });
		timeline.current = scope.execute(() => buildRef.current(root));
		return () => {
			timeline.current = null;
			scope.revert();
			for (const [el, names] of before)
				for (const a of Array.from(el.attributes)) if (!names.has(a.name)) el.removeAttribute(a.name);
		};
	}, [ref, buildKey, ready]);
	// Re-seek after every rebuild too.
	// biome-ignore lint/correctness/useExhaustiveDependencies: buildKey/ready re-run the seek after a rebuild
	useLayoutEffect(() => {
		if (timeline.current) seekCanonical(timeline.current, ms);
	}, [ms, buildKey, ready]);
}
