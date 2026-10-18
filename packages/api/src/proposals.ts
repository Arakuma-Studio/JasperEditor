// Proposal route contracts (spec 12 §2.5, §2.8; P3-R2). Proposals are stored by the engine per project
// (`<appdir>/projects/<pid>/proposals/<id>.json`), outside the document and its undo history. The model (schemas,
// validation, `composeAcceptTx`) is `@jasper/project`'s; these are the request and response shapes.
import {
	AuthorSchema,
	PROPOSAL_ITEM_STATES,
	PROPOSAL_LIMITS,
	ProposalDraftSchema,
	ProposalItemIdSchema,
	ProposalSchema,
	type StaleProblem,
} from '@jasper/project';
import { z } from 'zod';
import { TransactionResultSchema } from './agent.ts';

export const ProposalCountsSchema = z.object(
	Object.fromEntries(PROPOSAL_ITEM_STATES.map((s) => [s, z.number().int().min(0)])) as Record<
		(typeof PROPOSAL_ITEM_STATES)[number],
		z.ZodNumber
	>,
);
export type ProposalCountsJson = z.infer<typeof ProposalCountsSchema>;

/** One row of `GET /api/projects/:projectId/proposals` (no commands). */
/** Who is waiting for the review of a proposal (inferred by the engine from an agent polling it). */
export const ProposalWaitingSchema = z.object({ agent: z.string(), since: z.string() });
export type ProposalWaiting = z.infer<typeof ProposalWaitingSchema>;

export const ProposalSummarySchema = z.object({
	id: z.string(),
	projectId: z.string(),
	sequenceId: z.string().nullable(),
	feature: z.string(),
	title: z.string(),
	summary: z.string(),
	author: AuthorSchema,
	createdAt: z.string(),
	updatedAt: z.string(),
	/** When the store deletes it (30 days after its last change). */
	expiresAt: z.string(),
	baseRevision: z.number().int(),
	itemCount: z.number().int(),
	counts: ProposalCountsSchema,
	/** Nothing left to decide (every item accepted, rejected or invalid). */
	decided: z.boolean(),
	/**
	 * An agent is waiting for the review (its `wait_for_proposal` is polling the proposal right now): the agent's name
	 * and since when. Absent / null: nobody is waiting.
	 */
	waiting: ProposalWaitingSchema.nullable().optional(),
});
export type ProposalSummary = z.infer<typeof ProposalSummarySchema>;

export const ProposalListResponseSchema = z.object({
	proposals: z.array(ProposalSummarySchema),
	/** Files the store could not read (moved aside as `*.corrupt-<time>`); never fatal. */
	warnings: z.array(z.string()),
});
export type ProposalListResponse = z.infer<typeof ProposalListResponseSchema>;

/** `GET …/:proposalId?revalidate=1`: re-validate the undecided items on the live document first. */
export const ProposalGetQuerySchema = z.strictObject({
	revalidate: z.enum(['0', '1', 'true', 'false']).optional(),
});
export type ProposalGetQuery = z.infer<typeof ProposalGetQuerySchema>;

export const ProposalResponseSchema = z.object({
	proposal: ProposalSchema,
	expiresAt: z.string(),
	/** Document revision the states were checked at (null when not re-validated now). */
	revision: z.number().int().nullable(),
});
export type ProposalResponse = z.infer<typeof ProposalResponseSchema>;

/**
 * `POST /api/projects/:projectId/proposals`: a draft (feature, title, items with commands, requires, alternatives,
 * meta). Validated by dry runs against the live document; failing items are stored `invalid` with the reason.
 * `author` is taken from the editor window only (default "user"); an agent is always `{agent: <its name>}`.
 */
export const ProposalCreateRequestSchema = ProposalDraftSchema.extend({ author: AuthorSchema.optional() });
export type ProposalCreateRequest = z.infer<typeof ProposalCreateRequestSchema>;

export const ProposalCreateResponseSchema = z.object({
	proposal: ProposalSchema,
	expiresAt: z.string(),
	revision: z.number().int(),
	/** Decided or expired proposals removed to stay within 50 per project (oldest first). */
	evicted: z.array(z.string()),
});
export type ProposalCreateResponse = z.infer<typeof ProposalCreateResponseSchema>;

/** Items a decision applies to: ids, or `'all'` (accept/reject: every pending or stale item). */
export const ProposalItemSelectionSchema = z.union([
	z.literal('all'),
	z.array(ProposalItemIdSchema).min(1).max(PROPOSAL_LIMITS.maxItems),
]);
export type ProposalItemSelection = z.infer<typeof ProposalItemSelectionSchema>;

/**
 * `POST …/:proposalId/accept`. All-or-nothing unless `partial` (stale items are then reported and the rest applied).
 * `expectedRevision`: the revision the caller reviewed (the fast-forward rule, S01:AGT-010, decides conflicts).
 */
export const ProposalAcceptRequestSchema = z.strictObject({
	itemIds: ProposalItemSelectionSchema,
	partial: z.boolean().optional(),
	expectedRevision: z.number().int().min(0).optional(),
});
export type ProposalAcceptRequest = z.infer<typeof ProposalAcceptRequestSchema>;

/**
 * A stale item: `reason` in English (timecodes and what changed: "The cut cue at 00:00:03:00 moved to 00:00:03:10"),
 * `problem` the same structured (`StaleProblem`: an anchor that moved or went, a requirement, a failure) for the editor
 * to say in the user's language.
 */
export const ProposalStaleItemSchema = z.object({
	itemId: z.string(),
	reason: z.string(),
	problem: z
		.custom<StaleProblem>(
			(v) =>
				!!v &&
				typeof v === 'object' &&
				['anchor', 'requires', 'conflict'].includes(String((v as { type?: unknown }).type)),
			'a stale problem',
		)
		.optional(),
});

export const ProposalAcceptResponseSchema = z.object({
	proposal: ProposalSchema,
	/** Items applied by this accept (the requested ones and what they require), in order. */
	applied: z.array(z.string()),
	/** Items the closure added (not requested). */
	added: z.array(z.string()),
	/** Requested items that were already accepted. */
	skipped: z.array(z.string()),
	/** Undecided items that are stale on the current document (not applied). */
	stale: z.array(ProposalStaleItemSchema),
	/** The transaction (one History entry "Accept <title> (n of m)"); null when nothing was left to apply. */
	result: TransactionResultSchema.nullable(),
	appliedBy: z.enum(['session', 'headless']).nullable(),
	/** Document revision after the accept. */
	revision: z.number().int().nullable(),
});
export type ProposalAcceptResponse = z.infer<typeof ProposalAcceptResponseSchema>;

export const ProposalRejectRequestSchema = z.strictObject({ itemIds: ProposalItemSelectionSchema });
export type ProposalRejectRequest = z.infer<typeof ProposalRejectRequestSchema>;
/** `POST …/:proposalId/reopen`: decided items back to review (after the accept was undone in History). */
export const ProposalReopenRequestSchema = z.strictObject({ itemIds: ProposalItemSelectionSchema });
export type ProposalReopenRequest = z.infer<typeof ProposalReopenRequestSchema>;
/** `POST …/:proposalId/note`: the reviewer's note on an item (null or "" clears it); returned to agents. */
export const ProposalNoteRequestSchema = z.strictObject({
	itemId: ProposalItemIdSchema,
	note: z.string().max(PROPOSAL_LIMITS.maxNote).nullable(),
});
export type ProposalNoteRequest = z.infer<typeof ProposalNoteRequestSchema>;
/** `POST …/:proposalId/select`: the command set an item applies (0 = its own, k = `alternatives[k − 1]`). */
export const ProposalSelectRequestSchema = z.strictObject({
	itemId: ProposalItemIdSchema,
	alternative: z.number().int().min(0).max(PROPOSAL_LIMITS.maxAlternatives),
});
export type ProposalSelectRequest = z.infer<typeof ProposalSelectRequestSchema>;

/**
 * `POST …/:proposalId/applied` (the editor window only): records items as accepted whose accept the user undid and
 * then redid in History — the document has them again, applied by the editor's Redo (not by the engine), so the
 * engine only records it (`revision` after the redo, the `refs` the original accept defined). An agent gets
 * `403 APPROVAL_REQUIRED`; items already accepted are left as they are.
 */
export const ProposalMarkAppliedRequestSchema = z.strictObject({
	itemIds: z.array(ProposalItemIdSchema).min(1).max(PROPOSAL_LIMITS.maxItems),
	revision: z.number().int().min(0),
	refs: z
		.record(z.string().min(1).max(128), z.string().min(1).max(128))
		.refine((r) => Object.keys(r).length <= PROPOSAL_LIMITS.maxCommands, 'too many refs'),
	/**
	 * The entity ids the original accept created (`TransactionResult.created`): the engine checks the document has them
	 * again (else `409 NOT_APPLIED`, nothing recorded) and keeps them, so the item cannot be reopened while applied.
	 */
	created: z.array(z.string().min(1).max(128)).max(PROPOSAL_LIMITS.maxCreated).optional(),
});
export type ProposalMarkAppliedRequest = z.infer<typeof ProposalMarkAppliedRequestSchema>;

export const ProposalDecisionResponseSchema = z.object({
	proposal: ProposalSchema,
	/** Items whose state, note or selection changed. */
	changed: z.array(z.string()),
});
export type ProposalDecisionResponse = z.infer<typeof ProposalDecisionResponseSchema>;

export const ProposalDeleteResponseSchema = z.object({ proposalId: z.string(), deleted: z.literal(true) });
export type ProposalDeleteResponse = z.infer<typeof ProposalDeleteResponseSchema>;

export const PROPOSAL_CHANGES = [
	'created',
	'accepted',
	'rejected',
	'reopened',
	'noted',
	'selected',
	'revalidated',
	'deleted',
	'expired',
	'evicted',
	/** An agent started or stopped waiting for the review (`waiting`); nothing in the proposal changed. */
	'waiting',
	/** A Sound Check of the proposal was stored on it (`report.check`, spec 12 §4 P6-E5); its items did not change. */
	'checked',
] as const;

/** Event `proposal.changed` (engine `/events`, scoped to the project). */
export const ProposalChangedEventSchema = z.object({
	projectId: z.string(),
	proposalId: z.string(),
	change: z.enum(PROPOSAL_CHANGES),
	feature: z.string().optional(),
	sequenceId: z.string().nullable().optional(),
	/** Item states after the change (absent when the proposal is gone). */
	counts: ProposalCountsSchema.optional(),
	/** Items the change touched. */
	itemIds: z.array(z.string()).optional(),
	/** Document revision after an accept. */
	revision: z.number().int().optional(),
	/** With `waiting`: who waits (null: nobody any more). */
	waiting: ProposalWaitingSchema.nullable().optional(),
});
export type ProposalChangedEvent = z.infer<typeof ProposalChangedEventSchema>;
