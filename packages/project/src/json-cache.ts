// Incremental JSON serialisation (docs/performance.md §5): autosave and the crash-recovery journal
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

/** JSON text of deeply frozen objects (an entry implies the object is deeply frozen). */
const textCache = new WeakMap<object, string>();
/**
 * Which containers are composed from their entries' (cached) text: every container in the top `COMPOSE_DEPTH` levels
 * (envelope, document, its records, a sequence) and deeper ones with at least `COMPOSE_MIN_ENTRIES` entries (a long
 * `clips` record); everything else is serialised in one native call and cached as a whole.
 */
const COMPOSE_DEPTH = 4;
const COMPOSE_MIN_ENTRIES = 64;

/** Whether nothing in `o` can change (a subtree serialised natively; no bookkeeping per object). */
function deepFrozen(o: object, stack: Set<object>): boolean {
	if (textCache.has(o)) return true;
	if (!Object.isFrozen(o) || stack.has(o)) return false;
	stack.add(o);
	try {
		for (const k of Object.keys(o)) {
			const v = (o as Record<string, unknown>)[k];
			if (v !== null && typeof v === 'object' && !deepFrozen(v, stack)) return false;
		}
		return true;
	} finally {
		stack.delete(o);
	}
}

const isBoxed = (v: object) =>
	v instanceof Number || v instanceof String || v instanceof Boolean || v instanceof BigInt;

/** Text of one value and whether it is deeply frozen (so its container may be cached too). */
type Out = { text: string | undefined; frozen: boolean };

function ser(value: unknown, key: string, stack: Set<object>, depth: number): Out {
	let v = value;
	if (v !== null && (typeof v === 'object' || typeof v === 'bigint')) {
		const toJSON = (v as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === 'function') v = toJSON.call(v, key);
	}
	// toJSON results are not the object itself: never cache through them.
	const viaToJSON = v !== value;
	if (v === null || typeof v !== 'object' || isBoxed(v))
		return { text: JSON.stringify(v), frozen: !viaToJSON };
	const o = v as object;
	const hit = textCache.get(o);
	if (hit !== undefined) return { text: hit, frozen: !viaToJSON };
	if (stack.has(o)) throw new TypeError('Converting circular structure to JSON');
	const keys = Array.isArray(o) ? null : Object.keys(o);
	const entries = keys ? keys.length : (o as unknown[]).length;
	let text: string;
	let frozen: boolean;
	if (depth >= COMPOSE_DEPTH && entries < COMPOSE_MIN_ENTRIES) {
		// Deep and small: the native serialiser is faster than composing.
		text = JSON.stringify(o);
		frozen = deepFrozen(o, new Set());
	} else {
		frozen = Object.isFrozen(o);
		stack.add(o);
		try {
			// String concatenation (not `join`): V8 builds ropes, so joining the cached text of unchanged entries copies
			// nothing; the whole text is flattened once, when it is sent.
			if (keys === null) {
				const arr = o as unknown[];
				text = '[';
				for (let i = 0; i < arr.length; i++) {
					const r = ser(arr[i], String(i), stack, depth + 1);
					frozen &&= r.frozen;
					text += (i ? ',' : '') + (r.text ?? 'null');
				}
				text += ']';
			} else {
				text = '{';
				let first = true;
				for (const k of keys) {
					const r = ser((o as Record<string, unknown>)[k], k, stack, depth + 1);
					frozen &&= r.frozen;
					if (r.text === undefined) continue;
					text += `${first ? '' : ','}${JSON.stringify(k)}:${r.text}`;
					first = false;
				}
				text += '}';
			}
		} finally {
			stack.delete(o);
		}
	}
	if (frozen) textCache.set(o, text);
	return { text, frozen: frozen && !viaToJSON };
}

/**
 * `JSON.stringify(value)` with the text of deeply frozen objects (Immer documents) cached by identity. Returns
 * `undefined` where `JSON.stringify` does (a top-level `undefined`, function or symbol).
 */
export function stringifyJson(value: unknown): string {
	return ser(value, '', new Set(), 0).text as string;
}

/**
 * Small units of work that fill the cache for `value` ahead of a save: one per entry of its records (each sequence,
 * medium, item…). Run them when the browser is idle (autosave does) and the save itself only joins cached text.
 */
export function* jsonWarmUnits(value: unknown): Generator<() => void> {
	if (value === null || typeof value !== 'object') return;
	for (const k of Object.keys(value)) {
		const child = (value as Record<string, unknown>)[k];
		if (child === null || typeof child !== 'object' || textCache.has(child)) continue;
		for (const e of Object.keys(child)) {
			const entry = (child as Record<string, unknown>)[e];
			if (entry !== null && typeof entry === 'object' && !textCache.has(entry))
				yield () => {
					stringifyJson(entry);
				};
		}
	}
}
