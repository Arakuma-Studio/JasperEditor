// Proxy-free reads of Immer drafts (workstream perf-core, docs/wp-notes/perf-core.md §3).
//
// Reading a draft through its proxy costs several traps per property, and reading a draftable child (a clip of
// `seq.clips`) creates a child draft that Immer later has to finalize. Handlers that scan every clip of a sequence
// (track scans in clearRange / insertShift, cleanupSequence, collectOrphans, clip lookups) therefore cost
// O(clips × traps) per call — 100+ ms for a 50-clip move on 1 000 clips. `latest(x)` returns the object a draft
// currently reads from (its copy once written, else its base) without creating anything, so scans read plain
// objects and only the clips that are actually changed are drafted.
//
// The result is READ-ONLY: never write to it (base objects are shared with older documents). Nested values may
// themselves be drafts (children read through the proxy earlier); `latest` them again before scanning deeper.
//
// Immer keeps its state behind `Symbol.for("immer-state")` (also what `isDraft` checks) with the current value in
// `copy_ ?? base_`. If a future Immer changes that shape, `latest` falls back to the public `current()` (correct,
// only slower) and `test/draft-read.test.ts` fails, so the fast path cannot silently disappear.
import { current, isDraft, produce } from 'immer';

const DRAFT_STATE = Symbol.for('immer-state');

type DraftState = { base_: unknown; copy_: unknown | null };

function stateOf(v: unknown): DraftState | undefined {
	if (v === null || typeof v !== 'object') return undefined;
	return (v as Record<symbol, DraftState | undefined>)[DRAFT_STATE];
}

function fastLatest<T>(v: T): T {
	const s = stateOf(v);
	if (!s) return v;
	return (s.copy_ ?? s.base_) as T;
}

function slowLatest<T>(v: T): T {
	return isDraft(v) ? (current(v as never) as T) : v;
}

/** Whether Immer's internal state has the shape `fastLatest` reads (checked once at load). */
function probeFastPath(): boolean {
	try {
		let ok = true;
		const base = { a: { n: 1 }, b: { n: 2 } };
		produce(base, (d) => {
			const before = fastLatest(d);
			ok &&= before === base && fastLatest(d.a) === base.a;
			d.b.n = 3;
			const after = fastLatest(d) as { a: unknown; b: unknown };
			ok &&=
				after !== base && after.a === d.a && isDraft(after.b) && fastLatest(after.b as { n: number }).n === 3;
		});
		return ok;
	} catch {
		return false;
	}
}

/** True when draft reads take the proxy-free path (asserted by tests). */
export const DRAFT_READ_FAST = probeFastPath();

/**
 * The plain object a draft currently reads from (a non-draft is returned as is). Read-only: see the file comment.
 */
export const latest: <T>(v: T) => T = DRAFT_READ_FAST ? fastLatest : slowLatest;

/** `Object.keys` of a record or draft record without traps. */
export function keysOf(rec: object): string[] {
	return Object.keys(latest(rec));
}

/** Current (read-only) values of a record or draft record: no child drafts are created. */
export function valuesOf<T>(rec: Readonly<Record<string, T>>): T[] {
	const raw = latest(rec);
	const out: T[] = [];
	for (const k in raw) if (Object.hasOwn(raw, k)) out.push(latest(raw[k] as T));
	return out;
}

/** The current (read-only) value of `rec[key]`, or undefined; no child draft is created. */
export function peekIn<T>(rec: Readonly<Record<string, T>>, key: string): T | undefined {
	const raw = latest(rec);
	return Object.hasOwn(raw, key) ? latest(raw[key] as T) : undefined;
}

/**
 * `compute(latest(rec))`, cached per object while `rec` is unchanged in this and later transactions: only frozen
 * values are cached (finished documents; a draft's working copy never is), keyed by identity.
 */
export function cachedRead<K extends object, V>(
	cache: WeakMap<object, V>,
	rec: K,
	compute: (raw: K) => V,
): V {
	const raw = latest(rec);
	if (!Object.isFrozen(raw)) return compute(raw);
	let v = cache.get(raw);
	if (v === undefined) {
		v = compute(raw);
		cache.set(raw, v);
	}
	return v;
}
