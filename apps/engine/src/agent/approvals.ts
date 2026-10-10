// Approval gate for destructive agent transactions (S01:AGT-011, ARCHITECTURE §11): the request is shown
// as a pending card in the editor window of the session that holds the project; the user approves or
// denies; after the timeout (60 s) the transaction fails with E_APPROVAL_TIMEOUT.
import { randomUUID } from 'node:crypto';
import type { Approval } from '@jasper/api';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

/** `projectId: null` = not about one project (a preset of the user's library, the cache): any editor window may answer. */
export type ApprovalRequest = Omit<Approval, 'approvalId' | 'expiresAt' | 'projectId'> & {
	projectId: string | null;
};

type Entry = {
	approval: Approval;
	projectId: string | null;
	resolve(d: ApprovalDecision): void;
	timer: ReturnType<typeof setTimeout>;
};

type ApprovalGateOptions = {
	timeoutMs?: number;
	now?(): number;
	onRequested?(approval: Approval): void;
	onResolved?(approval: Approval, decision: ApprovalDecision): void;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

export class ApprovalGate {
	private readonly entries = new Map<string, Entry>();
	readonly timeoutMs: number;
	private readonly now: () => number;

	constructor(private readonly opts: ApprovalGateOptions = {}) {
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
		this.now = opts.now ?? (() => Date.now());
	}

	/** Creates a pending approval; the promise settles with the user's decision or 'timeout'. */
	request(req: ApprovalRequest): { approval: Approval; decision: Promise<ApprovalDecision> } {
		const approval: Approval = {
			...req,
			projectId: req.projectId ?? '',
			approvalId: `apr_${randomUUID()}`,
			expiresAt: new Date(this.now() + this.timeoutMs).toISOString(),
		};
		const decision = new Promise<ApprovalDecision>((resolve) => {
			const timer = setTimeout(() => this.settle(approval.approvalId, 'timeout'), this.timeoutMs);
			timer.unref();
			this.entries.set(approval.approvalId, { approval, projectId: req.projectId, resolve, timer });
		});
		this.opts.onRequested?.(approval);
		return { approval, decision };
	}

	/**
	 * Resolves a pending approval (from the editor's approval card). Returns false if unknown or already settled.
	 * `projectId`: the project of the window that answers; an approval about another project is not its to answer.
	 * Who may call this at all is the caller's business (AgentService: the editor connection that holds the card's
	 * answer key, security review AGT-2).
	 */
	resolve(approvalId: string, decision: 'approved' | 'denied', projectId?: string): boolean {
		const e = this.entries.get(approvalId);
		if (!e || (projectId !== undefined && e.projectId !== null && e.projectId !== projectId)) return false;
		return this.settle(approvalId, decision);
	}

	/** The project a pending approval is about (null: none), or undefined when it is not pending. */
	scopeOf(approvalId: string): string | null | undefined {
		return this.entries.get(approvalId)?.projectId;
	}

	private settle(approvalId: string, decision: ApprovalDecision): boolean {
		const e = this.entries.get(approvalId);
		if (!e) return false;
		this.entries.delete(approvalId);
		clearTimeout(e.timer);
		e.resolve(decision);
		this.opts.onResolved?.(e.approval, decision);
		return true;
	}

	/** Pending approvals; with `projectId`, those a window of that project shows (its own and the project-less ones). */
	pending(projectId?: string): Approval[] {
		return [...this.entries.values()]
			.filter((e) => projectId === undefined || e.projectId === null || e.projectId === projectId)
			.map((e) => e.approval);
	}

	/** Denies everything still pending (engine shutdown). */
	close(): void {
		for (const id of [...this.entries.keys()]) this.settle(id, 'denied');
	}
}
