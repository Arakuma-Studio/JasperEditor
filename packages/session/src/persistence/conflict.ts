// What a revision conflict would discard (S01:PER-025): the changes saved elsewhere since this window's base revision
// (Overwrite discards them) and this window's unsaved changes (Reload discards them), as History / headless labels
// and per-kind counts. Also used when a re-acquired lease finds the project moved on (docs/project-files.md
// "Single writer").
import { diffDocuments, idPrefixOf, type ProjectDocument } from '@jasper/project';

export type ChangeKind = 'clips' | 'tracks' | 'sequences' | 'markers' | 'transitions' | 'media' | 'other';
export type ChangeCounts = { added: number; changed: number; removed: number };
/** Entity counts per kind; kinds without changes are absent. */
export type ChangeSummary = Partial<Record<ChangeKind, ChangeCounts>>;

export type ChangeSet = {
	/** Labels, oldest first (at most `MAX_CHANGE_LABELS`): headless transactions, or this window's History steps. */
	labels: string[];
	summary: ChangeSummary;
};

export type ConflictDetails = {
	/** The revision on disk the details were read at (what Overwrite saves over). */
	serverRevision: number;
	/** `save`: an autosave got a 409; `lease`: the re-acquired lease found the project saved elsewhere. */
	source: 'save' | 'lease';
	/** Saved elsewhere since this window's base revision: what Overwrite discards. */
	incoming: ChangeSet;
	/** This window's unsaved changes: what Reload discards. */
	local: ChangeSet;
};

export const MAX_CHANGE_LABELS = 50;

const KIND_BY_PREFIX: Partial<Record<string, ChangeKind>> = {
	clp: 'clips',
	trk: 'tracks',
	seq: 'sequences',
	mrk: 'markers',
	trn: 'transitions',
	itm: 'media',
	med: 'media',
	syn: 'media',
	bin: 'media',
};

/** Deeper than any project document nests; past it values are taken as they are (no sharing, still correct). */
const MAX_SHARE_DEPTH = 64;

/**
 * `next` with every part deep-equal to the same place in `prev` replaced by `prev`'s object, so a document freshly
 * loaded from disk shares structure with the one in memory: reference diffs (`diffDocuments`) then report only what
 * really changed, and views memoised on unchanged parts stay valid. JSON values only (project documents).
 */
export function shareStructure<T>(prev: T, next: T): T {
	return share(prev, next, 0) as T;
}

function share(a: unknown, b: unknown, depth: number): unknown {
	if (a === b) return a;
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return b;
	if (depth >= MAX_SHARE_DEPTH) return b;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return b;
		let same = a.length === b.length;
		const out = b.map((v, i) => {
			const s = i < a.length ? share(a[i], v, depth + 1) : v;
			if (s !== a[i]) same = false;
			return s;
		});
		return same ? a : out;
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const keys = Object.keys(bo);
	let same = keys.length === Object.keys(ao).length;
	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const s = Object.hasOwn(ao, k) ? share(ao[k], bo[k], depth + 1) : bo[k];
		if (s !== ao[k] || !Object.hasOwn(ao, k)) same = false;
		out[k] = s;
	}
	return same ? a : out;
}

/** Document fields `diffDocuments` reports (as entity ids or the project id). */
const DIFFED_KEYS = new Set([
	'projectId',
	'name',
	'settings',
	'rootItems',
	'extensions',
	'items',
	'media',
	'synthetics',
	'transcripts',
	'fonts',
	'sequences',
]);

/** Entity counts of what changed from `before` to `after` (documents that share structure: see `shareStructure`). */
export function summarizeChanges(before: ProjectDocument, after: ProjectDocument): ChangeSummary {
	const out: ChangeSummary = {};
	const d = diffDocuments(before, after);
	const add = (ids: string[], field: keyof ChangeCounts) => {
		for (const id of ids) {
			const prefix = idPrefixOf(id);
			const kind = (prefix && KIND_BY_PREFIX[prefix]) || 'other';
			const c = (out[kind] ??= { added: 0, changed: 0, removed: 0 });
			c[field]++;
		}
	};
	add(d.created, 'added');
	add(d.changed, 'changed');
	add(d.deleted, 'removed');
	// Top-level collections `diffDocuments` does not itemise (text styles, looks, agent notes, …).
	if (!out.other) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		for (const k of keys) {
			if (DIFFED_KEYS.has(k)) continue;
			if ((before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]) {
				out.other = { added: 0, changed: 1, removed: 0 };
				break;
			}
		}
	}
	return out;
}

export function isEmptySummary(s: ChangeSummary): boolean {
	return Object.keys(s).length === 0;
}
