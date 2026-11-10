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
	'playhead.set',
	'history.list',
	'preferences.get',
	'validate',
	'frame.capture',
	'clip.properties',
	'param.get',
] as const;
export const AgentQueryNameSchema = z.enum(AGENT_QUERIES);
export type AgentQueryName = z.infer<typeof AgentQueryNameSchema>;

/** Output of `exportAgentSchema` in @jasper/project (JSON Schemas of commands, registries, codes). */
export const AgentSchemaResponseSchema = z.looseObject({
	protocol: z.literal('jasper.tx/1'),
	commands: z.record(z.string(), z.unknown()),
	errorCodes: z.array(z.string()),
	/** Motion-graphic templates with their renderer. */
	mgTemplates: z
		.array(
			z.looseObject({
				id: z.string(),
				version: z.number().int(),
				name: z.string(),
				renderer: z.enum(['fframes', 'anime']).optional(),
				description: z.string().optional(),
				defaultDurationSeconds: z.number().optional(),
			}),
		)
		.optional(),
	/** Text animator presets for `clip.update {textAnimation}`. */
	textAnimations: z
		.array(
			z.looseObject({
				id: z.string(),
				version: z.number().int(),
				label: z.string(),
				category: z.string(),
				phases: z.array(z.enum(['in', 'out'])),
				paramsSchema: z.record(z.string(), z.unknown()),
				defaults: z.unknown(),
				defaultDurationFrames: z.number().int().min(1),
				description: z.string(),
			}),
		)
		.optional(),
});
export type AgentSchemaResponse = z.infer<typeof AgentSchemaResponseSchema>;

export const AgentQueryRequestSchema = z.object({
	projectId: z.string(),
	query: AgentQueryNameSchema,
	args: z.record(z.string(), z.unknown()).optional(),
});
export type AgentQueryRequest = z.infer<typeof AgentQueryRequestSchema>;
/**
 * Whether the live revision has reached the project file. `savedRevision`: the revision on disk as far as the answerer
 * knows. `saved`: nothing unsaved; `pending`: autosave (or the user's Save, with Auto Save off) has edits still to
 * write; `save-failing`: the last save failed and is retried; `paused-conflict`: the file was saved from somewhere else
 * and nothing is saved until the user chooses Reload or Overwrite; `lease-lost`: another session took over editing;
 * `read-only`: this window never saves.
 */
export const AgentPersistenceSchema = z.object({
	state: z.enum(['saved', 'pending', 'save-failing', 'paused-conflict', 'lease-lost', 'read-only']),
	savedRevision: z.number().int(),
});
export type AgentPersistence = z.infer<typeof AgentPersistenceSchema>;
export const AgentQueryResponseSchema = z.object({
	result: z.unknown(),
	revision: z.number().int().optional(),
	/** `session` = answered by the open editor (live state), `headless` = from the stored project. */
	via: z.enum(['session', 'headless']).optional(),
	persistence: AgentPersistenceSchema.optional(),
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
	persistence: AgentPersistenceSchema.optional(),
});
export type AgentTxResponse = z.infer<typeof AgentTxResponseSchema>;

export const AgentWsHelloSchema = z.object({
	type: z.literal('hello'),
	projectId: z.string(),
	sessionId: z.string(),
	leaseId: z.string().nullable(),
});
export const AgentWsRequestSchema = z.object({
	type: z.literal('request'),
	id: z.string(),
	kind: z.enum(['tx', 'query', 'schema', 'ui']),
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
	/** The `answerKey` the engine sent this connection with the card (security review AGT-2). */
	answerKey: z.string().min(1).max(256),
});
/** Engine → editor. */
export const AgentWsServerMessageSchema = z.discriminatedUnion('type', [
	AgentWsRequestSchema,
	AgentWsPingSchema,
	z.object({
		type: z.literal('welcome'),
		engineVersion: z.string(),
		/** The engine recognised this connection as the editor window (it may show and answer approval cards). */
		editor: z.boolean().optional(),
	}),
	/** Engine-side events for the session (e.g. `agent.approval.requested` / `.resolved`). */
	AgentWsEventSchema,
]);
export type AgentWsClientMessage = z.infer<typeof AgentWsClientMessageSchema>;
export type AgentWsServerMessage = z.infer<typeof AgentWsServerMessageSchema>;

/** Pending approval shown as a card at the top of the editor window (S01:AGT-011). */
export const ApprovalSchema = z.object({
	approvalId: z.string(),
	projectId: z.string(),
	label: z.string(),
	agent: z.string(),
	reasons: z.array(z.string()),
	commandCount: z.number().int(),
	expiresAt: z.string(),
	/** One-line summary of the commands (e.g. "track.remove, 2× marker.add"). */
	summary: z.string().optional(),
	/** The commands awaiting approval (for the approval card's detail view). */
	commands: z.array(z.unknown()).optional(),
	/**
	 * `operation`: a request that is not a transaction (delete a preset, clean the cache, restore a version…);
	 * `summary` then says what it does and `commandCount` is 0.
	 */
	kind: z.enum(['transaction', 'operation']).optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
/**
 * The card as the engine sends it to one editor connection over WS /agent: the approval plus the key that
 * connection must present to answer it. The key is per connection and per approval; it is not part of the
 * `agent.approval.requested` engine event on `/events`, which agents can read.
 */
export const ApprovalCardSchema = ApprovalSchema.extend({ answerKey: z.string() });
export type ApprovalCard = z.infer<typeof ApprovalCardSchema>;

/**
 * `POST /api/agent/open-project` (jasper-mcp `open_project_in_editor`): asks every connected editor window
 * (all `/events` subscribers) to open the project; `editors` = how many windows were listening.
 */
export const AgentOpenProjectRequestSchema = z.object({ projectId: z.string().min(1) });
export type AgentOpenProjectRequest = z.infer<typeof AgentOpenProjectRequestSchema>;
export const AgentOpenProjectResponseSchema = z.object({
	projectId: z.string(),
	/** Path of the editor route, relative to the engine origin (`/project/<projectId>`). */
	path: z.string(),
	editors: z.number().int().min(0),
	/** An editor session already has the project open (agent transactions apply live). */
	live: z.boolean(),
});
export type AgentOpenProjectResponse = z.infer<typeof AgentOpenProjectResponseSchema>;
/** Global engine event: an agent asked editor windows to open (and focus) a project. */
export const EDITOR_OPEN_PROJECT_EVENT = 'editor.openProject';

/**
 * `GET /api/agent/mcp-info` (Help ▸ Connect an AI Agent…): where the MCP server that fronts this engine
 * can be reached. Never contains the engine token.
 */
export const AgentMcpInfoSchema = z.object({
	/** Absolute path of the `jasper-mcp` stdio server next to this engine; null when it is not built. */
	stdioEntry: z.string().nullable(),
	/** Streamable HTTP endpoint of this engine (`<origin>/mcp`). */
	httpUrl: z.string(),
	/** The engine runs in token mode (desktop): the HTTP endpoint needs a Bearer token that changes per launch. */
	tokenRequired: z.boolean(),
});
export type AgentMcpInfo = z.infer<typeof AgentMcpInfoSchema>;

/** At most this many agent names are remembered by `GET /api/agent/presence`. */
export const AGENT_PRESENCE_MAX = 32;
/** An agent counts as connected when it called the engine within this many seconds. */
export const AGENT_PRESENCE_WINDOW_SEC = 15 * 60;

/**
 * `GET /api/agent/presence` (spec 18 AF-BRF-005): the agents — jasper-mcp clients, named by the `x-jasper-agent` header
 * of their requests — that called this engine within `windowSec`, most recent first. An agent that is
 * configured but has not called the engine since it started is not listed.
 */
export const AgentPresenceSchema = z.object({
	agents: z.array(z.object({ name: z.string().max(64), lastSeenAt: z.string() })).max(AGENT_PRESENCE_MAX),
	windowSec: z.number(),
});
export type AgentPresence = z.infer<typeof AgentPresenceSchema>;

/**
 * What `POST /api/agent/ui` can ask an open editor window to do (docs/wp-notes/mcp-cli.md §4). Coordinates are
 * CSS pixels of the window's content area, origin top-left; elements are addressed by automation id.
 */
export const AGENT_UI_ACTIONS = [
	'state',
	'elements',
	'screenshot',
	'click',
	'drag',
	'scroll',
	'key',
	'type',
	'set',
	'locate',
	'hit',
	'commands',
	'command',
	// previews: the window's playback and render-bar counters (MCP perf_stats)
	'perf',
] as const;
export type AgentUiAction = (typeof AGENT_UI_ACTIONS)[number];
export const AgentUiRequestSchema = z.object({
	/** The editor window that has this project open (default: the only / most recently connected window). */
	projectId: z.string().min(1).optional(),
	action: z.enum(AGENT_UI_ACTIONS),
	args: z.record(z.string(), z.unknown()).optional(),
});
export type AgentUiRequest = z.infer<typeof AgentUiRequestSchema>;
export const AgentUiResponseSchema = z.object({
	result: z.unknown(),
	/** The window that answered. */
	window: z.object({ projectId: z.string(), sessionId: z.string() }),
});
export type AgentUiResponse = z.infer<typeof AgentUiResponseSchema>;
