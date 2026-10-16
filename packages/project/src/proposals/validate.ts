// Creating, validating and re-validating proposals against a document (spec 12 §2.5, P3-R1). Everything is a dry run
// of ordinary transactions: an item is valid when its dependency closure applies to the document; the whole proposal
// is valid when every valid item applies together. Never throws: problems are typed issues or item states.
import { resolveAgentAddresses } from '../agent/addressing.ts';
import { unknownCommandKeyIssues } from '../agent/strict.ts';
import { utf8Length } from '../clipboard/payload.ts';
import { applyTransaction } from '../commands/apply.ts';
import { COMMAND_CATALOG, isCommandType } from '../commands/catalog.ts';
import type { Issue, Origin, Registries, TransactionResult } from '../commands/types.ts';
import { createRandomIdSource, type IdSource } from '../ids.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Author } from '../schema/sequence.ts';
import {
	type AnchorProblem,
	anchorProblem,
	anchorProblemText,
	commandEntityIds,
	documentHash,
	itemAnchors,
} from './anchors.ts';
import { type ComposedAccept, composeAcceptTx, itemOfCommand } from './compose.ts';
import {
	PROPOSAL_LIMITS,
	type Proposal,
	type ProposalDraft,
	ProposalDraftSchema,
	type ProposalIssue,
	type ProposalItem,
	ProposalSchema,
	selectedCommands,
} from './schema.ts';
import { dependents, proposalStructureIssues } from './structure.ts';

/** What dry runs need: the registries of the document's session or engine. */
export type ProposalContext = {
	registries: Registries;
	/** Revision of the document (dry runs report it; default 0). */
	revision?: number;
	/** Ids of dry-run entities (default random: never collides with the document's). */
	ids?: IdSource;
	now?: () => string;
	invariants?: 'full' | 'incremental' | 'verify';
	/** Run the invariant checker in dry runs (default true). */
	checkInvariants?: boolean;
};

const VALIDATE_ORIGIN: Origin = { agent: 'proposal-validation' };
/** Conflicts resolved one by one in the whole-proposal dry run before the rest is given up. */
const MAX_CONFLICT_PASSES = 50;

function truncate(s: string, max = PROPOSAL_LIMITS.maxReason): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "E_OVERLAP: …" for the first issue of a failed transaction. */
export function issueReason(errors: readonly Pick<Issue, 'code' | 'message'>[]): string {
	const e = errors[0];
	return truncate(e ? `${e.code}: ${e.message}` : 'the commands fail');
}

/** Dry-runs commands on `doc` (nothing changes). Never throws. */
export function dryRunCommands(
	doc: ProjectDocument,
	commands: readonly unknown[],
	ctx: ProposalContext,
	sequenceId?: string | null,
): TransactionResult {
	const ids = ctx.ids ?? createRandomIdSource();
	return applyTransaction(
		doc,
		{
			label: 'Validate proposal',
			origin: VALIDATE_ORIGIN,
			dryRun: true,
			...(sequenceId ? { sequenceId } : {}),
			commands,
		},
		{
			ids,
			now: ctx.now ?? (() => new Date().toISOString()),
			revision: ctx.revision ?? 0,
			registries: ctx.registries,
			...(ctx.invariants ? { invariants: ctx.invariants } : {}),
			...(ctx.checkInvariants === false ? { checkInvariants: false } : {}),
		},
	).result;
}

/** Composes `itemIds` regardless of their review state (validation's view), or the refusal. */
function composeForCheck(p: Proposal, itemIds: readonly string[]) {
	// States other than accepted / invalid do not matter to a dry run: view them as pending.
	const view: Proposal = {
		...p,
		items: p.items.map((it) =>
			it.state === 'accepted' || it.state === 'invalid' ? it : { ...it, state: 'pending' as const },
		),
	};
	return composeAcceptTx(view, itemIds, VALIDATE_ORIGIN, { maxCommands: Number.POSITIVE_INFINITY });
}

function setState(it: ProposalItem, state: ProposalItem['state'], reason?: string): ProposalItem {
	if (it.state === state && it.reason === reason) return it;
	const { reason: _r, ...rest } = it;
	return reason !== undefined ? { ...rest, state, reason: truncate(reason) } : { ...rest, state };
}

/**
 * Validates every item of a proposal against `doc`: each pending item's dependency closure is dry-run (failing items
 * become `invalid` with the reason, and so do the items that require them); then every valid item together (an item
 * that conflicts with the items before it becomes `invalid`). Records each item's anchors. Accepted, rejected and
 * already invalid items are left as they are.
 */
export function validateProposal(doc: ProjectDocument, proposal: Proposal, ctx: ProposalContext): Proposal {
	const items = new Map(proposal.items.map((it) => [it.id, it]));
	const current = (): Proposal => ({ ...proposal, items: proposal.items.map((it) => items.get(it.id)!) });
	const invalidate = (id: string, reason: string) => {
		items.set(id, setState(items.get(id)!, 'invalid', reason));
		for (const d of dependents(current(), id))
			if (items.get(d.id)!.state !== 'accepted' && items.get(d.id)!.state !== 'invalid')
				items.set(d.id, setState(items.get(d.id)!, 'invalid', `requires item ${id}, which is invalid`));
	};
	// The whole set first, with the invariant checker. When it holds, each item's own dry run only has to show that
	// its commands apply without the other items (handlers refuse what is missing); the invariants were checked on
	// the full set, and `planAccept` checks the exact set it applies again. This keeps 2 000 items affordable.
	const undecided = proposal.items
		.filter((it) => it.state === 'pending' || it.state === 'stale')
		.map((it) => it.id);
	const whole = undecided.length ? composeForCheck(current(), undecided) : null;
	const wholeOk = !!whole?.ok && dryRunCommands(doc, whole.tx.commands, ctx, proposal.sequenceId).ok;
	const itemCtx: ProposalContext = wholeOk ? { ...ctx, checkInvariants: false } : ctx;
	for (const it0 of proposal.items) {
		const it = items.get(it0.id)!;
		if (it.state !== 'pending' && it.state !== 'stale') continue;
		const composed = composeForCheck(current(), [it.id]);
		if (!composed.ok) {
			invalidate(it.id, issueReason(composed.errors));
			continue;
		}
		const r = dryRunCommands(doc, composed.tx.commands, itemCtx, proposal.sequenceId);
		if (!r.ok) {
			const at = r.errors[0] ? itemOfCommand(composed.ranges, r.errors[0].commandIndex) : null;
			invalidate(
				it.id,
				at && at !== it.id ? `with item ${at}: ${issueReason(r.errors)}` : issueReason(r.errors),
			);
			continue;
		}
		items.set(it.id, setState(it, 'pending'));
	}
	// Everything valid together: an item that conflicts with the items before it is invalid.
	const stillAll = current().items.filter((it) => it.state === 'pending').length === undecided.length;
	for (let pass = 0; !(wholeOk && stillAll); pass++) {
		const p = current();
		const live = p.items.filter((it) => it.state === 'pending').map((it) => it.id);
		if (live.length === 0) break;
		if (pass >= MAX_CONFLICT_PASSES) {
			for (const id of live) invalidate(id, 'not validated: too many items conflict with each other');
			break;
		}
		const composed = composeForCheck(p, live);
		if (!composed.ok) break; // only invalid items could refuse, and they were filtered out
		const r = dryRunCommands(doc, composed.tx.commands, ctx, proposal.sequenceId);
		if (r.ok) break;
		const culprit = conflictingItem(doc, p, composed, r.errors, ctx);
		if (!culprit) {
			for (const id of live) invalidate(id, `the items do not apply together: ${issueReason(r.errors)}`);
			break;
		}
		invalidate(culprit, `conflicts with the items before it: ${issueReason(r.errors)}`);
	}
	const out = current();
	return {
		...out,
		items: out.items.map((it) =>
			it.state === 'pending' ? { ...it, anchors: itemAnchors(doc, selectedCommands(it)) } : it,
		),
	};
}

/**
 * The item whose commands make a composed transaction fail: the one owning the failing command, else (a
 * transaction-level failure such as an invariant) the first prefix of items that fails, found by bisection.
 */
function conflictingItem(
	doc: ProjectDocument,
	p: Proposal,
	composed: ComposedAccept,
	errors: readonly Issue[],
	ctx: ProposalContext,
): string | null {
	const idx = errors[0]?.commandIndex ?? -1;
	if (idx >= 0) return itemOfCommand(composed.ranges, idx);
	const order = composed.itemIds;
	let lo = 1;
	let hi = order.length; // the whole fails; find the shortest failing prefix
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const c = composeForCheck(p, order.slice(0, mid));
		const ok = c.ok && dryRunCommands(doc, c.tx.commands, ctx, p.sequenceId).ok;
		if (ok) lo = mid + 1;
		else hi = mid;
	}
	return order[lo - 1] ?? null;
}

export type CreateProposalMeta = {
	id: string;
	projectId: string;
	author: Author;
	/** ISO time of creation. */
	now: string;
	/** Revision of `doc`. */
	revision: number;
};

/**
 * Builds and validates a proposal from a creator's draft (untrusted). Refuses malformed drafts with typed issues
 * (schema, unknown keys, structure, limits, unknown sequence); document-dependent failures make items `invalid`.
 * Agent addressing forms (`mediaByName`, `clipAt`, …) are resolved against `doc` and stored resolved.
 */
export function createProposal(
	doc: ProjectDocument,
	draftIn: unknown,
	meta: CreateProposalMeta,
	ctx: ProposalContext,
): { ok: true; proposal: Proposal } | { ok: false; errors: ProposalIssue[] } {
	try {
		return createProposalUnchecked(doc, draftIn, meta, ctx);
	} catch (e) {
		return {
			ok: false,
			errors: [{ code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) }],
		};
	}
}

function createProposalUnchecked(
	doc: ProjectDocument,
	draftIn: unknown,
	meta: CreateProposalMeta,
	ctx: ProposalContext,
): { ok: true; proposal: Proposal } | { ok: false; errors: ProposalIssue[] } {
	const parsed = ProposalDraftSchema.safeParse(draftIn);
	if (!parsed.success)
		return {
			ok: false,
			errors: parsed.error.issues.slice(0, 50).map((i) => ({
				code: 'E_SCHEMA',
				message: `${i.path.join('.') || 'proposal'}: ${i.message}`,
				path: i.path.map((x) => (typeof x === 'number' ? x : String(x))),
			})),
		};
	const draft: ProposalDraft = parsed.data;
	const errors: ProposalIssue[] = proposalStructureIssues(draft.items);
	const sequenceId = draft.sequenceId ?? null;
	if (sequenceId !== null && !Object.hasOwn(doc.sequences, sequenceId))
		errors.push({ code: 'E_NOT_FOUND', message: `Sequence not found: ${sequenceId}`, path: ['sequenceId'] });
	const sets = (it: ProposalDraft['items'][number]) => [
		{ path: ['commands'] as (string | number)[], commands: it.commands },
		...(it.alternatives ?? []).map((a, k) => ({
			path: ['alternatives', k, 'commands'],
			commands: a.commands,
		})),
	];
	draft.items.forEach((it, i) => {
		for (const s of sets(it))
			for (const issue of unknownCommandKeyIssues(s.commands))
				errors.push({
					code: issue.code,
					message: `item ${it.id}: ${issue.message}`,
					itemId: it.id,
					path: ['items', i, ...s.path, issue.commandIndex],
				});
	});
	if (errors.length) return { ok: false, errors: errors.slice(0, 100) };

	// Addressing forms resolve against the document now; an item whose address fails is invalid.
	const addressFailures = new Map<string, string>();
	const resolve = (id: string, commands: Record<string, unknown>[]) => {
		const r = resolveAgentAddresses(doc, commands, sequenceId ? { sequenceId } : {});
		if (r.ok) return r.commands as Record<string, unknown>[];
		if (!addressFailures.has(id)) addressFailures.set(id, issueReason(r.errors));
		return commands;
	};
	const items: ProposalItem[] = draft.items.map((it) => {
		const commands = resolve(it.id, it.commands);
		const alternatives = it.alternatives?.map((a) => ({ ...a, commands: resolve(it.id, a.commands) }));
		return {
			id: it.id,
			label: it.label,
			group: it.group ?? '',
			commands,
			requires: [...new Set(it.requires ?? [])],
			...(it.meta !== undefined ? { meta: it.meta } : {}),
			...(alternatives?.length ? { alternatives } : {}),
			...(it.selectedAlternative ? { selectedAlternative: it.selectedAlternative } : {}),
			state: 'pending' as const,
		};
	});
	// Command shapes (after addressing): a malformed command is the creator's error, not a document problem.
	items.forEach((it, i) => {
		if (addressFailures.has(it.id)) return;
		const all = [
			{ path: ['commands'] as (string | number)[], commands: it.commands },
			...(it.alternatives ?? []).map((a, k) => ({
				path: ['alternatives', k, 'commands'],
				commands: a.commands,
			})),
		];
		for (const s of all)
			s.commands.forEach((c, ci) => {
				const type = c.type;
				if (!isCommandType(type)) {
					errors.push({
						code: 'E_SCHEMA',
						message: `item ${it.id}: unknown command type ${JSON.stringify(type)}`,
						itemId: it.id,
						path: ['items', i, ...s.path, ci, 'type'],
					});
					return;
				}
				const r = COMMAND_CATALOG[type].schema.safeParse(c);
				if (!r.success)
					errors.push({
						code: 'E_SCHEMA',
						message:
							`item ${it.id}: ${type}: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? 'invalid'}`.trim(),
						itemId: it.id,
						path: ['items', i, ...s.path, ci],
					});
			});
	});
	if (errors.length) return { ok: false, errors: errors.slice(0, 100) };

	const proposal: Proposal = {
		version: 1,
		id: meta.id,
		projectId: meta.projectId,
		sequenceId,
		feature: draft.feature,
		title: draft.title,
		summary: draft.summary ?? '',
		author: meta.author,
		createdAt: meta.now,
		updatedAt: meta.now,
		baseRevision: meta.revision,
		docHash: documentHash(doc),
		items: items.map((it) =>
			addressFailures.has(it.id) ? setState(it, 'invalid', addressFailures.get(it.id)!) : it,
		),
		...(draft.report !== undefined ? { report: draft.report } : {}),
	};
	let bytes = 0;
	try {
		bytes = utf8Length(JSON.stringify(proposal));
	} catch {
		bytes = Number.POSITIVE_INFINITY;
	}
	if (bytes > PROPOSAL_LIMITS.maxBytes)
		return {
			ok: false,
			errors: [
				{
					code: 'E_LIMIT',
					message: `A proposal may be at most ${PROPOSAL_LIMITS.maxBytes} bytes (got ${bytes})`,
				},
			],
		};
	// Items requiring an address-invalid item are invalid too; validation then dry-runs the rest.
	let withDeps = proposal;
	for (const id of addressFailures.keys())
		withDeps = {
			...withDeps,
			items: withDeps.items.map((it) =>
				dependents(withDeps, id).some((d) => d.id === it.id) && it.state === 'pending'
					? setState(it, 'invalid', `requires item ${id}, which is invalid`)
					: it,
			),
		};
	const validated = validateProposal(doc, withDeps, { ...ctx, revision: meta.revision });
	const check = ProposalSchema.safeParse(validated);
	if (!check.success)
		return {
			ok: false,
			errors: [{ code: 'E_SCHEMA', message: `proposal: ${check.error.issues[0]?.message ?? 'invalid'}` }],
		};
	return { ok: true, proposal: validated };
}

/**
 * Why an item is stale, for the editor to say in the user's language: an anchor moved or went (with what it was, where
 * and where to), an item it requires is stale / invalid, or it no longer applies on the document (`issue`: the reason).
 */
export type StaleProblem =
	| ({ type: 'anchor' } & AnchorProblem)
	| { type: 'requires'; itemId: string; label: string; state: 'stale' | 'invalid' }
	| { type: 'conflict'; issue: string };

export type StaleItem = { itemId: string; reason: string; problem?: StaleProblem };

/**
 * Re-validates the undecided (pending or stale) items on a changed document: an item is stale when an entity it was
 * built against is gone or moved (anchors), when an item it requires is stale or invalid, or when its dependency
 * closure no longer applies; otherwise it is pending again. Entities named by accepted items of the same proposal
 * are not anchors any more (the proposal changed them itself). Never throws.
 */
export function revalidate(
	doc: ProjectDocument,
	proposal: Proposal,
	ctx: ProposalContext,
	opts: {
		/**
		 * false: anchors and requirements only, no dry runs (the editor's preview applies every item anyway and flags the
		 * ones that fail; the accept re-validates with dry runs). Default true.
		 */
		dryRuns?: boolean;
	} = {},
): { proposal: Proposal; changed: boolean; stale: StaleItem[] } {
	const undecided = proposal.items.filter((it) => it.state === 'pending' || it.state === 'stale');
	if (undecided.length === 0) return { proposal, changed: false, stale: [] };
	// Same content as when it was validated, and nothing accepted since: every undecided item holds.
	const noneAccepted = proposal.items.every((it) => it.state !== 'accepted');
	if (noneAccepted && documentHash(doc) === proposal.docHash) {
		const items = proposal.items.map((it) => (it.state === 'stale' ? setState(it, 'pending') : it));
		const changed = items.some((it, i) => it !== proposal.items[i]);
		return { proposal: changed ? { ...proposal, items } : proposal, changed, stale: [] };
	}
	const ownTouched = new Set<string>();
	for (const it of proposal.items)
		if (it.state === 'accepted') for (const id of commandEntityIds(selectedCommands(it))) ownTouched.add(id);
	const items = new Map(proposal.items.map((it) => [it.id, it]));
	const current = (): Proposal => ({ ...proposal, items: proposal.items.map((it) => items.get(it.id)!) });
	const blockedBy = (it: ProposalItem) =>
		it.requires.map((r) => items.get(r)).find((r) => r && (r.state === 'stale' || r.state === 'invalid'));
	// Cheap checks first (anchors); then one dry run of every remaining item together, and one per item only when
	// that fails (`planAccept` dry-runs the exact set it applies in any case).
	const candidates: string[] = [];
	const problems = new Map<string, StaleProblem>();
	for (const it0 of undecided) {
		const it = items.get(it0.id)!;
		const anchors = it.anchors
			? Object.fromEntries(Object.entries(it.anchors).filter(([id]) => !ownTouched.has(id)))
			: undefined;
		const moved = anchorProblem(doc, anchors, { sequenceId: proposal.sequenceId, meta: it.meta });
		if (moved) {
			items.set(it.id, setState(it, 'stale', anchorProblemText(doc, moved)));
			problems.set(it.id, { type: 'anchor', ...moved });
		} else candidates.push(it.id);
	}
	const dryRuns = opts.dryRuns !== false;
	const together = candidates.length && dryRuns ? composeForCheck(current(), candidates) : null;
	const allHold =
		!dryRuns ||
		(together?.ok === true &&
			candidates.every((id) => {
				const blocked = blockedBy(items.get(id)!);
				return !blocked;
			}) &&
			dryRunCommands(doc, together.tx.commands, ctx, proposal.sequenceId).ok);
	for (const id of candidates) {
		const it = items.get(id)!;
		const blocked = blockedBy(it);
		if (blocked) {
			items.set(
				it.id,
				setState(it, 'stale', `Requires item ${blocked.id} (“${blocked.label}”), which is ${blocked.state}`),
			);
			problems.set(it.id, {
				type: 'requires',
				itemId: blocked.id,
				label: blocked.label,
				state: blocked.state === 'invalid' ? 'invalid' : 'stale',
			});
			continue;
		}
		if (allHold) {
			items.set(it.id, setState(it, 'pending'));
			continue;
		}
		const composed = composeForCheck(current(), [it.id]);
		if (!composed.ok) {
			const issue = issueReason(composed.errors);
			items.set(it.id, setState(it, 'stale', issue));
			problems.set(it.id, { type: 'conflict', issue });
			continue;
		}
		const r = dryRunCommands(doc, composed.tx.commands, ctx, proposal.sequenceId);
		if (r.ok) items.set(it.id, setState(it, 'pending'));
		else {
			const issue = issueReason(r.errors);
			items.set(it.id, setState(it, 'stale', issue));
			problems.set(it.id, { type: 'conflict', issue });
		}
	}
	const out = current();
	const changed = out.items.some((it, i) => it !== proposal.items[i]);
	return {
		proposal: changed ? out : proposal,
		changed,
		stale: out.items
			.filter((it) => it.state === 'stale')
			.map((it) => {
				const problem = problems.get(it.id);
				return { itemId: it.id, reason: it.reason ?? 'stale', ...(problem ? { problem } : {}) };
			}),
	};
}

export type AcceptPlan =
	| {
			ok: true;
			/** null: nothing left to apply (everything requested was stale, with `partial`, or already accepted). */
			composed: ComposedAccept | null;
			/** The proposal with re-validated states (persist it whatever happens next). */
			proposal: Proposal;
			stale: StaleItem[];
	  }
	| { ok: false; errors: ProposalIssue[]; proposal: Proposal; stale: StaleItem[] };

/**
 * Plans an accept on the current document: re-validates, takes the dependency closure of the requested items
 * ('all' = every pending or stale one), and dry-runs the composed transaction. All-or-nothing unless `partial`:
 * a stale (or newly conflicting) item then drops out with everything that requires it, and the rest is composed.
 */
export function planAccept(
	doc: ProjectDocument,
	proposal: Proposal,
	itemIds: readonly string[] | 'all',
	origin: Origin,
	ctx: ProposalContext,
	opts: { partial?: boolean; expectedRevision?: number } = {},
): AcceptPlan {
	try {
		return planAcceptUnchecked(doc, proposal, itemIds, origin, ctx, opts);
	} catch (e) {
		return {
			ok: false,
			errors: [{ code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) }],
			proposal,
			stale: [],
		};
	}
}

function planAcceptUnchecked(
	doc: ProjectDocument,
	proposal: Proposal,
	itemIds: readonly string[] | 'all',
	origin: Origin,
	ctx: ProposalContext,
	opts: { partial?: boolean; expectedRevision?: number },
): AcceptPlan {
	const rv = revalidate(doc, proposal, ctx);
	let p = rv.proposal;
	const byId = new Map(p.items.map((it) => [it.id, it]));
	const unknown = itemIds === 'all' ? [] : itemIds.filter((id) => !byId.has(id));
	if (unknown.length)
		return {
			ok: false,
			errors: unknown.map((id) => ({
				code: 'E_NOT_FOUND',
				message: `No item ${id} in the proposal`,
				itemId: id,
			})),
			proposal: p,
			stale: rv.stale,
		};
	let requested =
		itemIds === 'all'
			? p.items.filter((it) => it.state === 'pending' || it.state === 'stale').map((it) => it.id)
			: [...new Set(itemIds)];
	const problemOf = new Map(rv.stale.flatMap((x) => (x.problem ? [[x.itemId, x.problem] as const] : [])));
	const staleList = (): StaleItem[] =>
		p.items
			.filter((it) => it.state === 'stale')
			.map((it) => {
				const problem = problemOf.get(it.id);
				return { itemId: it.id, reason: it.reason ?? 'stale', ...(problem ? { problem } : {}) };
			});
	for (let pass = 0; pass <= MAX_CONFLICT_PASSES; pass++) {
		// The first stale or invalid item in each item's closure (requires name earlier items: one pass).
		const root = new Map<string, ProposalItem | null>();
		for (const it of p.items) {
			if (it.state === 'accepted') root.set(it.id, null);
			else if (it.state === 'stale' || it.state === 'invalid') root.set(it.id, it);
			else root.set(it.id, it.requires.map((r) => root.get(r) ?? null).find((x) => x !== null) ?? null);
		}
		const blockedOf = (id: string) => root.get(id) ?? undefined;
		const blocked = requested
			.map((id) => ({ id, by: blockedOf(id) }))
			.filter((b): b is { id: string; by: ProposalItem } => !!b.by);
		if (blocked.length) {
			if (!opts.partial)
				return {
					ok: false,
					errors: blocked.map((b) => ({
						code: b.by.state === 'invalid' ? 'E_INVALID_PARAM' : 'E_STALE',
						message:
							b.by.id === b.id
								? `Item ${b.id} is ${b.by.state}: ${b.by.reason ?? ''}`.trim()
								: `Item ${b.id} requires item ${b.by.id}, which is ${b.by.state}: ${b.by.reason ?? ''}`.trim(),
						itemId: b.id,
					})),
					proposal: p,
					stale: staleList(),
				};
			const out = new Set(blocked.map((b) => b.id));
			requested = requested.filter((id) => !out.has(id));
		}
		if (requested.every((id) => byId.get(id)?.state === 'accepted'))
			return { ok: true, composed: null, proposal: p, stale: staleList() };
		const composed = composeAcceptTx(p, requested, origin, {
			...(opts.expectedRevision !== undefined ? { expectedRevision: opts.expectedRevision } : {}),
		});
		if (!composed.ok) return { ok: false, errors: composed.errors, proposal: p, stale: staleList() };
		if (composed.itemIds.length === 0) return { ok: true, composed: null, proposal: p, stale: staleList() };
		const r = dryRunCommands(doc, composed.tx.commands, ctx, p.sequenceId);
		if (r.ok) return { ok: true, composed, proposal: p, stale: staleList() };
		const culprit = conflictingItem(doc, p, composed, r.errors, ctx);
		if (!culprit)
			return {
				ok: false,
				errors: r.errors.map((e) => ({ code: e.code, message: e.message })),
				proposal: p,
				stale: staleList(),
			};
		// The item fails together with the others now: stale (the document or the selection changed since).
		problemOf.set(culprit, { type: 'conflict', issue: issueReason(r.errors) });
		p = {
			...p,
			items: p.items.map((it) =>
				it.id === culprit
					? setState(it, 'stale', `does not apply with the other items: ${issueReason(r.errors)}`)
					: it,
			),
		};
		byId.set(culprit, p.items.find((it) => it.id === culprit)!);
	}
	return {
		ok: false,
		errors: [{ code: 'E_STALE', message: 'Too many items conflict with each other; accept fewer at a time' }],
		proposal: p,
		stale: staleList(),
	};
}
