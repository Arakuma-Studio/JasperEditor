// Small helpers shared by handler files.

import { isDraft } from 'immer';
import type { DDoc, HandlerContext } from '../context.ts';
import type { CommandOf, CommandType } from '../schemas/index.ts';

export type Handler<T extends CommandType> = (doc: DDoc, cmd: CommandOf<T>, h: HandlerContext) => unknown;
export type HandlerMap = { [T in CommandType]?: Handler<T> };

const STUBS = new WeakSet<object>();

/** Handler for a command whose implementation belongs to another work package or milestone. */
export function notImplemented<T extends CommandType>(type: T, owner: string): Handler<T> {
	const stub: Handler<T> = (_doc, _cmd, h) =>
		h.fail('E_NOT_IMPLEMENTED', `${type} is not implemented yet (${owner})`);
	STUBS.add(stub);
	return stub;
}

/** True when the handler is a `notImplemented()` stub (drives `implemented` in the agent schema). */
export function isNotImplementedHandler(handler: unknown): boolean {
	return typeof handler === 'function' && STUBS.has(handler);
}

/** Resolved id list (after `$selection` substitution the schema's union is always an array). */
export function idList(v: readonly string[] | '$selection' | undefined): string[] {
	if (v === undefined) return [];
	if (v === '$selection') return [];
	return [...new Set(v)];
}

/**
 * Reads the OWN property `obj[key]` without creating an Immer draft for it: inside a transaction every property read
 * through a draft creates (and later finalizes) a child draft, so scanning a 5,000-clip document through the draft
 * cost tens of milliseconds per command. The proxy's `getOwnPropertyDescriptor` trap reports the current value — a
 * plain object when the child was not touched in this transaction, the child draft when it was — so scans see every
 * change made by earlier commands. Inherited properties (`constructor`, `__proto__` …) read as undefined. Use for
 * read-only scans; access the found path normally to mutate.
 */
export function peek<T>(obj: object, key: string | number): T | undefined {
	if (isDraft(obj)) return Object.getOwnPropertyDescriptor(obj, key)?.value as T | undefined;
	return Object.hasOwn(obj, key) ? ((obj as Record<string, unknown>)[key] as T) : undefined;
}

/** `Object.keys` of a draft or a plain object (no child drafts are created). */
export const peekKeys = (obj: object): string[] => Object.keys(obj);

/**
 * `compute()` memoized per plain (non-draft) object: records a transaction did not touch are the same frozen objects
 * from one transaction to the next (structural sharing), so per-record summaries can be cached by identity. Drafts
 * change in place and are never cached.
 */
export function memoPlain<T>(cache: WeakMap<object, T>, obj: object, compute: () => T): T {
	if (isDraft(obj)) return compute();
	let v = cache.get(obj);
	if (v === undefined) {
		v = compute();
		cache.set(obj, v);
	}
	return v;
}
