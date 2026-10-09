// Incremental JSON serialisation (workstream ui-perf, docs/performance.md §5): autosave and the crash-recovery journal
// write the whole project (8 MB on the 200-sequence / 5 000-clip scale project, ≈ 100 ms of `JSON.stringify` on the
// main thread). Documents are immutable and Immer freezes every document a transaction produces (untouched subtrees
// included), so the JSON text of a frozen subtree never changes: `stringifyJson` keeps it per object and an autosave
// after an edit only serialises the objects the edit replaced (the clip, its `clips` map, its sequence, …) and joins
// the cached text of everything else.
//
// The output is exactly `JSON.stringify(value)` (no indentation): same key order, same treatment of `undefined`,
// functions, symbols, non-finite numbers, `toJSON`, boxed primitives, `BigInt` (throws) and cycles (throws). Only
// deeply frozen objects are cached, so an object that can still change is always serialised afresh.
// Property-tested against `JSON.stringify` (packages/project/test/json-cache.test.ts).

/** JSON text of deeply frozen objects. */
const textCache = new WeakMap<object, string>();
/** Objects known to be deeply frozen (a final verdict: nothing below a deeply frozen object can change). */
const deepFrozen = new WeakSet<object>();
/** Containers with more entries than this are composed from their entries' (cached) text; smaller ones in one go. */
const COMPOSE_MIN_ENTRIES = 64;

function isDeepFrozen(o: object): boolean {
	if (deepFrozen.has(o)) return true;
	if (!Object.isFrozen(o)) return false;
	for (const k of Object.keys(o)) {
		const v = (o as Record<string, unknown>)[k];
		if (v !== null && typeof v === 'object' && !isDeepFrozen(v)) return false;
	}
	deepFrozen.add(o);
	return true;
}

const isBoxed = (v: object) =>
	v instanceof Number || v instanceof String || v instanceof Boolean || v instanceof BigInt;

function ser(value: unknown, key: string, stack: Set<object>): string | undefined {
	let v = value;
	if (v !== null && (typeof v === 'object' || typeof v === 'bigint')) {
		const toJSON = (v as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === 'function') v = toJSON.call(v, key);
	}
	if (v === null || typeof v !== 'object' || isBoxed(v)) return JSON.stringify(v);
	const o = v as object;
	const hit = textCache.get(o);
	if (hit !== undefined) return hit;
	if (stack.has(o)) throw new TypeError('Converting circular structure to JSON');
	const keys = Array.isArray(o) ? null : Object.keys(o);
	const entries = keys ? keys.length : (o as unknown[]).length;
	const frozen = isDeepFrozen(o);
	let text: string;
	if (entries < COMPOSE_MIN_ENTRIES && !composeSmall(o, keys)) {
		// Small, with small children: the native serialiser is faster than composing.
		text = JSON.stringify(o);
	} else {
		stack.add(o);
		try {
			// String concatenation (not `join`): V8 builds ropes, so joining the cached text of unchanged entries copies
			// nothing; the whole text is flattened once, when it is sent.
			if (keys === null) {
				const arr = o as unknown[];
				text = '[';
				for (let i = 0; i < arr.length; i++)
					text += (i ? ',' : '') + (ser(arr[i], String(i), stack) ?? 'null');
				text += ']';
			} else {
				text = '{';
				let first = true;
				for (const k of keys) {
					const s = ser((o as Record<string, unknown>)[k], k, stack);
					if (s === undefined) continue;
					text += `${first ? '' : ','}${JSON.stringify(k)}:${s}`;
					first = false;
				}
				text += '}';
			}
		} finally {
			stack.delete(o);
		}
	}
	if (frozen) textCache.set(o, text);
	return text;
}

/**
 * Whether a small container should still be composed: something within a few levels below it is cached already or is
 * a container worth composing (the envelope around a document, the document around its sequences).
 */
function composeSmall(o: object, keys: string[] | null, depth = 3): boolean {
	const vals = keys ? keys.map((k) => (o as Record<string, unknown>)[k]) : (o as unknown[]);
	for (const c of vals) {
		if (c === null || typeof c !== 'object') continue;
		if (textCache.has(c)) return true;
		const ck = Array.isArray(c) ? null : Object.keys(c);
		if ((ck ? ck.length : (c as unknown[]).length) >= COMPOSE_MIN_ENTRIES) return true;
		if (depth > 1 && composeSmall(c, ck, depth - 1)) return true;
	}
	return false;
}

/**
 * `JSON.stringify(value)` with the text of deeply frozen objects (Immer documents) cached by identity. Returns
 * `undefined` where `JSON.stringify` does (a top-level `undefined`, function or symbol).
 */
export function stringifyJson(value: unknown): string {
	return ser(value, '', new Set()) as string;
}
