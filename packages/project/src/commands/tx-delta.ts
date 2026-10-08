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
export type ClipChange = { before: Clip | undefined; after: Clip | undefined };

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
			for (const c of Object.values(latest(now.clips))) clips.push({ before: undefined, after: latest(c) });
			continue;
		}
		const d = recordDelta(now.clips as Rec<Clip>);
		if (d.base !== was.clips) return null;
		const cur = latest(now.clips) as Rec<Clip>;
		for (const k of d.changed) clips.push({ before: was.clips[k], after: latest(cur[k]) });
		for (const k of d.deleted) clips.push({ before: was.clips[k], after: undefined });
	}
	for (const sid of seqs.deleted)
		for (const c of Object.values(base.sequences[sid]!.clips)) clips.push({ before: c, after: undefined });
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

/**
 * True when collectOrphans has nothing to do: the base was orphan-free, items, media and transcripts are as they
 * were (synthetics may change; new media / synthetics / transcripts must be used by a changed clip), and no clip
 * gave up a reference.
 */
export function noNewOrphans(doc: ProjectDocument): boolean {
	const delta = txDelta(doc);
	if (!delta) return false;
	const raw = latest(doc);
	if (latest(raw.items) !== delta.base.items) return false;
	const added: string[] = [];
	for (const field of ['media', 'transcripts', 'synthetics'] as const) {
		const d = recordDelta(raw[field] as Rec<unknown>);
		if (d.base !== delta.base[field] || d.deleted.length) return false;
		for (const k of d.changed) {
			if (Object.hasOwn(d.base, k)) {
				if (field !== 'synthetics') return false; // an edited medium / transcript: its references may change
			} else added.push(k);
		}
	}
	const used = new Set<string>();
	for (const { before, after } of delta.clips) {
		const now = orphanRefs(after);
		for (const id of now) used.add(id);
		for (const id of orphanRefs(before)) if (!now.includes(id)) return false;
	}
	return added.every((id) => used.has(id));
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
