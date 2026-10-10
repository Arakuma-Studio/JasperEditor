// The approval gate for destructive engine operations that are not transactions (security review AGT-3).
//
// Transactions are classified by @jasper/project (`approvalReasons`) and gated in AgentService.transact. The engine
// also has routes that delete or overwrite things outside any project's undo history: presets of the user's
// library, downloaded models, render files, the cache, a project's current state (version restore), a project
// itself, registered media, the recovery journal, relinked media files. The editor window calls them after its own
// confirmation dialogs; an agent calling them (jasper-mcp, the CLI, `/mcp`, any client that holds only the engine
// token, or the editor acting on an agent's live-UI input) must be approved by the user first, in the editor.
//
// `requireUserApproval` is that check. It is a no-op for the editor window itself (`req.jasperEditor`, set by the
// auth hook from the editor key); for everything else it shows the card and waits, and throws a 403 the caller's
// `guarded()` wrapper turns into `{code: 'APPROVAL_DENIED' | 'APPROVAL_TIMEOUT', detail: {code: 'E_APPROVAL_…'}}`.
import { AGENT_NAME_HEADER } from '@jasper/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../tools/reply.ts';
import type { AgentService } from './service.ts';

export type OperationApproval = {
	/** Card title, e.g. "Delete effect preset". */
	label: string;
	/** What exactly happens, in one line: names, counts, sizes. Shown on the card. */
	summary: string;
	/** Why it needs approval (shown as warnings), e.g. "cannot be undone". */
	reasons: string[];
	/**
	 * The project the operation is about: the card is shown in the windows that have it open, or in every editor
	 * window when none has (a project that is not open can still be deleted or restored, and the user must still
	 * agree). null / omitted: not about one project.
	 */
	projectId?: string | null;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A display name for the card: one line, bounded, never empty. Untrusted (the agent names itself). */
export function agentNameOf(req: FastifyRequest): string {
	const header = req.headers[AGENT_NAME_HEADER];
	const query = (req.query as { agent?: unknown } | undefined)?.agent;
	const raw = (Array.isArray(header) ? header[0] : header) ?? (typeof query === 'string' ? query : '');
	let name = '';
	try {
		name = decodeURIComponent(String(raw));
	} catch {
		name = String(raw);
	}
	name = name.replace(CONTROL, ' ').trim().slice(0, 64);
	return name || 'An agent';
}

/**
 * Resolves when the request may proceed: it is the editor window's own, or the user approved it. Throws otherwise.
 */
export async function requireUserApproval(
	app: FastifyInstance,
	req: FastifyRequest,
	what: OperationApproval,
): Promise<void> {
	if (req.jasperEditor) return;
	const agent = app.jasper.services.agent as AgentService | undefined;
	const refuse = (kind: 'DENIED' | 'TIMEOUT', message: string) =>
		new HttpError(403, `APPROVAL_${kind}`, message, { code: `E_APPROVAL_${kind}` });
	const noEditor = () =>
		refuse(
			'DENIED',
			`${what.label} needs the user's approval, and no JasperEditor window with a project open is connected to ask in`,
		);
	if (!agent) throw noEditor();
	// Prefer the windows that have the project open; a project nobody has open is asked about in any window.
	const projectId = what.projectId && agent.hasEditor(what.projectId) ? what.projectId : null;
	const decision = await agent.askUser({
		projectId,
		label: what.label.slice(0, 120),
		agent: agentNameOf(req),
		reasons: what.reasons.map((r) => r.slice(0, 300)).slice(0, 8),
		commandCount: 0,
		summary: what.summary.replace(CONTROL, ' ').slice(0, 600),
		kind: 'operation',
	});
	if (decision === 'approved') return;
	if (decision === 'no-editor') throw noEditor();
	if (decision === 'timeout')
		throw refuse(
			'TIMEOUT',
			`The user did not answer the approval request within ${agent.approvals.timeoutMs / 1000} s`,
		);
	throw refuse('DENIED', 'The user denied the request');
}
