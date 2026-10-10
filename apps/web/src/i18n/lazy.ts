// Lazy labels (workstream polish, live language switching): tables built once at module load (menus, commands) keep
// the English source of a label and translate it when the label is read, so they follow a language change.
import { __set, t } from './runtime.ts';

/** A label: the English source (translated when read) or a function that builds it (called on every read). */
export type LazyLabel = string | (() => string);

export const readLabel = (label: LazyLabel): string => (typeof label === 'function' ? label() : t(label));

/** Defines `key` on `target` as a property that reads `label` lazily (assignable, like the transform's getters). */
export function defineLazyLabel<T extends object>(target: T, key: string, label: LazyLabel): T {
	Object.defineProperty(target, key, {
		get: () => readLabel(label),
		set(this: object, v: unknown) {
			__set(this, key, v);
		},
		enumerable: true,
		configurable: true,
	});
	return target;
}

/**
 * `Object.assign` that copies property descriptors: lazy label getters of the sources stay lazy (a spread or
 * `Object.assign` would read them once, in the language of that moment).
 */
export function assignLazy<T extends object>(target: T, ...sources: (object | undefined)[]): T {
	for (const s of sources) if (s) Object.defineProperties(target, Object.getOwnPropertyDescriptors(s));
	return target;
}
