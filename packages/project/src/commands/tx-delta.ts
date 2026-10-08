// What a transaction changed so far, for the normalizers that run at its end (perf-core,
// docs/wp-notes/perf-core.md §3). collectOrphans and normalizeCaptionOwnership look at the whole document; when the
// transaction started from a document a transaction produced (already normalized, `markNormalized`), only what it
// changed can create an orphan or a shared caption transcript, so these checks prove "nothing to do" from the
// changed clips alone and the full pass runs only when they cannot.
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { deltaScans, latest, normalizedBase, recordDelta } from './draft-read.ts';

type Rec<T> = Readonly<Record<string, T>>;

/** A clip of a changed sequence: its version at the start of the transaction (if any) and now. */
export type ClipChange = { sid: string; before: Clip | undefined; after: Clip | undefined };

export type TxDelta = {
	base: ProjectDocument;
	/** Changed, added and removed clips of every sequence. */
	clips: ClipChange[];
	/** Sequences added or removed. */
	sequencesAddedOrRemoved: boolean;
};

/**
 * The clip-level changes of draft `doc` against its normalized base, or null (no normalized base, or a change the
 * delta does not describe: a replaced `clips` record).
 */
export function txDelta(doc: ProjectDocument): TxDelta | null {
	const base = deltaScans() ? normalizedBase(doc) : null;
	if (!base) return null;
	const seqs = recordDelta(latest(doc).sequences as Rec<Sequence>);
	if (seqs.base !== base.sequences) return null;
	const clips: ClipChange[] = [];
	for (const sid of seqs.changed) {
		const now = latest(latest(doc.sequences)[sid]);
		const was = base.sequences[sid];
		if (!now) continue;
		if (!was) {
			for (const c of Object.values(latest(now.clips)))
				clips.push({ sid, before: undefined, after: latest(c) });
			continue;
		}
		const d = recordDelta(now.clips as Rec<Clip>);
		if (d.base !== was.clips) return null;
		const cur = latest(now.clips) as Rec<Clip>;
		for (const k of d.changed) clips.push({ sid, before: was.clips[k], after: latest(cur[k]) });
		for (const k of d.deleted) clips.push({ sid, before: was.clips[k], after: undefined });
	}
	for (const sid of seqs.deleted)
		for (const c of Object.values(base.sequences[sid]!.clips))
			clips.push({ sid, before: c, after: undefined });
	return {
		base,
		clips,
		sequencesAddedOrRemoved: seqs.deleted.length > 0 || seqs.changed.some((s) => !base.sequences[s]),
	};
}

/** Media, synthetics and transcripts a clip uses in collectOrphans' sense. */
function orphanRefs(c: Clip | undefined): string[] {
	if (!c) return [];
	const r = c as Record<string, unknown>;
	const out: string[] = [];
	for (const k of ['mediaId', 'syntheticId', 'transcriptId'] as const)
		if (typeof r[k] === 'string') out.push(r[k]);
	return out;
}

/** How many clips of a (finished) clips record use each media / synthetic / transcript id, cached per record. */
const refCountCache = new WeakMap<object, ReadonlyMap<string, number>>();
function refCounts(clips: Rec<Clip>): ReadonlyMap<string, number> {
	let m = refCountCache.get(clips);
	if (!m) {
		const counts = new Map<string, number>();
		for (const c of Object.values(clips))
			for (const id of orphanRefs(c)) counts.set(id, (counts.get(id) ?? 0) + 1);
		m = counts;
		refCountCache.set(clips, m);
	}
	return m;
}

/** Media / synthetics project items and derived media use (collectOrphans' sense), cached per records. */
const docUseCache = new WeakMap<object, { media: object; uses: ReadonlySet<string> }>();
function docUses(base: ProjectDocument): ReadonlySet<string> {
	const hit = docUseCache.get(base.items);
	if (hit && hit.media === base.media) return hit.uses;
	const uses = new Set<string>();
	for (const it of Object.values(base.items)) {
		if (it.kind === 'media' || it.kind === 'subclip') uses.add(it.mediaId);
		if (it.kind === 'synthetic') uses.add(it.syntheticId);
	}
	for (const m of Object.values(base.media)) if (m.derivation) uses.add(m.derivation.fromMediaId);
	docUseCache.set(base.items, { media: base.media, uses });
	return uses;
}

/**
 * What collectOrphans must delete, from the transaction's changes alone: null when that cannot be decided this way
 * (no normalized base, items / media / transcripts edited, a medium or transcript that may have lost its last use),
 * else the synthetics no longer used (often none). Exact: on an orphan-free base only references a changed clip gave
 * up, and entities added in the transaction, can be unused; each is counted over the whole document (per-record
 * counts of the base, corrected by the changed clips).
 */
export function orphanedSynthetics(doc: ProjectDocument): string[] | null {
	const delta = txDelta(doc);
	if (!delta) return null;
	const raw = latest(doc);
	const base = delta.base;
	if (latest(raw.items) !== base.items) return null;
	const candidates = new Set<string>();
	for (const field of ['media', 'transcripts', 'synthetics'] as const) {
		const d = recordDelta(raw[field] as Rec<unknown>);
		if (d.base !== base[field] || d.deleted.length) return null;
		for (const k of d.changed) {
			if (Object.hasOwn(d.base, k)) {
				if (field !== 'synthetics') return null; // an edited medium / transcript: its references may change
			} else candidates.add(k);
		}
	}
	// Per sequence: count corrections from the changed clips; references given up become candidates.
	const fix = new Map<string, Map<string, number>>();
	for (const { sid, before, after } of delta.clips) {
		const now = orphanRefs(after);
		let f = fix.get(sid);
		if (!f) fix.set(sid, (f = new Map()));
		for (const id of now) f.set(id, (f.get(id) ?? 0) + 1);
		for (const id of orphanRefs(before)) {
			f.set(id, (f.get(id) ?? 0) - 1);
			if (!now.includes(id)) candidates.add(id);
		}
	}
	if (candidates.size === 0) return [];
	const uses = docUses(base);
	const unused: string[] = [];
	for (const id of candidates) {
		if (uses.has(id)) continue;
		let n = 0;
		for (const sid of Object.keys(latest(raw.sequences))) {
			const was = base.sequences[sid];
			if (was) n += refCounts(was.clips).get(id) ?? 0;
			n += fix.get(sid)?.get(id) ?? 0;
			if (n > 0) break;
		}
		if (n > 0) continue;
		if (!Object.hasOwn(latest(raw.synthetics), id)) return null; // a medium or transcript lost its last use
		unused.push(id);
	}
	return unused;
}

/**
 * True when caption ownership cannot have changed: the base was normalized, transcripts are as they were and no
 * changed or added clip is a captions clip.
 */
export function captionsUnchanged(doc: ProjectDocument): boolean {
	const delta = txDelta(doc);
	if (!delta) return false;
	if (latest(latest(doc).transcripts) !== delta.base.transcripts) return false;
	return delta.clips.every(({ after }) => after?.kind !== 'captions');
}
