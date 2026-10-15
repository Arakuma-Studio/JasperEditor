// Incremental invariant checking (docs/wp-notes/perf-core.md §2; ARCHITECTURE §13).
//
// A transaction's result `next` differs from its valid base in a few entities; Immer's structural sharing says
// which (unchanged objects keep their identity). Instead of re-checking the whole document (≈ 20 ms on 1 000
// clips), `checkTransactionInvariants` re-runs the per-entity checks of `checkInvariants` (the same code,
// `invariantCheckers`) on what changed, plus every cross-entity check the change can affect:
//
// - INV-001 ids: the ids the changed entities claim now vs. before, against an id index of the verified base;
// - INV-003 overlaps on the tracks that gained or kept a changed clip;
// - INV-006/007 links and clip groups that changed or hold a changed clip, and the clips they list;
// - INV-010 transitions of a changed sequence; Track Matte Key graphs when a matte effect is involved;
// - INV-009 nesting, and nests of a sequence whose duration changed; INV-014 references a clip gave up;
// - INV-EXPR, INV-ESSENTIAL, INV-COLOR, INV-MIX on the changed clips (remix groups on their whole sequence).
//
// Anything else (document-level records, a sequence's own fields, added or removed sequences, caption
// transcripts) falls back to the full check, which also produces the issue list whenever the incremental check
// finds a problem: results are exactly `checkInvariants(next)`'s. The incremental check needs a base that passed a
// check before (`verified`); the first transaction on an unverified document runs the full check.
//
// Modes: `incremental` (production), `full`, and `verify` (tests and dev builds): the full check decides and the
// incremental one must agree on validity and on the id index, else the transaction fails with E_INTERNAL.
import { audioMixIssues } from './audio/invariants.ts';
import { colorIssues } from './color/model.ts';
import { keyDiff, markClean } from './commands/draft-read.ts';
import type { Issue } from './commands/types.ts';
import { expressionIssues } from './expressions.ts';
import { gapsClipIssues } from './gaps/index.ts';
import { type IdPrefix, idPrefixOf, isValidId } from './ids.ts';
import {
	type Claim,
	essentialIssues,
	type InvariantOptions,
	invariantCheckers,
	isAudioEffectId,
	newClipFacts,
	runInvariants,
	type SeqScope,
} from './invariants.ts';
import { TRACK_MATTE_EFFECT_ID } from './masks/track-matte.ts';
import type { ProjectDocument } from './schema/document.ts';
import type { Clip, Sequence, Track } from './schema/sequence.ts';
import { isKnownClipKind } from './schema/sequence.ts';
import type { Rational } from './time.ts';

export type InvariantMode = 'full' | 'incremental' | 'verify';

function envMode(): InvariantMode {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	const v = env?.JASPER_INVARIANTS;
	if (v === 'full' || v === 'incremental' || v === 'verify') return v;
	return env?.VITEST || env?.NODE_ENV === 'test' ? 'verify' : 'incremental';
}

let mode: InvariantMode = envMode();

/** The mode transactions use unless their context names one (dev builds set `verify`). */
export function setInvariantMode(m: InvariantMode): void {
	mode = m;
}
export function invariantMode(): InvariantMode {
	return mode;
}

/** Layers over a flattened set: what a verified document's entities claim (INV-001). */
class IdIndex {
	static readonly MAX_DEPTH = 48;
	private constructor(
		private readonly parent: IdIndex | null,
		private readonly added: ReadonlySet<string>,
		private readonly removed: ReadonlySet<string>,
		private readonly depth: number,
	) {}
	static of(ids: ReadonlySet<string>): IdIndex {
		return new IdIndex(null, ids, new Set(), 0);
	}
	has(id: string): boolean {
		for (let x: IdIndex | null = this; x; x = x.parent) {
			if (x.added.has(id)) return true;
			if (x.removed.has(id)) return false;
		}
		return false;
	}
	derive(added: ReadonlySet<string>, removed: ReadonlySet<string>): IdIndex {
		if (added.size === 0 && removed.size === 0) return this;
		const next = new IdIndex(this, added, removed, this.depth + 1);
		return next.depth > IdIndex.MAX_DEPTH ? IdIndex.of(next.toSet()) : next;
	}
	toSet(): Set<string> {
		const chain: IdIndex[] = [];
		for (let x: IdIndex | null = this; x; x = x.parent) chain.push(x);
		const out = new Set(chain[chain.length - 1]!.added);
		for (let i = chain.length - 2; i >= 0; i--) {
			for (const id of chain[i]!.removed) out.delete(id);
			for (const id of chain[i]!.added) out.add(id);
		}
		return out;
	}
}

type Verified = { ids: IdIndex; opts: InvariantOptions };
/** Documents known to pass every invariant, with their id index. */
const verifiedDocs = new WeakMap<ProjectDocument, Verified>();
const verified = {
	get: (doc: ProjectDocument) => verifiedDocs.get(doc),
	delete: (doc: ProjectDocument) => verifiedDocs.delete(doc),
	/** Also marks the document's sequences clean for cleanupSequence (draft-read.ts). */
	set(doc: ProjectDocument, v: Verified) {
		verifiedDocs.set(doc, v);
		for (const seq of Object.values(doc.sequences)) markClean(seq);
	},
};

const sameOpts = (a: InvariantOptions, b: InvariantOptions) =>
	a.effects === b.effects && a.mgTemplates === b.mgTemplates;

/** Records that `doc` passed the full check (its `seen` ids become its index). */
function markVerified(doc: ProjectDocument, seen: ReadonlySet<string>, opts: InvariantOptions): void {
	verified.set(doc, { ids: IdIndex.of(seen), opts });
}

/** Whether `doc` is known to be valid (it passed a check under these options). */
function isVerifiedDocument(doc: ProjectDocument, opts: InvariantOptions = {}): boolean {
	const v = verified.get(doc);
	return !!v && sameOpts(v.opts, opts);
}

/**
 * ui-perf: runs the full check on `doc` now and records it as verified when it is valid, so the next transaction on it
 * takes the incremental path. Editors call it when idle after opening a project (the first edit would otherwise run
 * the 25–40 ms full check of a 5 000-clip project on the critical path). Already verified: no work.
 */
export function verifyDocument(doc: ProjectDocument, opts: InvariantOptions = {}): boolean {
	if (isVerifiedDocument(doc, opts)) return true;
	return full(doc, opts).length === 0;
}

/**
 * The invariant issues of `next`, a transaction's result on `base`: exactly `checkInvariants(next, opts)`, computed
 * incrementally when `base` is verified and the change is of the kinds above.
 */
export function checkTransactionInvariants(
	base: ProjectDocument,
	next: ProjectDocument,
	opts: InvariantOptions = {},
	m: InvariantMode = mode,
): Issue[] {
	if (m === 'incremental' && incremental(base, next, opts)) return [];
	if (m !== 'verify') return full(next, opts);
	const fast = incremental(base, next, opts);
	const derived = fast ? verified.get(next) : undefined;
	verified.delete(next);
	const { issues, seen } = runInvariants(next, opts);
	const ok = issues.length === 0;
	let mismatch: string | null = null;
	if (fast !== null && fast !== ok)
		mismatch = `incremental check says ${fast ? 'valid' : 'invalid'}, full check ${ok ? 'valid' : 'invalid'}`;
	else if (derived) {
		const ids = derived.ids.toSet();
		const missing = [...seen].filter((id) => !ids.has(id));
		const extra = [...ids].filter((id) => !seen.has(id));
		if (missing.length || extra.length)
			mismatch = `incremental id index differs (missing ${missing.slice(0, 5).join(', ')}; extra ${extra.slice(0, 5).join(', ')})`;
	}
	if (mismatch) {
		return [{ commandIndex: -1, code: 'E_INTERNAL', message: `Invariant check mismatch: ${mismatch}` }];
	}
	if (ok) verified.set(next, derived ?? { ids: IdIndex.of(seen), opts });
	return issues;
}

function full(doc: ProjectDocument, opts: InvariantOptions): Issue[] {
	const { issues, seen } = runInvariants(doc, opts);
	if (issues.length === 0) markVerified(doc, seen, opts);
	return issues;
}

/** Sequence fields compared entity by entity; any other field that changes falls back to the full check. */
const FINE_SEQUENCE_FIELDS = new Set(['clips', 'transitions', 'links', 'groups', 'markers']);
const DOC_FINE_FIELDS = new Set(['sequences', 'synthetics']);

function sameExcept(a: object, b: object, except: ReadonlySet<string>): boolean {
	if (a === b) return true;
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	for (const k of ka) {
		if (except.has(k)) continue;
		if (!Object.hasOwn(b, k) || (a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k])
			return false;
	}
	return true;
}

type Rec<T> = Readonly<Record<string, T>>;

/** Keys of `next` whose value is new or changed, and keys of `base` gone from `next`. */
function diffKeys<T>(base: Rec<T>, next: Rec<T>): { changed: string[]; deleted: string[] } {
	const d = keyDiff(base, next);
	return { changed: [...d.changed], deleted: [...d.deleted] };
}

const noClaim: Claim = () => {};

/** Ids claimed by the changed entities before (`old`) and after (`next`) the transaction. */
class ClaimDelta {
	readonly old = new Set<string>();
	readonly now: string[] = [];
	/** Media / synthetic ids changed or removed clips no longer reference (INV-014). */
	readonly givenUp = new Set<string>();
	sink: string[] | null = null;
	constructor(
		private readonly index: IdIndex,
		private readonly issues: Issue[],
	) {}
	/** Claims an id of a changed entity of `next` (format checked like makeClaim). */
	readonly claim: Claim = (id, prefix, where) => {
		const prefixes: IdPrefix[] = Array.isArray(prefix) ? prefix : [prefix];
		if (!isValidId(id) || !prefixes.includes(idPrefixOf(id)!))
			this.issues.push({
				commandIndex: -1,
				code: 'E_INVARIANT',
				invariant: 'INV-001',
				message: id,
				path: where,
			});
		this.now.push(id);
		this.sink?.push(id);
	};
	/** The index of `next`, or null when an id is claimed twice. */
	resolve(): IdIndex | null {
		const now = new Set<string>();
		for (const id of this.now) {
			if (now.has(id)) return null;
			now.add(id);
		}
		const added = new Set<string>();
		for (const id of now) {
			if (this.old.has(id)) continue;
			if (this.index.has(id)) return null;
			added.add(id);
		}
		const removed = new Set<string>();
		for (const id of this.old) if (!now.has(id)) removed.add(id);
		return this.index.derive(added, removed);
	}
}

/** Ids a clip object claims (they depend on the clip alone), cached by identity. */
const clipClaims = new WeakMap<object, readonly string[]>();

function trackMap(seq: Sequence): Map<string, Track> {
	const tracks = new Map<string, Track>();
	for (const list of [seq.videoTracks, seq.audioTracks, seq.captionTracks])
		for (const t of list) tracks.set(t.id, t);
	return tracks;
}

function scopeOf(seq: Sequence, sid: string): SeqScope {
	return {
		seq,
		where: ['sequences', sid],
		tracks: trackMap(seq),
		rate: seq.settings.frameRate as Rational,
		byTrack: new Map(),
	};
}

function claimsOfClip(
	doc: ProjectDocument,
	seq: Sequence,
	sid: string,
	key: string,
	c: Clip,
	opts: InvariantOptions,
): readonly string[] {
	const cached = clipClaims.get(c);
	if (cached) return cached;
	const ids: string[] = [];
	invariantCheckers(doc, opts, [], (id) => ids.push(id)).clip(scopeOf(seq, sid), newClipFacts(), key, c);
	clipClaims.set(c, ids);
	return ids;
}

/** Latest frame end of a sequence's clips (what a nest's INV-005 bound reads), cached by clips record. */
const endCache = new WeakMap<object, number>();
function clipsEnd(clips: Rec<Clip>): number {
	let end = endCache.get(clips);
	if (end !== undefined) return end;
	end = 0;
	for (const k of Object.keys(clips)) end = Math.max(end, clips[k]!.start + clips[k]!.duration);
	endCache.set(clips, end);
	return end;
}

/** Sequences the nest clips of a clips record show (INV-009 edges), cached by clips record. */
const nestCache = new WeakMap<object, ReadonlySet<string>>();
function nestTargets(clips: Rec<Clip>): ReadonlySet<string> {
	let out = nestCache.get(clips);
	if (out) return out;
	const set = new Set<string>();
	for (const k of Object.keys(clips)) {
		const c = clips[k] as Clip & { sequenceId?: unknown };
		if (typeof c.sequenceId === 'string' && isKnownClipKind(c.kind)) set.add(c.sequenceId);
	}
	out = set;
	nestCache.set(clips, out);
	return out;
}

/** Media and synthetics the clips of a clips record reference (INV-006/014), cached by clips record. */
const refsCache = new WeakMap<object, ReadonlySet<string>>();
function clipRefs(clips: Rec<Clip>): ReadonlySet<string> {
	let out = refsCache.get(clips);
	if (out) return out;
	const set = new Set<string>();
	for (const k of Object.keys(clips)) for (const id of refsOf(clips[k]!)) set.add(id);
	out = set;
	refsCache.set(clips, out);
	return out;
}

/** Everything that counts as a use of media and synthetics in `doc` (items, derivations, fonts, clips). */
function allUses(doc: ProjectDocument): Set<string> {
	const used = new Set(docLevelUses(doc));
	for (const seq of Object.values(doc.sequences)) for (const id of clipRefs(seq.clips)) used.add(id);
	return used;
}

/** Media and synthetics referenced outside sequences (items, derivations, fonts), cached by the records. */
const docUseCache = new WeakMap<object, { media: object; fonts: object; uses: ReadonlySet<string> }>();
function docLevelUses(doc: ProjectDocument): ReadonlySet<string> {
	const hit = docUseCache.get(doc.items);
	if (hit && hit.media === doc.media && hit.fonts === doc.fonts) return hit.uses;
	const uses = new Set<string>();
	for (const it of Object.values(doc.items)) {
		if (it.kind === 'media' || it.kind === 'subclip') uses.add(it.mediaId);
		if (it.kind === 'synthetic') uses.add(it.syntheticId);
	}
	for (const m of Object.values(doc.media)) if (m.derivation) uses.add(m.derivation.fromMediaId);
	for (const f of Object.values(doc.fonts)) if (f.source.type === 'asset') uses.add(f.source.mediaId);
	docUseCache.set(doc.items, { media: doc.media, fonts: doc.fonts, uses });
	return uses;
}

/** References of a clip that INV-014 counts as uses (transcripts never reach here). */
function refsOf(c: Clip): string[] {
	const r = c as Record<string, unknown>;
	const out: string[] = [];
	if (typeof r.mediaId === 'string') out.push(r.mediaId);
	if (typeof r.syntheticId === 'string') out.push(r.syntheticId);
	const comp = r.composition as { mediaId?: unknown } | undefined;
	if (c.kind === 'composition' && typeof comp?.mediaId === 'string') out.push(comp.mediaId);
	return out;
}

const pick = <T>(rec: Rec<T>, keys: readonly string[]): Record<string, T> => {
	const out: Record<string, T> = {};
	for (const k of keys) out[k] = rec[k]!;
	return out;
};

/** How transactions have been checked (`pnpm perf` and runtime diagnostics read it). */
export type InvariantStats = { incremental: number; full: number; fallbacks: Record<string, number> };
const stats: InvariantStats = { incremental: 0, full: 0, fallbacks: {} };
export function invariantStats(): InvariantStats {
	return stats;
}

/** `incremental` with its outcome counted: true / false, or null when the full check must decide. */
function incremental(base: ProjectDocument, next: ProjectDocument, opts: InvariantOptions): boolean | null {
	const r = incrementalCheck(base, next, opts);
	if (typeof r === 'string') {
		stats.full++;
		stats.fallbacks[r] = (stats.fallbacks[r] ?? 0) + 1;
		return null;
	}
	stats.incremental++;
	return r;
}

/**
 * True: `next` is valid (and is recorded as verified). False: it is not. A string: why the change is outside what
 * the incremental check covers (or `base` is not verified).
 */
function incrementalCheck(
	base: ProjectDocument,
	next: ProjectDocument,
	opts: InvariantOptions,
): boolean | string {
	const vb = verified.get(base);
	if (!vb || !sameOpts(vb.opts, opts)) return 'unverified base';
	if (base === next) return true;
	if (!sameExcept(base, next, DOC_FINE_FIELDS)) return 'document fields';
	const bs = base.sequences;
	const ns = next.sequences;
	if (Object.keys(bs).length !== Object.keys(ns).length) return 'sequence added or removed';
	const issues: Issue[] = [];
	const delta = new ClaimDelta(vb.ids, issues);
	let nestsChanged = false;
	const longer: string[] = [];
	for (const sid of Object.keys(ns)) {
		const B = bs[sid];
		const N = ns[sid]!;
		if (!B) return 'sequence added or removed';
		if (B === N) continue;
		const r = sequenceDelta(base, next, sid, B, N, opts, delta, issues);
		if (typeof r === 'string' || r === false) return r;
		if (r.nests) nestsChanged = true;
		if (r.endChanged) longer.push(sid);
	}
	if (issues.length) return false;
	// A nest shows its sequence's duration (INV-005): when a nested sequence got longer or shorter, its nests are
	// re-checked by the full check.
	if (longer.length) {
		for (const seq of Object.values(ns)) {
			const targets = nestTargets(seq.clips);
			if (longer.some((sid) => targets.has(sid))) return 'nested sequence duration';
		}
	}
	// INV-009 nesting acyclic, when a nest clip came, went or changed.
	if (nestsChanged && nestingCycle(ns)) return false;
	// INV-014: a reference some clip gave up must still be used by something else.
	let used: Set<string> | undefined;
	if (delta.givenUp.size) {
		used = allUses(next);
		for (const ref of delta.givenUp)
			if ((next.media[ref] || next.synthetics[ref]) && !used.has(ref)) return false;
	}
	// Synthetics (color mattes…) come and go with their clips: ids (INV-001), every one used (INV-014), none
	// referenced once gone (INV-006).
	if (base.synthetics !== next.synthetics) {
		const d = diffKeys(base.synthetics, next.synthetics);
		used ??= allUses(next);
		for (const k of [...d.changed, ...d.deleted])
			if (base.synthetics[k]) delta.old.add(base.synthetics[k]!.id);
		for (const k of d.changed) {
			const v = next.synthetics[k]!;
			// Clips check that they can show their synthetic's kind.
			if (base.synthetics[k] && base.synthetics[k]!.kind !== v.kind) return 'synthetic kind';
			if (v.id !== k || !used.has(k)) return false;
			delta.claim(v.id, 'syn', ['synthetics', k]);
		}
		for (const k of d.deleted) if (used.has(k)) return false;
		if (issues.length) return false;
	}
	const ids = delta.resolve();
	if (!ids) return false;
	verified.set(next, { ids, opts });
	return true;
}

function nestingCycle(seqs: Rec<Sequence>): boolean {
	const visiting = new Set<string>();
	const done = new Set<string>();
	const dfs = (s: string): boolean => {
		if (visiting.has(s)) return true;
		if (done.has(s)) return false;
		visiting.add(s);
		const seq = seqs[s];
		if (seq) for (const n of nestTargets(seq.clips)) if (dfs(n)) return true;
		visiting.delete(s);
		done.add(s);
		return false;
	};
	return Object.keys(seqs).some((s) => dfs(s));
}

function sequenceDelta(
	base: ProjectDocument,
	next: ProjectDocument,
	sid: string,
	B: Sequence,
	N: Sequence,
	opts: InvariantOptions,
	delta: ClaimDelta,
	issues: Issue[],
): { nests: boolean; endChanged: boolean } | false | string {
	if (!sameExcept(B, N, FINE_SEQUENCE_FIELDS)) return 'sequence fields';
	const clips = diffKeys(B.clips, N.clips);
	const olds: [string, Clip][] = [];
	for (const k of [...clips.changed, ...clips.deleted]) if (B.clips[k]) olds.push([k, B.clips[k]!]);
	const news: [string, Clip][] = clips.changed.map((k) => [k, N.clips[k]!]);
	let nests = false;
	let mattes = false;
	let remix = false;
	for (const [, c] of [...olds, ...news]) {
		const r = c as Record<string, unknown>;
		// Caption transcripts belong to one clip across the document (INV-014): the full check counts them.
		if (r.transcriptId !== undefined) return 'caption transcript';
		if (r.remix !== undefined) remix = true;
		if (typeof r.sequenceId === 'string' && isKnownClipKind(c.kind)) nests = true;
		if (
			(r.effects as { effectId: string }[] | undefined)?.some((fx) => fx.effectId === TRACK_MATTE_EFFECT_ID)
		)
			mattes = true;
	}

	const scope = scopeOf(N, sid);
	const checks = invariantCheckers(next, opts, issues, delta.claim);
	const facts = newClipFacts();

	// Per-clip invariants and ids of the new and changed clips; ids of their old versions and of removed clips.
	for (const [k, c] of news) {
		const sink: string[] = [];
		delta.sink = sink;
		checks.clip(scope, facts, k, c);
		delta.sink = null;
		clipClaims.set(c, sink);
	}
	if (issues.length) return false;
	for (const [k, c] of olds) for (const id of claimsOfClip(base, B, sid, k, c, opts)) delta.old.add(id);

	// INV-014: references the old versions held and the new ones do not (checked against the whole document later).
	if (olds.length) {
		const kept = new Set(news.flatMap(([, c]) => refsOf(c)));
		for (const [, c] of olds) for (const ref of refsOf(c)) if (!kept.has(ref)) delta.givenUp.add(ref);
	}

	// INV-003 on every track a clip arrived on, moved on or changed length on.
	const was = new Map(olds);
	const placed = news.filter(([k, c]) => {
		const o = was.get(k);
		return !o || o.trackId !== c.trackId || o.start !== c.start || o.duration !== c.duration;
	});
	if (placed.length) {
		const touched = new Set(placed.map(([, c]) => c.trackId).filter((t) => scope.tracks.has(t)));
		const byTrack = new Map<string, Clip[]>();
		if (touched.size)
			for (const c of Object.values(N.clips))
				if (touched.has(c.trackId)) {
					const list = byTrack.get(c.trackId) ?? [];
					list.push(c);
					byTrack.set(c.trackId, list);
				}
		checks.overlaps(scope.where, byTrack);
	}

	// INV-006/007 link and clip groups: the changed ones, the ones a changed clip names, and the clips they list.
	for (const [table, field, check] of [
		['links', 'linkId', checks.link],
		['groups', 'groupId', checks.group],
	] as const) {
		const b = B[table] as Rec<{ id: string; members: string[] }>;
		const n = N[table] as Rec<{ id: string; members: string[] }>;
		const d = diffKeys(b, n);
		const fresh = new Set(d.changed);
		const affected = new Set(d.changed);
		for (const [, c] of [...olds, ...news]) {
			const id = c[field];
			if (id) affected.add(id);
		}
		for (const k of [...d.changed, ...d.deleted]) if (b[k]) delta.old.add(b[k]!.id);
		for (const k of affected) {
			const g = n[k];
			if (g)
				(check as (s: SeqScope, key: string, g: unknown, c: Claim) => void)(
					scope,
					k,
					g,
					fresh.has(k) ? delta.claim : noClaim,
				);
		}
		// Clips listed in a changed or removed group must still be in the group they name (dangling linkId/groupId).
		for (const k of [...d.changed, ...d.deleted])
			for (const m of [...(b[k]?.members ?? []), ...(n[k]?.members ?? [])]) {
				const c = N.clips[m];
				const id = c?.[field];
				if (c && id && !n[id]?.members.includes(c.id)) return false;
			}
	}

	// INV-010 transitions (all of the sequence: edges are shared), ids of the changed ones.
	const trans = diffKeys(B.transitions, N.transitions);
	if (trans.changed.length || trans.deleted.length || news.length || olds.length) {
		const fresh = new Set(trans.changed);
		for (const k of [...trans.changed, ...trans.deleted])
			if (B.transitions[k]) delta.old.add(B.transitions[k]!.id);
		checks.transitions(scope, (k) => (fresh.has(k) ? delta.claim : noClaim));
	}

	// Sequence markers: ids only.
	if (B.markers !== N.markers) {
		for (const m of B.markers) delta.old.add(m.id);
		for (const m of N.markers) delta.claim(m.id, 'mrk', [...scope.where, 'markers', m.id]);
	}

	if (mattes) checks.trackMattes(scope);
	if (issues.length) return false;

	// Document-wide checks restricted to the changed clips (and transitions).
	const changedClips = pick(N.clips, clips.changed);
	const partial = { ...N, clips: changedClips, transitions: pick(N.transitions, trans.changed) } as Sequence;
	if (expressionIssues({ sequences: { [sid]: partial } }, isAudioEffectId).length) return false;
	if (essentialIssues({ sequences: { [sid]: remix ? N : partial } } as never).length) return false;
	if (colorIssues({ media: next.media, sequences: { [sid]: partial } } as never).length) return false;
	// gaps: clip-level checks (audio channel routings, Warp Stabilizer analyses) of the changed clips.
	if (gapsClipIssues({ media: next.media, sequences: { [sid]: partial } } as never).length) return false;
	if (audioMixIssues({ ...N, clips: changedClips } as Sequence, scope.where).length) return false;
	// The sequence's end (a nest's INV-005 bound) from the base's: rescanned only when a clip that reached it changed.
	let endChanged = false;
	if (B.clips !== N.clips) {
		const before = clipsEnd(B.clips);
		const end = (c: Clip) => c.start + c.duration;
		if (olds.some(([, c]) => end(c) >= before)) endChanged = clipsEnd(N.clips) !== before;
		else {
			const after = Math.max(before, ...news.map(([, c]) => end(c)));
			endCache.set(N.clips, after);
			endChanged = after !== before;
		}
	}
	return { nests, endChanged };
}
