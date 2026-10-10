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

/**
 * The MCP request was cancelled (`notifications/cancelled`): the tool stopped, cancelled its engine job
 * and the engine deleted the job's partial outputs. The SDK sends no response for a cancelled request.
 */
export class RequestCancelled extends Error {
	constructor(readonly jobId?: string) {
		super(
			jobId ? `Cancelled; engine job ${jobId} was cancelled and its partial output deleted` : 'Cancelled',
		);
		this.name = 'RequestCancelled';
	}
}

/** The result of a cancelled request (never sent by the SDK; kept well-formed for direct callers). */
export function cancelledResult(): CallToolResult {
	return errorResult('CANCELLED', 'The request was cancelled');
}

/** What to do about a transaction/query error code (S01 E_* codes, ARCHITECTURE §2.3). */
export const TX_ERROR_HINTS: Record<string, string> = {
	E_APPROVAL_DENIED:
		'The user denied this, or no editor window was open to ask in. Destructive commands (track.remove, item.delete, force: true…) and destructive operations (deleting presets, models, all render files or referenced cache, restoring a version over a project, changing settings) need the user to approve them in an open JasperEditor window. Do not retry without asking the user.',
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
const ABORT_HINTS = {
	timeout:
		'The engine is busy or stuck. Check engine_status; for long renders use start_export + wait_for_job instead of waiting on one call.',
	'connection-lost':
		'The change may or may not have been applied. Re-read the project (get_timeline / get_project) before retrying, so nothing is applied twice.',
} as const;

const ENGINE_ERROR_HINTS: Record<string, string> = {
	NETWORK:
		'The JasperEditor engine is not reachable. Start the desktop app or `pnpm dev`, or restart jasper-mcp with --start-engine.',
	UNAUTHORIZED:
		'The engine rejected the token. Every engine start issues a new token (desktop app, `pnpm dev`, headless): jasper-mcp re-reads <appdir>/engine/runtime.json by itself; if this persists, give it the engine with --appdir <dir> (or JASPER_APPDIR) or pass JASPER_ENGINE_TOKEN.',
	PROJECT_NOT_FOUND: 'Unknown projectId. Call list_projects.',
	NOT_FOUND: 'Not found. Check the id (list_projects, list_media, get_job).',
	NO_SESSION: 'This needs an editor window with the project open. Call open_project_in_editor first.',
	APPROVAL_DENIED:
		'This needs the user to approve it in an open JasperEditor window, and they denied it or no window was open. Do not retry without asking the user.',
	APPROVAL_TIMEOUT:
		'Nobody answered the approval prompt in the editor within 60 s. Ask the user to look at the JasperEditor window, then retry.',
	VALIDATION_FAILED: 'The request was invalid; check the tool arguments.',
	LOCAL_MODE_ONLY: 'Path import only works with a local engine.',
	ENGINE_NOT_FOUND: 'Start JasperEditor (desktop app or `pnpm dev`) or run jasper-mcp with --start-engine.',
};

function text(value: unknown): CallToolResult['content'][number] {
	return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) };
}

function errorResult(code: string, message: string, hint?: string, details?: unknown): CallToolResult {
	return {
		isError: true,
		content: [text({ error: { code, message, ...(hint ? { hint } : {}), ...(details ? { details } : {}) } })],
	};
}

/** Converts anything thrown by a tool into an MCP tool error result. */
export function toErrorResult(e: unknown): CallToolResult {
	if (e instanceof ToolError) return errorResult(e.code, e.message, e.hint, e.details);
	if (e instanceof RequestCancelled) return errorResult('CANCELLED', e.message);
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

/** Why a Remotion render could not run and what to do (env names as read by apps/engine/src/remotion/service.ts). */
const REMOTION_HINT =
	"Text, graphics, effects and anime motion templates render with Remotion in a headless Chrome. Install Google Chrome or Chromium (or set JASPER_BROWSER_EXECUTABLE to its executable), or let the engine download its own headless browser on the first render (needs network access). The engine also needs the Remotion compositions bundle: `pnpm build` produces it (a dev engine bundles the workspace sources itself) or set JASPER_REMOTION_BUNDLE to a built bundle folder; packaged builds also need their LGPL FFmpeg folder (JASPER_REMOTION_BIN_DIR). list_export_presets shows the engine's Remotion state.";
const BROWSER_DOWNLOAD_NOTE =
	'No browser is installed yet: the first Remotion render downloads a headless Chrome (needs network access and can take a minute); if that fails, install Google Chrome or set JASPER_BROWSER_EXECUTABLE.';
const TEMPLATE_NOT_INSTALLED_HINT =
	'A clip uses a motion-graphic template this JasperEditor build lacks: update JasperEditor, or replace or delete that clip (get_timeline shows it; details.blockers name the clips).';
const WEBGL_HINT =
	'The render browser has no WebGL2 (colour grading on the Remotion path needs it): set JASPER_REMOTION_GL to angle, swangle, egl or swiftshader, install Google Chrome, or export with engine "native" when the sequence allows it.';

/** The engine's Remotion capability (`capabilities.render`), fetched only after a failure. */
export type RenderCapsHint = {
	remotionLocal?: 'ready' | 'needs-browser-download' | 'unavailable';
	remotionBinaries?: { message?: string };
};

/** Failure codes that may come from a missing Remotion/browser setup when the engine reports it unavailable. */
const REMOTION_SUSPECT_CODES = new Set([
	'BINARY_MISSING',
	'RENDER_FAILED',
	'RENDER_TIMEOUT',
	'PATH_NOT_ELIGIBLE',
	'NOT_IMPLEMENTED',
	'INTERNAL',
]);

/** The error itself names Remotion or its browser (codes REMOTION_UNAVAILABLE / BROWSER_*, or the message). */
function mentionsRemotion(code: string, message: string): boolean {
	return (
		code === 'REMOTION_UNAVAILABLE' ||
		code.startsWith('BROWSER_') ||
		/remotion|headless|chrom(e|ium)|browser|puppeteer/i.test(message)
	);
}

function blockerReasons(detail: unknown): string[] {
	const list = (detail as { blockers?: unknown } | undefined)?.blockers;
	if (!Array.isArray(list)) return [];
	const reasons = list
		.map((b) => (b as { reason?: unknown } | null)?.reason)
		.filter((r): r is string => typeof r === 'string');
	return [...new Set(reasons)].slice(0, 5);
}

/**
 * Hint for a failed render (still, export, preview) from its error code and message, the plan error detail
 * (`blockers`) and, when known, the engine's Remotion capability. undefined = nothing specific to say.
 */
export function renderHint(
	code: string,
	message: string,
	caps?: RenderCapsHint,
	detail?: unknown,
): string | undefined {
	if (code === 'TEMPLATE_NOT_INSTALLED') return TEMPLATE_NOT_INSTALLED_HINT;
	if (code === 'WEBGL_UNAVAILABLE') return WEBGL_HINT;
	const parts: string[] = [];
	if (code === 'PATH_NOT_ELIGIBLE') {
		const reasons = blockerReasons(detail);
		parts.push(
			`The requested render path cannot render this sequence${reasons.length ? ` (${reasons.join('; ')})` : ''}. Export with engine "auto" (picks a path that can render everything) or "remotion".`,
		);
	}
	const suspect = REMOTION_SUSPECT_CODES.has(code);
	const remotion = mentionsRemotion(code, message) || (caps?.remotionLocal === 'unavailable' && suspect);
	if (remotion) {
		parts.push(REMOTION_HINT);
		if (caps?.remotionLocal === 'unavailable')
			parts.push('This engine reports Remotion as unavailable (capabilities render.remotionLocal).');
		if (caps?.remotionBinaries?.message) parts.push(caps.remotionBinaries.message);
	}
	if (caps?.remotionLocal === 'needs-browser-download' && (remotion || suspect))
		parts.push(BROWSER_DOWNLOAD_NOTE);
	return parts.length ? parts.join(' ') : undefined;
}
