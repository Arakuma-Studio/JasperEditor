// Ghosts (spec 12 §2.5, §2.7 Review): what a proposal would create, delete or change, by entity id, for drawing it
// on the timeline before it is applied. `proposalGhost` diffs two documents down to the entities inside clips
// (effects, keyframes, masks, clip markers…); `previewProposal` applies items one after another on a copy of the
// document (never the document itself) and attributes every ghost to its item.
import { canonicalJson } from '../canonical-json.ts';
import { applyTransaction } from '../commands/apply.ts';
import { substituteKnownRefs } from '../commands/context.ts';
import { type DocDiff, diffDocuments } from '../commands/diff.ts';
import type { Issue } from '../commands/types.ts';
import { createRandomIdSource, looksLikeId } from '../ids.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { type Proposal, selectedCommands } from './schema.ts';
import { appliedRefs, dependencyClosure } from './structure.ts';
import type { ProposalContext } from './validate.ts';

export type ProposalGhost = DocDiff;

/** Nested entities scanned per changed clip (depth and count are bounded). */
const MAX_NESTED = 5000;
const MAX_DEPTH = 8;

/** id → object of the entities inside a clip (anything with an entity-shaped `id`), the clip itself excluded. */
function nestedEntities(root: unknown): Map<string, unknown> {
	const out = new Map<string, unknown>();
	const walk = (v: unknown, depth: number, isRoot: boolean) => {
		if (out.size >= MAX_NESTED || depth > MAX_DEPTH || !v || typeof v !== 'object') return;
		if (Array.isArray(v)) {
			for (const x of v) walk(x, depth + 1, false);
			return;
		}
		const id = (v as { id?: unknown }).id;
		if (!isRoot && looksLikeId(id) && !out.has(id)) out.set(id, v);
		for (const x of Object.values(v)) walk(x, depth + 1, false);
	};
	walk(root, 0, true);
	return out;
}

function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	try {
		return canonicalJson(a) === canonicalJson(b);
	} catch {
		return false;
	}
}

/**
 * Entity ids created, deleted and changed from `before` to `after` (an `applyTransaction` result or a document):
 * the document diff (clips, tracks, transitions, markers, cues, media, items…) plus, inside each changed clip, its
 * effects, keyframes, masks, markers and other id-bearing children. Never throws.
 */
export function proposalGhost(
	before: ProjectDocument,
	after: ProjectDocument | { document: ProjectDocument },
): ProposalGhost {
	const next = 'document' in after && !('projectId' in after) ? after.document : (after as ProjectDocument);
	try {
		const diff = diffDocuments(before, next);
		const out: ProposalGhost = {
			created: [...diff.created],
			changed: [...diff.changed],
			deleted: [...diff.deleted],
		};
		const changedClips = new Set(diff.changed);
		for (const [sid, seq] of Object.entries(next.sequences)) {
			const prevSeq = before.sequences[sid];
			if (!prevSeq || prevSeq === seq) continue;
			for (const id of changedClips) {
				const a = prevSeq.clips[id];
				const b = seq.clips[id];
				if (!a || !b) continue;
				const na = nestedEntities(a);
				const nb = nestedEntities(b);
				for (const [k, v] of nb) {
					if (!na.has(k)) out.created.push(k);
					else if (!same(na.get(k), v)) out.changed.push(k);
				}
				for (const k of na.keys()) if (!nb.has(k)) out.deleted.push(k);
			}
		}
		return out;
	} catch {
		return { created: [], changed: [], deleted: [] };
	}
}

export type ProposalPreview = {
	/** The document with the items applied (a new object; `doc` is untouched). */
	document: ProjectDocument;
	/** Every ghost of the preview. */
	ghost: ProposalGhost;
	/** Ghosts per applied item. */
	items: Record<string, ProposalGhost>;
	/** Items that did not apply (and the items requiring them), with why. */
	failed: Record<string, Issue[]>;
	/** Items applied, in order (the closure of the requested ones). */
	applied: string[];
};

/**
 * Applies the requested items ('undecided' = every pending or stale item) and what they require on top of `doc`,
 * one transaction per item in proposal order with refs carried over, so each ghost belongs to one item. For previews
 * only: what is committed is `composeAcceptTx`'s single transaction. Invalid and accepted items are not applied; an
 * item whose requirement failed fails too.
 */
export function previewProposal(
	doc: ProjectDocument,
	p: Proposal,
	itemIds: readonly string[] | 'undecided',
	ctx: ProposalContext,
): ProposalPreview {
	const requested =
		itemIds === 'undecided'
			? p.items.filter((it) => it.state === 'pending' || it.state === 'stale').map((it) => it.id)
			: itemIds;
	const closure = dependencyClosure(p, requested, (it) => it.state === 'accepted' || it.state === 'invalid');
	const refs = appliedRefs(p);
	const ids = ctx.ids ?? createRandomIdSource();
	const failed: Record<string, Issue[]> = {};
	const items: Record<string, ProposalGhost> = {};
	const applied: string[] = [];
	let cur = doc;
	for (const it of closure) {
		const missing = it.requires.find((r) => failed[r]);
		if (missing) {
			failed[it.id] = [
				{ commandIndex: -1, code: 'E_NOT_FOUND', message: `requires item ${missing}, which failed` },
			];
			continue;
		}
		const commands = selectedCommands(it).map((c) => substituteKnownRefs(c, refs));
		const r = applyTransaction(
			cur,
			{
				label: it.label,
				origin: { agent: 'proposal-preview' },
				...(p.sequenceId ? { sequenceId: p.sequenceId } : {}),
				commands,
			},
			{
				ids,
				now: ctx.now ?? (() => new Date().toISOString()),
				revision: ctx.revision ?? 0,
				registries: ctx.registries,
				...(ctx.invariants ? { invariants: ctx.invariants } : {}),
			},
		);
		if (!r.result.ok) {
			failed[it.id] = r.result.errors;
			continue;
		}
		for (const [k, v] of Object.entries(r.result.refs)) refs.set(k, v);
		items[it.id] = proposalGhost(cur, r.document);
		applied.push(it.id);
		cur = r.document;
	}
	return { document: cur, ghost: proposalGhost(doc, cur), items, failed, applied };
}
