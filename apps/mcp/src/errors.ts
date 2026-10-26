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
	E_APPROVAL_REQUIRED:
		'Only the user can do this. A proposal: ask them to review and apply it in the editor (Review panel), or to turn on "Allow agents to apply sound proposals" for the sequence (sound design) or "Allow agents to apply <feature> proposals" in Project Settings (editing automation, subtitles, transcript cleanup; list_proposal_features shows which are on); wait_for_proposal tells you their decisions. A Sound Check error you wanted to acknowledge: fix it, or ask the user to acknowledge it in the Sound Check panel. Do not retry.',
	E_PROPOSAL_STALE:
		'Some proposal items no longer fit the edit. Nothing was applied: accept again with partial: true to apply the rest, or make a new proposal.',
	E_TOO_LARGE:
		'The result would not fit one accept transaction (5 000 commands / 20 MB; 2 000 items). Nothing was stored: run the pass on the suggested range (details.suggestedRange, in sequence frames), then on the rest — or use the batch commands (clip.addAdjustmentBatch, keyframe.addBatch) so each item is one command.',
	E_NOT_REFRESHABLE:
		'This feature’s producer does not re-plan items. Make a new proposal for the changed part instead (and reject_proposal the stale items).',
	E_PROPOSAL_LIMIT:
		'The project already holds 50 proposals still under review. Ask the user to finish or discard some (or reject_proposal your own) before proposing again.',
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
		"This operation is unavailable in the current engine or editor session. Check engine_status and the requested tool's requirements.",
	E_UNSUPPORTED:
		'The edit does not work on this material (for example a reversed, retimed or time-remapped clip). The message names the clips; set them to 100 % speed or leave them out.',
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
// social-comment §7.8: a template's platform font, emoji or image is not available (details.assets names each).
const TEMPLATE_ASSETS_HINT =
	'A template needs a platform font, emoji or image that is not available; details.assets names each one, its clips and why. REMOTE_ASSETS_OFF: the user has to turn on Preferences ▸ Privacy & Network ▸ "Platform fonts & emoji for social templates" (an agent turning it on is asked about in the editor). DOWNLOAD_NOT_FOUND / REMOTE_ASSET_UNKNOWN: switch the clip\'s emojiStyle or remove that emoji. DOWNLOAD_FAILED / DOWNLOAD_TIMEOUT: retry later. PREFETCH_LIMIT: the render uses more different emoji of one pack than one export fetches (4,096): use fewer.';
const TEMPLATE_MEDIA_HINT =
	'A template media param (e.g. an avatar) holds a medium that is not a still picture (a video, Lottie or PDF page; details.blockers name the clips): set it to {mediaId} of a still image with set_motion_graphic_params, or to null.';
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
	if (code === 'TEMPLATE_ASSETS_UNAVAILABLE') return TEMPLATE_ASSETS_HINT;
	if (code === 'TEMPLATE_MEDIA_UNDRAWABLE') return TEMPLATE_MEDIA_HINT;
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
