// Ghosts (spec 12 §2.5, §2.7 Review): what a proposal would create, delete or change, by entity id, for drawing it
// on the timeline before it is applied. `proposalGhost` diffs two documents down to the entities inside clips
// (effects, keyframes, masks, clip markers…); `previewProposal` applies items one after another on a copy of the
// document (never the document itself) and attributes every ghost to its item.
import { canonicalJson } from '../canonical-json.ts';
import { applyTransaction } from '../commands/apply.ts';
import { substituteKnownRefs } from '../commands/context.ts';
import { type DocDiff, diffDocuments } from '../commands/diff.ts';
import type { Issue } from '../commands/types.ts';
import { createRandomIdSource, type IdSource, looksLikeId } from '../ids.ts';
import { checkTransactionInvariants, isVerifiedDocument } from '../invariants-incremental.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import type { SoundDesign } from '../schema/sound.ts';
import { type Proposal, type ProposalItem, selectedCommands } from './schema.ts';
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
	/**
	 * Documents after each batch of items (the shared prefixes), for a later preview of the same base that starts the
	 * same way (`PreviewOptions.reuse`). Internal: what they hold is an implementation detail.
	 */
	checkpoints?: PreviewCheckpoint[];
};

/** The state of a preview after its first `count` closure items (see `ProposalPreview.checkpoints`). */
export type PreviewCheckpoint = {
	/** How many items of the closure are behind it (applied or failed). */
	count: number;
	/** What those items were: id, chosen set and commands (a later preview reuses it when it starts the same way). */
	items: readonly { id: string; alternative: number; commands: readonly unknown[] }[];
	doc: ProjectDocument;
	refs: ReadonlyMap<string, string>;
};

export type PreviewOptions = {
	/**
	 * The ids an item's transaction creates its entities with (default `ctx.ids`). A per-item seeded source
	 * (`createSeededIdSource`) keeps a recomputed preview's entities on the same ids whatever else is applied, so the
	 * Program monitor keeps playing them (spec 12 §2.5 session preview).
	 */
	idsFor?: (item: ProposalItem) => IdSource;
	/**
	 * How many items one transaction applies (default 32; 1 = one transaction per item, the reference behaviour).
	 * A batch copies the document's records once instead of once per item; its ghosts are attributed to the items
	 * exactly (by the ids each item's commands create and the entities each one names), and a batch whose changes
	 * cannot be attributed that way is applied again one item at a time.
	 */
	batch?: number;
	/** A preview of the same document to start from where it went the same way (its checkpoints). */
	reuse?: ProposalPreview | null;
	/**
	 * Keep each batch near this many milliseconds of work (`clock`, default `performance.now`): the batch size starts
	 * at 4 and doubles or shrinks after each batch (1…`batch`). The editor's sliced preview passes its slice length, so
	 * one batch never holds the main thread much longer than a slice. The result does not depend on the sizes.
	 */
	batchMs?: number;
	clock?: () => number;
};

/**
 * Work done by previews since the last reset (tests and benchmarks read it; robust to the machine's load):
 * transactions applied, items they carried, batches applied one item at a time instead, and invariant checks.
 */
export type PreviewStats = { transactions: number; items: number; fallbacks: number; checks: number };
let stats: PreviewStats = { transactions: 0, items: 0, fallbacks: 0, checks: 0 };
export function previewStats(reset = false): PreviewStats {
	const out = stats;
	if (reset) stats = { transactions: 0, items: 0, fallbacks: 0, checks: 0 };
	return out;
}

/** Why a preview item failed when it breaks an invariant only together with the items before it (`{0}`: the issue). */
export const PREVIEW_CONFLICT_TEMPLATE = 'conflicts with the items before it: {0}';
/** Texts of the proposal model the editor translates (model strings; `{0}` is filled in, never translated). */
export const PROPOSAL_MODEL_STRINGS: readonly string[] = [PREVIEW_CONFLICT_TEMPLATE];

/** Default number of items per preview transaction. */
export const PREVIEW_BATCH = 32;
/** Invariant conflicts resolved one by one at the end of a preview before the rest is left to Apply. */
const MAX_VERIFY_PASSES = 50;

/**
 * Applies the requested items ('undecided' = every pending or stale item) and what they require on top of `doc`, in
 * proposal order with refs carried over, attributing every ghost to its item. For previews only: what is committed is
 * `composeAcceptTx`'s single transaction. Invalid and accepted items are not applied; an item whose requirement failed
 * fails too. With `ctx.checkInvariants` (default) the result is checked as Apply checks its transaction (the document
 * with the items applied); when it breaks an invariant, the first item after which the document does is found
 * (bisection over the batches already built) and fails with the issue, and the rest is applied again without it —
 * so items that each apply but break an invariant together are flagged in the preview, not only at Apply.
 */
export function previewProposal(
	doc: ProjectDocument,
	p: Proposal,
	itemIds: readonly string[] | 'undecided',
	ctx: ProposalContext,
	opts: PreviewOptions = {},
): ProposalPreview {
	const run = previewProposalSteps(doc, p, itemIds, ctx, opts);
	for (;;) {
		const step = run.next();
		if (step.done) return step.value;
	}
}

type Batch = {
	/** Closure positions [start, end) behind this batch. */
	start: number;
	end: number;
	doc: ProjectDocument;
	refs: Map<string, string>;
	/** Items applied by this batch, in order. */
	applied: string[];
};

const EMPTY_GHOST = (): ProposalGhost => ({ created: [], changed: [], deleted: [] });

/** Ids and temp refs named anywhere in a command set (clipboard payloads and presets are data, not references). */
function namedIds(commands: readonly unknown[], refs: Readonly<Record<string, string>>): Set<string> {
	const out = new Set<string>();
	const walk = (v: unknown, depth: number) => {
		if (depth > 32) return;
		if (typeof v === 'string') {
			const ref = v.startsWith('$') ? refs[v] : undefined;
			if (ref) out.add(ref);
			else if (looksLikeId(v)) out.add(v);
		} else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
		else if (v && typeof v === 'object')
			for (const [k, x] of Object.entries(v)) if (k !== 'payload' && k !== 'preset') walk(x, depth + 1);
	};
	for (const c of commands) walk(c, 0);
	return out;
}

/** The document diff of a batch with every entity's parent clip (for nested ones) — `proposalGhost` with parents. */
function batchDiff(before: ProjectDocument, after: ProjectDocument) {
	const diff = diffDocuments(before, after);
	const nested: { id: string; parent: string; kind: 'created' | 'changed' | 'deleted' }[] = [];
	const changedClips = new Set(diff.changed);
	for (const [sid, seq] of Object.entries(after.sequences)) {
		const prevSeq = before.sequences[sid];
		if (!prevSeq || prevSeq === seq) continue;
		for (const id of changedClips) {
			const a = prevSeq.clips[id];
			const b = seq.clips[id];
			if (!a || !b) continue;
			const na = nestedEntities(a);
			const nb = nestedEntities(b);
			for (const [k, v] of nb) {
				if (!na.has(k)) nested.push({ id: k, parent: id, kind: 'created' });
				else if (!same(na.get(k), v)) nested.push({ id: k, parent: id, kind: 'changed' });
			}
			for (const k of na.keys()) if (!nb.has(k)) nested.push({ id: k, parent: id, kind: 'deleted' });
		}
	}
	return { diff, nested };
}

/**
 * `previewProposal` in steps: the generator yields after each batch of items (how many of how many are done) and after
 * each step of the invariant check, and returns the preview, so a caller can spread a large proposal's preview over
 * several turns of the event loop (the editor's review keeps the main thread responsive with hundreds of items).
 * Pure; never throws.
 */
export function* previewProposalSteps(
	doc: ProjectDocument,
	p: Proposal,
	itemIds: readonly string[] | 'undecided',
	ctx: ProposalContext,
	opts: PreviewOptions = {},
): Generator<{ done: number; total: number }, ProposalPreview, void> {
	const requested =
		itemIds === 'undecided'
			? p.items.filter((it) => it.state === 'pending' || it.state === 'stale').map((it) => it.id)
			: itemIds;
	const closure = dependencyClosure(p, requested, (it) => it.state === 'accepted' || it.state === 'invalid');
	const total = closure.length;
	const shared = ctx.ids ?? createRandomIdSource();
	const maxBatch = Math.max(1, Math.min(512, Math.floor(opts.batch ?? PREVIEW_BATCH) || 1));
	const batchMs =
		typeof opts.batchMs === 'number' && Number.isFinite(opts.batchMs) && opts.batchMs > 0
			? opts.batchMs
			: null;
	const perf = (globalThis as { performance?: { now(): number } }).performance;
	const clock = opts.clock ?? (() => perf?.now() ?? Date.now());
	let batchSize = batchMs === null ? maxBatch : Math.min(4, maxBatch);
	const verify = ctx.checkInvariants !== false;
	const effects = { effects: ctx.registries.effects };
	const mode = ctx.invariants ?? 'incremental';
	const commandsOf = closure.map((it) => selectedCommands(it));

	const failed: Record<string, Issue[]> = {};
	/** Items failed by the end-of-preview invariant check (kept when the rest is applied again). */
	const conflicts = new Map<string, Issue[]>();
	const items: Record<string, ProposalGhost> = {};
	let batches: Batch[] = [];
	const txCtx = (ids: IdSource, onCommand?: (i: number) => void) => ({
		ids,
		now: ctx.now ?? (() => new Date().toISOString()),
		revision: ctx.revision ?? 0,
		registries: ctx.registries,
		...(ctx.invariants ? { invariants: ctx.invariants } : {}),
		// the batches apply without the check; the result is checked once at the end (`verify`)
		checkInvariants: false,
		...(onCommand ? { onCommand } : {}),
	});
	const tx = (label: string, commands: unknown[]) => ({
		label,
		origin: { agent: 'proposal-preview' },
		...(p.sequenceId ? { sequenceId: p.sequenceId } : {}),
		commands,
	});

	/** One item alone (the reference behaviour); records its ghost or its failure. */
	const applyOne = (cur: ProjectDocument, it: ProposalItem, k: number, refs: Map<string, string>) => {
		let r: ReturnType<typeof applyTransaction>;
		try {
			const commands = commandsOf[k]!.map((c) => substituteKnownRefs(c, refs));
			stats.transactions++;
			stats.items++;
			r = applyTransaction(cur, tx(it.label, commands), txCtx(opts.idsFor?.(it) ?? shared));
		} catch (e) {
			failed[it.id] = [
				{ commandIndex: -1, code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) },
			];
			return cur;
		}
		if (!r.result.ok) {
			failed[it.id] = r.result.errors;
			return cur;
		}
		for (const [key, v] of Object.entries(r.result.refs)) refs.set(key, v);
		items[it.id] = proposalGhost(cur, r.document);
		return r.document;
	};

	/**
	 * Items `list` (closure positions) in ONE transaction on `cur`. Returns the document, or a position to retry
	 * without (its command failed), or null (the batch cannot be applied or attributed as one: one by one instead).
	 */
	const applyBatch = (
		cur: ProjectDocument,
		list: number[],
		refs: Map<string, string>,
	): { doc: ProjectDocument; refs: Record<string, string> } | { drop: number; errors: Issue[] } | null => {
		const commands: unknown[] = [];
		const starts: number[] = [];
		const own: unknown[][] = [];
		for (const k of list) {
			starts.push(commands.length);
			const mine = commandsOf[k]!.map((c) => substituteKnownRefs(c, refs));
			own.push(mine);
			commands.push(...mine);
		}
		const owners = new Map<string, number>();
		let at = -1;
		let src: IdSource = shared;
		const ids: IdSource = {
			next(prefix) {
				const id = src.next(prefix);
				if (at >= 0) owners.set(id, list[at]!);
				return id;
			},
		};
		const onCommand = (i: number) => {
			while (at + 1 < list.length && starts[at + 1]! <= i) {
				at++;
				const it = closure[list[at]!]!;
				src = opts.idsFor?.(it) ?? shared;
			}
		};
		let r: ReturnType<typeof applyTransaction>;
		stats.transactions++;
		stats.items += list.length;
		try {
			r = applyTransaction(cur, tx('Proposal preview', commands), txCtx(ids, onCommand));
		} catch {
			return null;
		}
		if (!r.result.ok) {
			const idx = r.result.errors[0]?.commandIndex ?? -1;
			if (idx < 0) return null;
			let j = 0;
			while (j + 1 < list.length && starts[j + 1]! <= idx) j++;
			const offset = starts[j]!;
			return {
				drop: list[j]!,
				errors: r.result.errors.map((e) =>
					e.commandIndex >= 0 ? { ...e, commandIndex: e.commandIndex - offset } : e,
				),
			};
		}
		const result = r.result;
		const next = r.document;
		// Attribution: what an item's own ids created is its; anything else belongs to the one item that names it.
		const named = own.map((mine) => namedIds(mine, result.refs));
		const namedBy = (id: string): number | null => {
			let hit: number | null = null;
			for (let j = 0; j < list.length; j++) {
				if (!named[j]!.has(id)) continue;
				if (hit !== null) return null;
				hit = list[j]!;
			}
			return hit;
		};
		// An entity one item created and a later item of the batch names may have been changed by that item too, which
		// the batch's diff cannot tell: such a batch is applied one item at a time.
		for (let j = 1; j < list.length; j++)
			for (const id of named[j]!) {
				const by = owners.get(id);
				if (by !== undefined && by !== list[j] && list.indexOf(by) < j) return null;
			}
		const sequenceOrProject = (id: string) => id === next.projectId || Object.hasOwn(next.sequences, id);
		const ghosts = new Map<number, ProposalGhost>(list.map((k) => [k, EMPTY_GHOST()]));
		const { diff, nested } = batchDiff(cur, next);
		const ownerOf = new Map<string, number>();
		const put = (id: string, kind: keyof ProposalGhost, owner: number) => {
			ghosts.get(owner)![kind].push(id);
			if (!ownerOf.has(id)) ownerOf.set(id, owner);
		};
		const containers: string[] = [];
		for (const kind of ['created', 'changed', 'deleted'] as const)
			for (const id of diff[kind]) {
				if (kind === 'changed' && sequenceOrProject(id)) {
					containers.push(id);
					continue;
				}
				let owner = kind === 'created' ? (owners.get(id) ?? null) : null;
				if (owner === null) owner = namedBy(id);
				if (owner === null) return null;
				put(id, kind, owner);
			}
		// A sequence's own fields changed: exact only when that is its track list gaining or losing tracks of ONE item
		// (kept tracks in their order); the project's own fields (name, settings, bin order): one item at a time.
		for (const id of containers) {
			if (id === next.projectId) return null;
			const by = trackListOwners(cur.sequences[id], next.sequences[id], ownerOf);
			if (by === null) return null;
			for (const owner of list) if (by.has(owner)) put(id, 'changed', owner);
		}
		for (const n of nested) {
			const owner = owners.get(n.id) ?? ownerOf.get(n.parent) ?? namedBy(n.id);
			if (owner === undefined || owner === null) return null;
			put(n.id, n.kind, owner);
		}
		for (const [k, g] of ghosts) items[closure[k]!.id] = g;
		return { doc: next, refs: result.refs };
	};

	/** Applies closure positions [from, total) on `cur`, batch by batch, appending to `batches`. */
	function* build(from: number, cur: ProjectDocument, refsIn: ReadonlyMap<string, string>) {
		let pos = from;
		let doc0 = cur;
		const refs = new Map(refsIn);
		while (pos < total) {
			const start = pos;
			const end = Math.min(total, pos + batchSize);
			const applied: string[] = [];
			// items whose requirement failed fail too; the rest is tried together
			let list: number[] = [];
			const take = (k: number) => {
				const it = closure[k]!;
				const missing = it.requires.find((r) => failed[r] || conflicts.has(r));
				if (conflicts.has(it.id)) return false;
				if (missing) {
					failed[it.id] = [
						{ commandIndex: -1, code: 'E_NOT_FOUND', message: `requires item ${missing}, which failed` },
					];
					return false;
				}
				return true;
			};
			for (let k = start; k < end; k++) if (take(k)) list.push(k);
			let next = doc0;
			const t0 = batchMs === null ? 0 : clock();
			if (maxBatch === 1 || list.length <= 1) {
				for (const k of list) {
					next = applyOne(next, closure[k]!, k, refs);
					if (!failed[closure[k]!.id]) applied.push(closure[k]!.id);
				}
			} else {
				for (let attempt = 0; ; attempt++) {
					const r = list.length ? applyBatch(doc0, list, refs) : { doc: doc0, refs: {} };
					if (r && 'doc' in r) {
						for (const [key, v] of Object.entries(r.refs)) refs.set(key, v);
						for (const k of list) applied.push(closure[k]!.id);
						next = r.doc;
						break;
					}
					if (r === null || attempt > list.length) {
						// one by one: exact attribution and failures, as the reference behaviour
						stats.fallbacks++;
						next = doc0;
						for (const k of list) {
							const it = closure[k]!;
							if (it.requires.some((q) => failed[q] || conflicts.has(q))) {
								failed[it.id] ??= [
									{
										commandIndex: -1,
										code: 'E_NOT_FOUND',
										message: `requires item ${it.requires.find((q) => failed[q] || conflicts.has(q))}, which failed`,
									},
								];
								continue;
							}
							const d = applyOne(next, it, k, refs);
							if (!failed[it.id]) applied.push(it.id);
							next = d;
						}
						break;
					}
					// its command failed: it fails (and what requires it), the others are tried again together
					failed[closure[r.drop]!.id] = r.errors;
					list = list.filter((k) => k !== r.drop && take(k));
				}
			}
			batches.push({ start, end, doc: next, refs: new Map(refs), applied });
			doc0 = next;
			pos = end;
			if (batchMs !== null && list.length > 0) {
				const took = clock() - t0;
				if (took < batchMs / 2) batchSize = Math.min(maxBatch, batchSize * 2);
				else if (took > batchMs)
					batchSize = Math.max(1, Math.min(batchSize - 1, Math.floor((batchSize * batchMs) / took)));
			}
			yield { done: pos, total };
		}
	}

	// A preview of the same document that started the same way: resume after its last matching checkpoint.
	let from = 0;
	let startDoc = doc;
	let startRefs: ReadonlyMap<string, string> = appliedRefs(p);
	const reuse = opts.reuse;
	if (reuse?.checkpoints?.length && reuse.checkpoints[0]!.doc !== undefined) {
		const refsKey = JSON.stringify([...startRefs]);
		for (const cp of reuse.checkpoints) {
			if (cp.count > total || (cp as PreviewCheckpointInternal).base !== doc) break;
			if ((cp as PreviewCheckpointInternal).refsKey !== refsKey) break;
			if ((cp as PreviewCheckpointInternal).verified !== verify) break;
			let sameWay = true;
			for (let k = 0; k < cp.count; k++) {
				const a = cp.items[k]!;
				const it = closure[k]!;
				if (
					a.id !== it.id ||
					a.alternative !== (it.selectedAlternative ?? 0) ||
					!sameCommands(a.commands, commandsOf[k]!)
				) {
					sameWay = false;
					break;
				}
			}
			if (!sameWay) break;
			from = cp.count;
			startDoc = cp.doc;
			startRefs = cp.refs;
		}
		if (from > 0) {
			const behind = new Set(closure.slice(0, from).map((it) => it.id));
			for (const [id, g] of Object.entries(reuse.items)) if (behind.has(id)) items[id] = g;
			for (const [id, e] of Object.entries(reuse.failed)) if (behind.has(id)) failed[id] = e;
			batches.push({
				start: 0,
				end: from,
				doc: startDoc,
				refs: new Map(startRefs),
				applied: reuse.applied.filter((id) => behind.has(id)),
			});
		}
	}
	yield* build(from, startDoc, startRefs);

	// The invariants, as Apply checks them: on the document with every item applied. A failure is pinned on the first
	// item after which the document breaks one (bisection over the batches, then within the batch), which fails; the
	// rest is applied again without it.
	if (verify && total > 0 && passes(doc, doc)) {
		for (let pass = 0; pass < MAX_VERIFY_PASSES; pass++) {
			const last = batches.at(-1)?.doc ?? doc;
			const issues = check(doc, last);
			yield { done: total, total };
			if (issues.length === 0) break;
			// the first batch whose document fails (the base passes)
			let lo = 0;
			let hi = batches.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (check(doc, batches[mid]!.doc).length) hi = mid;
				else lo = mid + 1;
				yield { done: total, total };
			}
			const b = batches[lo]!;
			const before = lo > 0 ? batches[lo - 1]!.doc : doc;
			const beforeRefs = lo > 0 ? batches[lo - 1]!.refs : appliedRefs(p);
			// within it: the shortest prefix of its applied items that fails
			const order = b.applied;
			let a = 1;
			let z = order.length;
			while (a < z) {
				const mid = (a + z) >> 1;
				const d = replay(before, beforeRefs, order.slice(0, mid));
				if (d === null || check(doc, d).length) z = mid;
				else a = mid + 1;
				yield { done: total, total };
			}
			const culprit = order[a - 1];
			if (!culprit) break;
			const firstIssues = check(doc, replay(before, beforeRefs, order.slice(0, a)) ?? last);
			conflicts.set(culprit, firstIssues.length ? firstIssues : issues);
			// everything from that batch on is applied again (failures there are re-evaluated)
			for (let k = b.start; k < total; k++) {
				const id = closure[k]!.id;
				delete items[id];
				if (!conflicts.has(id)) delete failed[id];
			}
			const keepRefs = new Map(beforeRefs);
			batches = batches.slice(0, lo);
			yield* build(b.start, before, keepRefs);
		}
	}
	for (const [id, issues] of conflicts)
		failed[id] = issues.map((e) => ({
			...e,
			message: PREVIEW_CONFLICT_TEMPLATE.replace('{0}', e.message),
		}));

	const applied = batches.flatMap((b) => b.applied).filter((id) => !failed[id]);
	const result = batches.at(-1)?.doc ?? doc;
	// the whole preview's ghost is its own step (a diff of the two documents)
	yield { done: total, total };
	const checkpoints: PreviewCheckpointInternal[] = [];
	const refsKey = JSON.stringify([...appliedRefs(p)]);
	for (const b of batches)
		checkpoints.push({
			count: b.end,
			items: closure.slice(0, b.end).map((it, k) => ({
				id: it.id,
				alternative: it.selectedAlternative ?? 0,
				commands: commandsOf[k]!,
			})),
			doc: b.doc,
			refs: b.refs,
			base: doc,
			refsKey,
			verified: verify,
		});
	return {
		document: result,
		ghost: proposalGhost(doc, result),
		items: Object.fromEntries(applied.map((id) => [id, items[id] ?? EMPTY_GHOST()])),
		failed,
		applied,
		checkpoints,
	};

	function check(base: ProjectDocument, d: ProjectDocument): Issue[] {
		stats.checks++;
		try {
			return checkTransactionInvariants(base, d, effects, mode);
		} catch (e) {
			return [{ commandIndex: -1, code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) }];
		}
	}
	function passes(base: ProjectDocument, d: ProjectDocument): boolean {
		return isVerifiedDocument(d, effects) || check(base, d).length === 0;
	}
	/** Items `ids` (applied before, in order) again on `cur` in one transaction; null when that fails. */
	function replay(cur: ProjectDocument, refsIn: ReadonlyMap<string, string>, ids: readonly string[]) {
		const pos = new Map(closure.map((it, k) => [it.id, k]));
		const list = ids.map((id) => pos.get(id)!).filter((k) => k !== undefined);
		const saved = { ...items };
		const r = applyBatch(cur, list, new Map(refsIn));
		// a replay only probes: the ghosts it attributed are not kept
		for (const k of Object.keys(items)) if (!(k in saved)) delete items[k];
		Object.assign(items, saved);
		if (r && 'doc' in r) return r.doc;
		if (r === null) {
			let d = cur;
			const refs = new Map(refsIn);
			for (const k of list) {
				const commands = commandsOf[k]!.map((c) => substituteKnownRefs(c, refs));
				const it = closure[k]!;
				stats.transactions++;
				stats.items++;
				const one = applyTransaction(d, tx(it.label, commands), txCtx(opts.idsFor?.(it) ?? shared));
				if (!one.result.ok) return null;
				for (const [key, v] of Object.entries(one.result.refs)) refs.set(key, v);
				d = one.document;
			}
			return d;
		}
		return null;
	}
}

const trackIds = (s: Sequence) => [...s.videoTracks, ...s.audioTracks, ...s.captionTracks].map((t) => t.id);

/**
 * The batch items that changed sequence `a` → `b`'s own fields, when that change is only its track list gaining or
 * losing tracks (each such item changed it, as it would alone; tracks are attributed already in `ownerOf`), the other
 * tracks keeping their order and every other own field unchanged; else null.
 */
function trackListOwners(
	a: Sequence | undefined,
	b: Sequence | undefined,
	ownerOf: ReadonlyMap<string, number>,
): Set<number> | null {
	if (!a || !b) return null;
	if (
		a.settings !== b.settings ||
		a.master !== b.master ||
		a.inPoint !== b.inPoint ||
		a.outPoint !== b.outPoint ||
		a.workArea !== b.workArea
	)
		return null;
	const sa = (a as { soundDesign?: SoundDesign }).soundDesign;
	const sb = (b as { soundDesign?: SoundDesign }).soundDesign;
	if (!sa !== !sb || sa?.settings !== sb?.settings || sa?.lastCheck !== sb?.lastCheck) return null;
	const before = trackIds(a);
	const after = trackIds(b);
	const kept = new Set(before.filter((id) => after.includes(id)));
	if (before.filter((id) => kept.has(id)).join() !== after.filter((id) => kept.has(id)).join()) return null;
	const owners = new Set<number>();
	for (const id of [...before.filter((t) => !kept.has(t)), ...after.filter((t) => !kept.has(t))]) {
		const o = ownerOf.get(id);
		if (o === undefined) return null;
		owners.add(o);
	}
	return owners.size ? owners : null;
}

type PreviewCheckpointInternal = PreviewCheckpoint & {
	base: ProjectDocument;
	refsKey: string;
	verified: boolean;
};

function sameCommands(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !same(a[i], b[i])) return false;
	return true;
}
