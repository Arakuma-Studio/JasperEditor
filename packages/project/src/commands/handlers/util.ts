import { current, type Draft, isDraft } from 'immer';
import type { EffectInstance } from '../../schema/sequence.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { latest } from '../draft-read.ts';
import type { CommandOf, CommandType } from '../schemas/index.ts';

export type ClipEffectLocation = { seq: DSeq; clip: DClip; fx: Draft<EffectInstance> };

export type Handler<T extends CommandType> = (doc: DDoc, cmd: CommandOf<T>, h: HandlerContext) => unknown;
export type HandlerMap = { [T in CommandType]?: Handler<T> };

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
	// the draft's current object read directly (draft-read.ts `latest`): the same value as the trap
	// reports, without a trap call per read.
	const raw = latest(obj) as Record<string | number, unknown>;
	return Object.hasOwn(raw, key) ? (raw[key] as T) : undefined;
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

export function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(isDraft(value) ? current(value as Draft<T>) : value)) as T;
}
