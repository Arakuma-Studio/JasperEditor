import { RationalSchema as ProjectRationalSchema } from '@jasper/project';
import { z } from 'zod';

export const API_VERSION = 1;
export const API_HEADER = 'x-jasper-api';
export const AUTH_COOKIE = 'jasper_session';
/**
 * The editor key cookie (security review AGT-2). HttpOnly: page scripts never see it, the browser sends it with
 * the editor's requests and its `/agent` WebSocket, and nothing that authenticates with the token alone (jasper-mcp,
 * the CLI, a script that read runtime.json) has it. Requests without it are an agent's.
 */
export const EDITOR_COOKIE = 'jasper_editor';
/**
 * Cookies are shared by every port of a host, so two engines on one machine (dev and E2E, two worktrees) would
 * overwrite each other's: browsers get `<name>_<engine port>`. The engine accepts both names.
 */
export function portCookieName(name: string, port: number): string {
	return `${name}_${port}`;
}
/**
 * Set by the editor on requests it makes while an agent's live-UI input is being handled (`ui_click` on a Delete
 * button…): the engine then treats the request as the agent's, so it needs the user's approval like the MCP tool.
 */
export const AGENT_INPUT_HEADER = 'x-jasper-agent-input';
/** How an agent's client names itself to the engine (URI-encoded); shown on approval cards. Untrusted. */
export const AGENT_NAME_HEADER = 'x-jasper-agent';

/** Stable engine error codes (S04:ENG-022 plus the codes used by ARCHITECTURE §9–§11). */
export const ENGINE_ERROR_CODES = [
	'BAD_REQUEST',
	'VALIDATION_FAILED',
	'UNAUTHORIZED',
	'FORBIDDEN_HOST',
	'FORBIDDEN_ORIGIN',
	'NOT_FOUND',
	'NOT_IMPLEMENTED',
	'METHOD_NOT_ALLOWED',
	'PAYLOAD_TOO_LARGE',
	'INTERNAL',
	'ASSET_NOT_FOUND',
	'UNSUPPORTED_MEDIA',
	'DISK_FULL',
	'QUOTA_EXCEEDED',
	'PROVIDER_NOT_CONFIGURED',
	'BINARY_MISSING',
	'LOCAL_MODE_ONLY',
	'PROJECT_NOT_FOUND',
	'REVISION_CONFLICT',
	'LEASE_HELD',
	'LEASE_NOT_FOUND',
	'UPLOAD_NOT_FOUND',
	'UPLOAD_OFFSET_MISMATCH',
	'UPLOAD_SIZE_MISMATCH',
	'JOB_NOT_FOUND',
	'JOB_CANCELLED',
	'JOB_NOT_RETRYABLE',
	'PATH_NOT_ELIGIBLE',
	'FRAME_COUNT_MISMATCH',
	'FONT_NOT_FOUND',
	'TEMPLATE_NOT_FOUND',
	'MG_UNAVAILABLE',
	'INVALID_SPEC',
	'NO_SESSION',
	'APPROVAL_DENIED',
	'APPROVAL_TIMEOUT',
	'TRANSACTION_REJECTED',
	/** Proposals (spec 12 §2.5): an agent may not accept this feature's proposals (detail.code E_APPROVAL_REQUIRED). */
	'APPROVAL_REQUIRED',
	'PROPOSAL_NOT_FOUND',
	/** 50 proposals with undecided items: decide or delete one first (detail.code E_PROPOSAL_LIMIT). */
	'PROPOSAL_LIMIT',
	/** Accept refused: items are stale or invalid on the current document (detail.code E_PROPOSAL_STALE). */
	'PROPOSAL_STALE',
	/** Reopen refused: the item's accept is still in the document (undo it first; detail.code E_STILL_APPLIED). */
	'PROPOSAL_STILL_APPLIED',
	/** Redo record refused: the document does not have what the accept created (detail.code E_NOT_APPLIED). */
	'PROPOSAL_NOT_APPLIED',
	/**
	 * Spec 15 EA-004: the proposal would not fit one accept transaction (detail.code E_TOO_LARGE, with `fit` and the
	 * `suggestedRange` of frames that fits): run the pass on a shorter range.
	 */
	'PROPOSAL_TOO_LARGE',
	/** "Refresh proposal": the feature's producer does not re-plan items (detail.code E_NOT_REFRESHABLE). */
	'PROPOSAL_NOT_REFRESHABLE',
] as const;
export const EngineErrorCodeSchema = z.enum(ENGINE_ERROR_CODES);
export type EngineErrorCode = z.infer<typeof EngineErrorCodeSchema>;

/** Every error response body (S04:ENG-022). Unknown codes from newer engines are tolerated. */
export const ErrorShapeSchema = z.object({
	code: z.string(),
	message: z.string(),
	detail: z.unknown().optional(),
	retryable: z.boolean(),
});
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;

export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
	'DISK_FULL',
	'INTERNAL',
	'NO_SESSION',
	'LEASE_HELD',
	// social-comment §7.8: remote-asset downloads that may succeed later
	'DOWNLOAD_FAILED',
	'DOWNLOAD_TIMEOUT',
	'ASSET_CACHE_WRITE',
	'REMOTE_ASSET_FAILED',
]);

export function errorBody(code: string, message: string, detail?: unknown): ErrorShape {
	return { code, message, ...(detail !== undefined ? { detail } : {}), retryable: RETRYABLE_CODES.has(code) };
}

export const RationalSchema = z.object(ProjectRationalSchema.shape);
