// "Refresh proposal" (spec 15 EA-003): stale items are never applied as they were planned and never silently rebased;
// the feature's producer re-plans them on the current document on demand. The producer (an engine refresher, see
// `ProposalService.registerRefresher`) returns a replacement for each item it could re-plan (same id, same temp refs:
// later items may use them) and the items that no longer apply; this module checks the replacements like a draft's
// items, swaps them in as pending with fresh anchors and validates them by dry runs. Accepted and rejected items are
// the reviewer's and are never replaced. Never throws.
import { z } from 'zod';
import { proposalBudget, tooLargeIssue } from './budget.ts';
import {
	PROPOSAL_LIMITS,
	type Proposal,
	type ProposalIssue,
	type ProposalItem,
	ProposalItemIdSchema,
	ProposalItemInputSchema,
	ProposalSchema,
} from './schema.ts';
import { declaredRefs, proposalStructureIssues } from './structure.ts';
import {
	type ProposalContext,
	prepareItems,
	proposalBytesIssue,
	setItemState,
	validateProposal,
	withInvalidDependents,
} from './validate.ts';

/** What a producer returns for a refresh. */
export const ProposalRefreshSchema = z.strictObject({
	/** Re-planned items (ids of requested items; each declares the same temp refs as the item it replaces). */
	items: z.array(ProposalItemInputSchema).max(PROPOSAL_LIMITS.maxItems),
	/** Requested items that no longer apply (the cut they sat on is gone…): they become invalid with the reason. */
	dropped: z
		.array(
			z.strictObject({
				itemId: ProposalItemIdSchema,
				reason: z.string().min(1).max(PROPOSAL_LIMITS.maxReason),
			}),
		)
		.max(PROPOSAL_LIMITS.maxItems)
		.optional(),
	/** A new feature report (replaces the stored one; the stored Sound Check, `report.check`, is kept). */
	report: z.unknown().optional(),
});
export type ProposalRefresh = z.infer<typeof ProposalRefreshSchema>;

export type RefreshOutcome =
	| {
			ok: true;
			proposal: Proposal;
			/** Items replaced (now pending, or invalid when their new commands fail). */
			refreshed: string[];
			/** Items the producer dropped (now invalid). */
			dropped: string[];
			/** Requested items the producer returned nothing for (left as they were). */
			unchanged: string[];
	  }
	| { ok: false; errors: ProposalIssue[] };

/** States a refresh may replace (the reviewer's decisions — accepted, rejected — stay). */
export const REFRESHABLE_STATES: readonly ProposalItem['state'][] = ['pending', 'stale', 'invalid'];

/** Swaps the producer's re-planned items into `proposal` (requested `itemIds` only) and validates them on `doc`. */
export function refreshProposalItems(
	doc: Parameters<typeof validateProposal>[0],
	proposal: Proposal,
	itemIds: readonly string[],
	refreshIn: unknown,
	ctx: ProposalContext,
	now: string,
): RefreshOutcome {
	try {
		return refreshUnchecked(doc, proposal, itemIds, refreshIn, ctx, now);
	} catch (e) {
		return {
			ok: false,
			errors: [{ code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) }],
		};
	}
}

function refreshUnchecked(
	doc: Parameters<typeof validateProposal>[0],
	proposal: Proposal,
	itemIds: readonly string[],
	refreshIn: unknown,
	ctx: ProposalContext,
	now: string,
): RefreshOutcome {
	const parsed = ProposalRefreshSchema.safeParse(refreshIn);
	if (!parsed.success)
		return {
			ok: false,
			errors: parsed.error.issues.slice(0, 50).map((i) => ({
				code: 'E_SCHEMA',
				message: `refresh: ${i.path.join('.') || 'result'}: ${i.message}`,
				path: i.path.map((x) => (typeof x === 'number' ? x : String(x))),
			})),
		};
	const r = parsed.data;
	const requested = new Set(itemIds);
	const byId = new Map(proposal.items.map((it) => [it.id, it]));
	const errors: ProposalIssue[] = [];
	const seen = new Set<string>();
	const check = (id: string, what: string) => {
		const it = byId.get(id);
		if (!it)
			errors.push({
				code: 'E_NOT_FOUND',
				message: `${what} ${id} is not an item of the proposal`,
				itemId: id,
			});
		else if (!requested.has(id))
			errors.push({
				code: 'E_INVALID_PARAM',
				message: `${what} ${id} was not asked to be refreshed`,
				itemId: id,
			});
		else if (!REFRESHABLE_STATES.includes(it.state))
			errors.push({
				code: 'E_INVALID_PARAM',
				message: `${what} ${id} is ${it.state}: the reviewer decided it (only pending, stale or invalid items are refreshed)`,
				itemId: id,
			});
		else if (seen.has(id))
			errors.push({ code: 'E_INVALID_PARAM', message: `${what} ${id} is returned twice`, itemId: id });
		seen.add(id);
	};
	for (const it of r.items) {
		check(it.id, 'Item');
		const old = byId.get(it.id);
		if (!old) continue;
		// later items may use the refs it declares (one transaction): a re-plan keeps them
		const was = [...new Set(declaredRefs(old.commands))].sort().join(', ');
		const is = [...new Set(declaredRefs(it.commands))].sort().join(', ');
		if (was !== is)
			errors.push({
				code: 'E_INVALID_PARAM',
				message: `Item ${it.id} must declare the same temp refs as before (${was || 'none'}); it declares ${is || 'none'}`,
				itemId: it.id,
			});
	}
	for (const d of r.dropped ?? []) check(d.itemId, 'Dropped item');
	if (errors.length) return { ok: false, errors: errors.slice(0, 100) };

	const prepared = prepareItems(doc, r.items, proposal.sequenceId);
	if (!prepared.ok) return prepared;
	const replacement = new Map(prepared.items.map((it) => [it.id, it]));
	const dropped = new Map((r.dropped ?? []).map((d) => [d.itemId, d.reason]));
	const items = proposal.items.map((old): ProposalItem => {
		const next = replacement.get(old.id);
		if (next) {
			// the reviewer's note stays with the item (it was about the same decoration)
			return old.note ? { ...next, note: old.note } : next;
		}
		const why = dropped.get(old.id);
		if (why !== undefined) {
			const { anchors: _a, ...rest } = old;
			return setItemState(rest as ProposalItem, 'invalid', `No longer applies (refresh): ${why}`);
		}
		return old;
	});
	const structure = proposalStructureIssues(items);
	if (structure.length) return { ok: false, errors: structure.slice(0, 100) };
	const tooLarge = tooLargeIssue(proposalBudget(items));
	if (tooLarge) return { ok: false, errors: [tooLarge] };

	let report = proposal.report;
	if (r.report !== undefined) {
		const kept =
			proposal.report && typeof proposal.report === 'object' && !Array.isArray(proposal.report)
				? (proposal.report as Record<string, unknown>).check
				: undefined;
		report =
			kept !== undefined && r.report && typeof r.report === 'object' && !Array.isArray(r.report)
				? { ...(r.report as Record<string, unknown>), check: kept }
				: r.report;
	}
	let next: Proposal = {
		...proposal,
		items: items.map((it) =>
			replacement.has(it.id) && prepared.addressFailures.has(it.id)
				? setItemState(it, 'invalid', prepared.addressFailures.get(it.id)!)
				: it,
		),
		updatedAt: now,
		...(report !== undefined ? { report } : {}),
	};
	const bytes = proposalBytesIssue(next);
	if (bytes) return { ok: false, errors: [bytes] };
	next = withInvalidDependents(next, prepared.addressFailures.keys());
	const only = new Set([...replacement.keys()].filter((id) => !prepared.addressFailures.has(id)));
	const validated = validateProposal(doc, next, ctx, { only });
	const shape = ProposalSchema.safeParse(validated);
	if (!shape.success)
		return {
			ok: false,
			errors: [{ code: 'E_SCHEMA', message: `proposal: ${shape.error.issues[0]?.message ?? 'invalid'}` }],
		};
	return {
		ok: true,
		proposal: validated,
		refreshed: [...replacement.keys()],
		dropped: [...dropped.keys()],
		unchanged: itemIds.filter((id) => !replacement.has(id) && !dropped.has(id)),
	};
}
