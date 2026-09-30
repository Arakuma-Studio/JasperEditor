// Agent API stage 1 (ARCHITECTURE §11, S01 §21): schema, queries, transactions and the /agent WS relay.
import { TransactionSchema } from '@jasper/project';
import { z } from 'zod';

export const AGENT_QUERIES = [
	'doc.get',
	'doc.revision',
	'sequence.summary',
	'sequence.clipsInRange',
	'sequence.at',
	'media.list',
	'selection.get',
	'playhead.get',
	'history.list',
	'validate',
	'frame.capture',
] as const;
export const AgentQueryNameSchema = z.enum(AGENT_QUERIES);
export type AgentQueryName = z.infer<typeof AgentQueryNameSchema>;

/** Output of `exportAgentSchema` in @jasper/project (JSON Schemas of commands, registries, codes). */
export const AgentSchemaResponseSchema = z.looseObject({
	protocol: z.literal('jasper.tx/1'),
	commands: z.record(z.string(), z.unknown()),
	errorCodes: z.array(z.string()),
});
export type AgentSchemaResponse = z.infer<typeof AgentSchemaResponseSchema>;

export const AgentQueryRequestSchema = z.object({
	projectId: z.string(),
	query: AgentQueryNameSchema,
	args: z.record(z.string(), z.unknown()).optional(),
});
export type AgentQueryRequest = z.infer<typeof AgentQueryRequestSchema>;
export const AgentQueryResponseSchema = z.object({
	result: z.unknown(),
	revision: z.number().int().optional(),
});
export type AgentQueryResponse = z.infer<typeof AgentQueryResponseSchema>;

/** Transactions from agents may omit `protocol` (it defaults to `jasper.tx/1`). */
export const AgentTransactionSchema = TransactionSchema.extend({
	protocol: TransactionSchema.shape.protocol.optional(),
});
export const AgentTxRequestSchema = z.object({ projectId: z.string(), transaction: AgentTransactionSchema });
export type AgentTxRequest = z.infer<typeof AgentTxRequestSchema>;

export const IssueSchema = z.object({
	commandIndex: z.number().int(),
	code: z.string(),
	message: z.string(),
	path: z.array(z.string()).optional(),
	blocking: z.array(z.string()).optional(),
	invariant: z.string().optional(),
});
/** S01:CMD-005 result. */
export const TransactionResultSchema = z.discriminatedUnion('ok', [
	z.object({
		ok: z.literal(true),
		revision: z.number().int(),
		refs: z.record(z.string(), z.string()),
		created: z.array(z.string()),
		changed: z.array(z.string()),
		deleted: z.array(z.string()),
		warnings: z.array(IssueSchema),
		results: z.array(z.unknown()),
	}),
	z.object({ ok: z.literal(false), revision: z.number().int(), errors: z.array(IssueSchema) }),
]);
export type TransactionResultJson = z.infer<typeof TransactionResultSchema>;
/** How the engine applied the transaction. */
export const AgentTxResponseSchema = z.object({
	result: TransactionResultSchema,
	appliedBy: z.enum(['session', 'headless']),
});
export type AgentTxResponse = z.infer<typeof AgentTxResponseSchema>;

// ---------------------------------------------------------------- WS /agent relay messages

export const AgentWsHelloSchema = z.object({
	type: z.literal('hello'),
	projectId: z.string(),
	sessionId: z.string(),
	leaseId: z.string().nullable(),
});
export const AgentWsRequestSchema = z.object({
	type: z.literal('request'),
	id: z.string(),
	kind: z.enum(['tx', 'query', 'schema']),
	payload: z.unknown(),
});
export const AgentWsResponseSchema = z.object({
	type: z.literal('response'),
	id: z.string(),
	result: z.unknown(),
	error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const AgentWsEventSchema = z.object({
	type: z.literal('event'),
	event: z.string(),
	payload: z.unknown(),
});
export const AgentWsPingSchema = z.object({ type: z.enum(['ping', 'pong']) });
/** Editor → engine. */
export const AgentWsClientMessageSchema = z.discriminatedUnion('type', [
	AgentWsHelloSchema,
	AgentWsResponseSchema,
	AgentWsEventSchema,
	AgentWsPingSchema,
]);
/** Editor → engine event names with engine-side meaning (other names are forwarded to /events). */
export const AGENT_WS_CLIENT_EVENTS = {
	/** Payload `{approvalId, decision: 'approved' | 'denied'}` — resolves an engine approval (S01:AGT-011). */
	approvalResolve: 'agent.approval.resolve',
} as const;
export const AgentApprovalResolveSchema = z.object({
	approvalId: z.string(),
	decision: z.enum(['approved', 'denied']),
});
/** Engine → editor. */
export const AgentWsServerMessageSchema = z.discriminatedUnion('type', [
	AgentWsRequestSchema,
	AgentWsPingSchema,
	z.object({ type: z.literal('welcome'), engineVersion: z.string() }),
	/** Engine-side events for the session (e.g. `agent.approval.requested` / `.resolved`). */
	AgentWsEventSchema,
]);
export type AgentWsClientMessage = z.infer<typeof AgentWsClientMessageSchema>;
export type AgentWsServerMessage = z.infer<typeof AgentWsServerMessageSchema>;

/** Pending approval shown in the Agent panel (S01:AGT-011). */
export const ApprovalSchema = z.object({
	approvalId: z.string(),
	projectId: z.string(),
	label: z.string(),
	agent: z.string(),
	reasons: z.array(z.string()),
	commandCount: z.number().int(),
	expiresAt: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
