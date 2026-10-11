// Reading a draft through its proxy costs several traps per property, and reading a draftable child (a clip of
// `seq.clips`) creates a child draft that Immer later has to finalize. Handlers that scan every clip of a sequence
// (track scans in clearRange / insertShift, cleanupSequence, collectOrphans, clip lookups) therefore cost
// O(clips × traps) per call. `latest(x)` returns the object a draft
// currently reads from (its copy once written, else its base) without creating anything, so scans read plain
// objects and only the clips that are actually changed are drafted.
//
// The result is READ-ONLY: never write to it (base objects are shared with older documents). Nested values may
// themselves be drafts (children read through the proxy earlier); `latest` them again before scanning deeper.
//
// Immer keeps its state behind `Symbol.for("immer-state")` (also what `isDraft` checks) with the current value in
// `copy_ ?? base_`. If a future Immer changes that shape, `latest` falls back to the public `current()` (correct,
// only slower) and `test/draft-read.test.ts` fails, so the fast path cannot silently disappear.
import { current, isDraft, original, produce } from 'immer';

const DRAFT_STATE = Symbol.for('immer-state');

type DraftState = { base_: unknown; copy_: unknown | null; modified_: boolean };

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
			ok &&= stateOf(d.a)?.modified_ === false && stateOf(after.b)?.modified_ === true;
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

export type RecordDelta<T> = {
	/** The record at the start of the transaction. */
	base: Readonly<Record<string, T>>;
	/** Keys added, replaced or edited in place since then (entries only read are not changed). */
	changed: string[];
	/** Keys removed since then. */
	deleted: string[];
};

/**
 * What a transaction changed in a (draft) record so far, by identity: O(entries) of cheap comparisons and nothing
 * drafted. A plain record (not a draft, or a draft never written) has no changes.
 */
export function recordDelta<T>(rec: Readonly<Record<string, T>>): RecordDelta<T> {
	let base: Record<string, T>;
	let cur: Record<string, T>;
	if (DRAFT_READ_FAST) {
		const s = stateOf(rec);
		if (!s?.copy_) return { base: latest(rec), changed: [], deleted: [] };
		base = s.base_ as Record<string, T>;
		cur = s.copy_ as Record<string, T>;
	} else {
		if (!isDraft(rec)) return { base: rec, changed: [], deleted: [] };
		base = original(rec as never) as Record<string, T>;
		cur = current(rec as never) as Record<string, T>;
	}
	if (DELTA_FAST) {
		const d = draftDelta(stateOf(rec) as InternalState, base, cur);
		if (d) return { base, ...d };
	}
	return { base, ...scanDelta(base, cur) };
}

/** Immer's bookkeeping read by `draftDelta` (checked by `probeDeltaPath`). */
type InternalState = DraftState & {
	assigned_?: Map<string, boolean>;
	scope_?: { drafts_?: unknown[] };
	parent_?: unknown;
	key_?: unknown;
};

/**
 * The changes of a draft record from Immer's bookkeeping instead of a scan: keys assigned or deleted on the record
 * (`assigned_`) and the record's child drafts that were written (`scope_.drafts_` with this record as `parent_`):
 * O(drafts of the transaction) instead of O(entries). Null when the bookkeeping is not there.
 */
function draftDelta<T>(
	s: InternalState | undefined,
	base: Record<string, T>,
	cur: Record<string, T>,
): { changed: string[]; deleted: string[] } | null {
	const assigned = s?.assigned_;
	const drafts = s?.scope_?.drafts_;
	if (!(assigned instanceof Map) || !Array.isArray(drafts)) return null;
	const keys = new Set<string>();
	const deleted: string[] = [];
	for (const [k, v] of assigned) {
		if (v || Object.hasOwn(cur, k)) keys.add(k);
		else if (Object.hasOwn(base, k)) deleted.push(k);
	}
	for (const d of drafts) {
		const st = stateOf(d) as InternalState | undefined;
		if (st && st.parent_ === s && st.modified_ && typeof st.key_ === 'string') keys.add(st.key_);
	}
	const changed: string[] = [];
	for (const k of keys) {
		if (!Object.hasOwn(cur, k)) continue;
		const v = cur[k];
		const b = Object.hasOwn(base, k) ? base[k] : undefined;
		if (v === b) continue;
		const st = stateOf(v);
		if (st && !st.modified_ && st.base_ === b) continue;
		changed.push(k);
	}
	return { changed, deleted };
}

/** The changes of a record by comparing every entry with its base (identity). */
function scanDelta<T>(
	base: Record<string, T>,
	cur: Record<string, T>,
): { changed: string[]; deleted: string[] } {
	const changed: string[] = [];
	let added = 0;
	for (const k of Object.keys(cur)) {
		const v = cur[k];
		const b = Object.hasOwn(base, k) ? base[k] : undefined;
		if (v === b) continue;
		const st = stateOf(v);
		if (st && !st.modified_ && st.base_ === b) continue; // read through the draft, not written
		changed.push(k);
		if (b === undefined) added++;
	}
	const deleted: string[] = [];
	if (Object.keys(cur).length !== Object.keys(base).length + added)
		for (const k of Object.keys(base)) if (!Object.hasOwn(cur, k)) deleted.push(k);
	return { changed, deleted };
}

/** Whether `draftDelta` reads Immer's bookkeeping right (checked once at load against `scanDelta`). */
function probeDeltaPath(): boolean {
	if (!DRAFT_READ_FAST) return false;
	try {
		let ok = true;
		const base: Record<string, { n: number }> = { a: { n: 1 }, b: { n: 2 }, c: { n: 3 }, d: { n: 4 } };
		produce(base, (d) => {
			d.a!.n = 5; // edited in place
			void d.b!.n; // only read
			delete d.c; // removed
			d.e = { n: 6 }; // added
			d.d = base.d!; // assigned its own base value
			const s = stateOf(d) as InternalState;
			const fast = draftDelta(s, base, s.copy_ as Record<string, { n: number }>);
			const slow = scanDelta(base, s.copy_ as Record<string, { n: number }>);
			ok &&=
				!!fast &&
				JSON.stringify([[...fast.changed].sort(), fast.deleted]) ===
					JSON.stringify([[...slow.changed].sort(), slow.deleted]) &&
				JSON.stringify([...slow.changed].sort()) === '["a","e"]';
		});
		return ok;
	} catch {
		return false;
	}
}

/** True when recordDelta reads Immer's bookkeeping (O(changes)); asserted by tests. */
export const DELTA_FAST = probeDeltaPath();

/** recordDelta by a full identity scan (tests compare it with the fast path). */
export function recordDeltaByScan<T>(rec: Readonly<Record<string, T>>): RecordDelta<T> {
	const s = stateOf(rec);
	if (!s?.copy_) return { base: latest(rec), changed: [], deleted: [] };
	return {
		base: s.base_ as Record<string, T>,
		...scanDelta(s.base_ as Record<string, T>, s.copy_ as Record<string, T>),
	};
}

const normalized = new WeakSet<object>();

/**
 * Documents a transaction produced: caption ownership is normalized and nothing is orphaned (applyTransaction's
 * last steps ran on them), so the next transaction's normalizers only need to look at what it changes.
 */
export function markNormalized(doc: object): void {
	normalized.add(doc);
}

/** The base document of draft `doc` when it is normalized (see markNormalized), else null. */
export function normalizedBase<T extends object>(doc: T): T | null {
	if (!isDraft(doc)) return null;
	const base = original(doc as never) as T;
	return normalized.has(base) ? base : null;
}

export type KeyDiff = { changed: readonly string[]; deleted: readonly string[] };
const keyDiffCache = new WeakMap<object, { base: object; diff: KeyDiff }>();

/**
 * Keys of record `next` that are new or hold another object than in `base`, and keys of `base` gone from `next`,
 * by identity. Finished (frozen) records cache their diff against the last base asked for, so the steps after a
 * transaction (entity diff, invariants, warnings) scan a changed sequence's clips once.
 */
export function keyDiff<T>(base: Readonly<Record<string, T>>, next: Readonly<Record<string, T>>): KeyDiff {
	if (base === next) return { changed: [], deleted: [] };
	const hit = keyDiffCache.get(next);
	if (hit && hit.base === base) return hit.diff;
	const changed: string[] = [];
	let kept = 0;
	for (const k of Object.keys(next)) {
		if (!Object.hasOwn(base, k)) changed.push(k);
		else {
			kept++;
			if (next[k] !== base[k]) changed.push(k);
		}
	}
	const deleted: string[] = [];
	if (kept !== Object.keys(base).length)
		for (const k of Object.keys(base)) if (!Object.hasOwn(next, k)) deleted.push(k);
	const diff = { changed, deleted };
	if (Object.isFrozen(next)) keyDiffCache.set(next, { base, diff });
	return diff;
}

const cleanSequences = new WeakSet<object>();
/** Sequences of a document that passed the invariants (no dangling links, groups or transitions). */
export function markClean(seq: object): void {
	cleanSequences.add(seq);
}
export function isClean(seq: object): boolean {
	return cleanSequences.has(seq);
}

let deltaScansOn = true;
/**
 * Whether the normalizers may scope their work to what a transaction changed (tx-delta.ts, cleanupSequence). Tests
 * turn it off to prove the scoped results equal the full scans'.
 */
export function setDeltaScans(on: boolean): void {
	deltaScansOn = on;
}
export function deltaScans(): boolean {
	return deltaScansOn;
}
