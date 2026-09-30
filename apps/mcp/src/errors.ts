// Tool errors: every failure becomes an MCP tool result with `isError: true` and a short JSON body
// `{error: {code, message, hint?, details?}}` whose hint tells the agent what to do next.

import { EngineError } from '@jasper/engine-client';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export class ToolError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly hint?: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = 'ToolError';
	}
}

/** What to do about a transaction/query error code (S01 E_* codes, ARCHITECTURE §2.3). */
export const TX_ERROR_HINTS: Record<string, string> = {
	E_APPROVAL_DENIED:
		'The user denied this change, or no editor had the project open (destructive commands such as track.remove, item.delete or force: true need the user to approve them in an open editor). Do not retry the same change without asking the user.',
	E_APPROVAL_TIMEOUT:
		'Nobody answered the approval prompt in the editor within 60 s. Ask the user to look at the JasperEditor window, then retry.',
	E_NO_SESSION:
		'This needs an editor window with the project open (open_project_in_editor), or the editor was busy or just closed: retry in a moment.',
	E_REVISION_MISMATCH:
		'The project changed since expectedRevision. Re-read it (get_project / get_timeline) and retry with the new revision, or omit expectedRevision.',
	E_NOT_FOUND: 'An id does not exist. Look ids up with get_timeline, list_media or get_project.',
	E_AMBIGUOUS: 'A name matches several items. Use the id instead (list_media / get_timeline).',
	E_SCHEMA:
		'A command does not match its schema. Call describe_commands with its type to see the schema and an example.',
	E_INVALID_PARAM: 'A parameter is out of range or invalid; see describe_commands for the command schema.',
	E_TRACK_LOCKED:
		'The target track is locked. Unlock it (track.update {locked: false}) or use another track.',
	E_TRACK_KIND: 'Wrong track kind: video clips go on V tracks, audio on A tracks.',
	E_OVERLAP:
		'The edit would overlap another clip. Use mode "overwrite", pick a free spot, or move the other clip.',
	E_OUT_OF_MEDIA: 'The trim/extend goes past the start or end of the source media.',
	E_SYNC_CONFLICT:
		'Sync-locked tracks block this ripple. Pass syncConflict: "cut" or unlock sync on those tracks.',
	E_NOT_OWNER:
		'Agents may only undo/redo their own history entries; the top entry was made by the user or another agent.',
	E_NOT_IMPLEMENTED:
		'This command is specified but not implemented yet (M2); describe_commands shows implemented: false.',
	E_LIMIT: 'Too many commands or too large a payload (5 000 commands / 20 MB per transaction). Split it up.',
};

/** Hints for requests that were cut off (link.ts `EngineRequestAborted`). */
export const ABORT_HINTS = {
	timeout:
		'The engine is busy or stuck. Check engine_status; for long renders use start_export + wait_for_job instead of waiting on one call.',
	'connection-lost':
		'The change may or may not have been applied. Re-read the project (get_timeline / get_project) before retrying, so nothing is applied twice.',
} as const;

export const ENGINE_ERROR_HINTS: Record<string, string> = {
	NETWORK:
		'The JasperEditor engine is not reachable. Start the desktop app or `pnpm dev`, or restart jasper-mcp with --start-engine.',
	UNAUTHORIZED:
		'The engine rejected the token. The desktop app issues a new token on every launch: restart jasper-mcp (it re-reads <appdir>/engine/runtime.json) or pass JASPER_ENGINE_TOKEN.',
	PROJECT_NOT_FOUND: 'Unknown projectId. Call list_projects.',
	NOT_FOUND: 'Not found. Check the id (list_projects, list_media, get_job).',
	NO_SESSION: 'This needs an editor window with the project open. Call open_project_in_editor first.',
	VALIDATION_FAILED: 'The request was invalid; check the tool arguments.',
	LOCAL_MODE_ONLY: 'Path import only works with a local engine.',
	ENGINE_NOT_FOUND: 'Start JasperEditor (desktop app or `pnpm dev`) or run jasper-mcp with --start-engine.',
};

function text(value: unknown): CallToolResult['content'][number] {
	return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) };
}

export function errorResult(code: string, message: string, hint?: string, details?: unknown): CallToolResult {
	return {
		isError: true,
		content: [text({ error: { code, message, ...(hint ? { hint } : {}), ...(details ? { details } : {}) } })],
	};
}

/** Converts anything thrown by a tool into an MCP tool error result. */
export function toErrorResult(e: unknown): CallToolResult {
	if (e instanceof ToolError) return errorResult(e.code, e.message, e.hint, e.details);
	if (e instanceof EngineError) {
		const inner = (e.detail as { code?: unknown } | undefined)?.code;
		const txHint = typeof inner === 'string' ? TX_ERROR_HINTS[inner] : undefined;
		return errorResult(
			typeof inner === 'string' ? inner : e.code,
			e.message,
			txHint ?? ENGINE_ERROR_HINTS[e.code],
			e.status ? { httpStatus: e.status } : undefined,
		);
	}
	const aborted = e as { name?: string; kind?: keyof typeof ABORT_HINTS; message?: string };
	if (aborted?.name === 'AbortError' && aborted.kind && ABORT_HINTS[aborted.kind])
		return errorResult(
			aborted.kind === 'timeout' ? 'ENGINE_TIMEOUT' : 'ENGINE_CONNECTION_LOST',
			aborted.message ?? 'The engine request was aborted',
			ABORT_HINTS[aborted.kind],
		);
	// The deadline can also fire while a response body is still being read.
	if (aborted?.name === 'TimeoutError')
		return errorResult('ENGINE_TIMEOUT', 'The engine did not finish answering in time', ABORT_HINTS.timeout);
	const message = e instanceof Error ? e.message : String(e);
	return errorResult('INTERNAL', message, 'Unexpected failure inside jasper-mcp; see its stderr log.');
}

/** A successful tool result with a JSON body (plus optional extra content such as images). */
export function jsonResult(value: unknown, extra: CallToolResult['content'] = []): CallToolResult {
	return { content: [text(value), ...extra] };
}
