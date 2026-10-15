// Proposals (spec 12 §2.5, P3-R1): a generic, reviewable set of edits. A proposal is a list of items; each item is a
// list of ordinary commands (with optional alternative command sets), may require earlier items, and carries a review
// state. Accepting items composes ONE transaction (`composeAcceptTx`), so applying is one undo step. Proposals are
// not part of the document or of the undo history: the engine stores them per project (spec 12 §0).
import { z } from 'zod';
import { AGENT_TX_LIMITS } from '../agent/guard.ts';
import { utf8Length } from '../clipboard/payload.ts';
import { AuthorSchema } from '../schema/sequence.ts';

/** Limits (spec 12 §2.5; the composed transaction obeys the agent limits, S01:AGT-011). */
export const PROPOSAL_LIMITS = {
	maxItems: 2000,
	/** Commands of every item's own command set together: accepting everything is one transaction. */
	maxCommands: AGENT_TX_LIMITS.maxCommands,
	/** Alternative command sets per item (the UI cycles them; like `sfx.alternatives`). */
	maxAlternatives: 16,
	/** Commands of all alternative sets together. */
	maxAlternativeCommands: 50_000,
	maxRequires: 64,
	/** Serialized size of a whole proposal. */
	maxBytes: AGENT_TX_LIMITS.maxBytes,
	maxMetaBytes: 64 * 1024,
	maxReportBytes: 1024 * 1024,
	maxTitle: 200,
	maxSummary: 4000,
	maxLabel: 200,
	maxGroup: 64,
	maxNote: 4000,
	maxReason: 1000,
	/** Proposals kept per project by the engine store. */
	maxPerProject: 50,
	/** Days a proposal is kept after its last change. */
	expiryDays: 30,
} as const;

export const PROPOSAL_ITEM_STATES = ['pending', 'accepted', 'rejected', 'stale', 'invalid'] as const;
export type ProposalItemState = (typeof PROPOSAL_ITEM_STATES)[number];

/** `prp_` + 16 Crockford base32 characters (like entity ids; not a document entity). */
export const PROPOSAL_ID_RE = /^prp_[0-9A-HJKMNP-TV-Z]{16}$/;
/** Item ids are the creator's (`requires` names them): short, path- and prototype-safe. */
export const PROPOSAL_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** Feature ids (`sound-design`, …): the accept policy is chosen by feature. */
export const PROPOSAL_FEATURE_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** The sound-design feature (spec 12): agents may accept only when the sequence allows it (`agentsMayApply`). */
export const SOUND_DESIGN_FEATURE = 'sound-design';

const jsonBytes = (v: unknown): number => {
	try {
		return utf8Length(JSON.stringify(v) ?? '');
	} catch {
		return Number.POSITIVE_INFINITY;
	}
};
const bounded = (max: number, what: string) =>
	z.unknown().refine((v) => jsonBytes(v) <= max, `${what} must be at most ${max} bytes of JSON`);

export const ProposalItemIdSchema = z
	.string()
	.regex(PROPOSAL_ITEM_ID_RE, 'item ids are 1–64 letters, digits, "_", ".", ":" or "-" (starting alphanumeric)');
const CommandListSchema = z.array(z.record(z.string(), z.unknown())).min(1).max(PROPOSAL_LIMITS.maxCommands);

/** One alternative command set of an item (e.g. another sound for the same cue). */
export const ProposalAlternativeSchema = z.strictObject({
	label: z.string().min(1).max(PROPOSAL_LIMITS.maxLabel),
	commands: CommandListSchema,
	meta: bounded(PROPOSAL_LIMITS.maxMetaBytes, 'meta').optional(),
});
export type ProposalAlternative = z.infer<typeof ProposalAlternativeSchema>;

/** What a creator sends per item. */
export const ProposalItemInputSchema = z.strictObject({
	id: ProposalItemIdSchema,
	label: z.string().min(1).max(PROPOSAL_LIMITS.maxLabel),
	/** Grouping in the Review panel (e.g. the sound role); free text. */
	group: z.string().max(PROPOSAL_LIMITS.maxGroup).optional(),
	/** The item's own command set (alternative 0). */
	commands: CommandListSchema,
	/** Earlier items this one needs (their refs, their clips): accepting it accepts them too. */
	requires: z.array(ProposalItemIdSchema).max(PROPOSAL_LIMITS.maxRequires).optional(),
	/** Feature data for the UI and agents (the why-line, descriptors, …). */
	meta: bounded(PROPOSAL_LIMITS.maxMetaBytes, 'meta').optional(),
	/** Alternative command sets; `selectedAlternative` k ≥ 1 picks `alternatives[k − 1]`. */
	alternatives: z.array(ProposalAlternativeSchema).max(PROPOSAL_LIMITS.maxAlternatives).optional(),
	selectedAlternative: z.number().int().min(0).max(PROPOSAL_LIMITS.maxAlternatives).optional(),
});
export type ProposalItemInput = z.infer<typeof ProposalItemInputSchema>;

/** Ids an item was built against, with a fingerprint of where each was (`anchorFingerprint`). */
const AnchorsSchema = z.record(z.string(), z.string());

export const ProposalItemSchema = ProposalItemInputSchema.extend({
	group: z.string().max(PROPOSAL_LIMITS.maxGroup),
	requires: z.array(ProposalItemIdSchema).max(PROPOSAL_LIMITS.maxRequires),
	state: z.enum(PROPOSAL_ITEM_STATES),
	/** Why the item is invalid or stale (or what the last decision said). */
	reason: z.string().max(PROPOSAL_LIMITS.maxReason).optional(),
	/** The reviewer's note, returned to agents. */
	note: z.string().max(PROPOSAL_LIMITS.maxNote).optional(),
	anchors: AnchorsSchema.optional(),
	/** Set when accepted: the revision it was applied at and the temp refs it defined (later items use them). */
	applied: z
		.strictObject({
			revision: z.number().int().min(0),
			at: z.string(),
			refs: z.record(z.string(), z.string()),
		})
		.optional(),
});
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

/** What a creator sends (`POST /api/projects/:pid/proposals`, `createProposal`). */
export const ProposalDraftSchema = z.strictObject({
	/** Default sequence of the commands (and the one whose policy decides agent accept); null = none. */
	sequenceId: z.string().min(1).max(128).nullable().optional(),
	feature: z.string().regex(PROPOSAL_FEATURE_RE, 'a feature id like "sound-design"'),
	title: z.string().min(1).max(PROPOSAL_LIMITS.maxTitle),
	summary: z.string().max(PROPOSAL_LIMITS.maxSummary).optional(),
	items: z.array(ProposalItemInputSchema).min(1).max(PROPOSAL_LIMITS.maxItems),
	/** Feature report (per-event reasons, limits); returned as is. */
	report: bounded(PROPOSAL_LIMITS.maxReportBytes, 'report').optional(),
});
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

export const ProposalSchema = z.strictObject({
	version: z.literal(1),
	id: z.string().regex(PROPOSAL_ID_RE),
	projectId: z.string().min(1).max(128),
	sequenceId: z.string().min(1).max(128).nullable(),
	feature: z.string().regex(PROPOSAL_FEATURE_RE),
	title: z.string().min(1).max(PROPOSAL_LIMITS.maxTitle),
	summary: z.string().max(PROPOSAL_LIMITS.maxSummary),
	author: AuthorSchema,
	createdAt: z.string(),
	/** Last change (a decision, a note, a revalidation that changed states); expiry counts from here. */
	updatedAt: z.string(),
	/** Document revision and content hash the proposal was validated against. */
	baseRevision: z.number().int().min(0),
	docHash: z.string(),
	items: z.array(ProposalItemSchema).min(1).max(PROPOSAL_LIMITS.maxItems),
	report: z.unknown().optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export type ProposalCounts = Record<ProposalItemState, number>;

/** Items per state. */
export function proposalCounts(p: Pick<Proposal, 'items'>): ProposalCounts {
	const out: ProposalCounts = { pending: 0, accepted: 0, rejected: 0, stale: 0, invalid: 0 };
	for (const it of p.items) out[it.state]++;
	return out;
}

/** True when nothing is left to decide (no pending or stale item): the store may evict it first. */
export function proposalDecided(p: Pick<Proposal, 'items'>): boolean {
	return p.items.every((it) => it.state !== 'pending' && it.state !== 'stale');
}

/** The command set an item applies: its own (0) or `alternatives[selectedAlternative − 1]`. */
export function selectedCommands(item: Pick<ProposalItem, 'commands' | 'alternatives' | 'selectedAlternative'>) {
	const k = item.selectedAlternative ?? 0;
	if (k === 0) return item.commands;
	return item.alternatives?.[k - 1]?.commands ?? item.commands;
}

/** A typed problem with a proposal (never thrown). */
export type ProposalIssue = {
	code: string;
	message: string;
	itemId?: string;
	path?: (string | number)[];
};
