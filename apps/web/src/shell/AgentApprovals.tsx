// Shell-level agent notices (ARCHITECTURE §11, S01:AGT-011). External agents drive the editor over MCP
// (there is no Agent panel), so the two things the user must see live here, above every panel:
//  - approval requests: a destructive agent transaction (track.remove, item.delete, force: true…) waits
//    for Approve / Deny on a sticky card with a human summary, the reasons and a countdown;
//  - activity: a toast for every transaction an external agent applied, with Undo while it is the top
//    History entry.
// Cards look like toasts (same frame, agent accent) but never time out on their own and never steal focus.
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull } from '@jasper/session/react';
import { Button, Icon, toast } from '@jasper/ui';
import { useEffect, useState } from 'react';
import {
	type ActivityEntry,
	type AgentBridge,
	type PendingApproval,
	useAgentBridgeFor,
	useAgentBridgeState,
} from '../agent-bridge/index.ts';

/** "claude-code wants to run 1 command: track.remove" */
export function approvalSentence(a: Pick<PendingApproval, 'agent' | 'commandCount' | 'summary'>): string {
	const n = a.commandCount;
	return `${a.agent} wants to run ${n} command${n === 1 ? '' : 's'}${a.summary ? `: ${a.summary}` : ''}`;
}

function Countdown({ until }: { until: string }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	const left = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
	if (!Number.isFinite(left)) return null;
	return (
		<span
			className="shrink-0 text-pr-small text-pr-muted pr-tabular"
			title="Denied automatically when it runs out"
		>
			{left} s
		</span>
	);
}

function ApprovalCard({ approval: a, bridge }: { approval: PendingApproval; bridge: AgentBridge }) {
	const [open, setOpen] = useState(false);
	const decide = (decision: 'approved' | 'denied') => {
		if (!bridge.resolveApproval(a.approvalId, decision))
			toast({
				kind: 'warning',
				title: 'The agent request could not be answered',
				detail: 'The engine connection dropped; the request will time out.',
				dedupeKey: `agent-approval-failed:${a.approvalId}`,
			});
	};
	return (
		<li
			role="alertdialog"
			aria-label={`Agent request: ${a.label}`}
			data-testid="agent-approval-card"
			data-approval-id={a.approvalId}
			className="pointer-events-auto flex w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-pr-menu border border-pr-menu-border bg-pr-menu font-pr text-pr-ui text-pr-text shadow-pr-floating"
		>
			<span className="w-[3px] shrink-0 bg-pr-agent" />
			<div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
				<div className="flex items-center gap-2">
					<span className="inline-flex shrink-0 text-pr-agent">
						<Icon id="agent.sparkle" size={16} />
					</span>
					<span className="min-w-0 flex-1 truncate font-semibold text-pr-strong" title={a.label}>
						Agent request: {a.label}
					</span>
					<Countdown until={a.expiresAt} />
				</div>
				<p className="text-pr-muted" data-testid="agent-approval-summary">
					{approvalSentence(a)}
				</p>
				{a.reasons.length ? (
					<ul className="list-disc pl-5 text-pr-small text-pr-warning">
						{a.reasons.map((r) => (
							<li key={r}>{r}</li>
						))}
					</ul>
				) : null}
				{open && a.commands ? (
					<pre className="max-h-40 overflow-auto rounded-pr-control bg-pr-field-deep p-1.5 font-pr-mono text-pr-small text-pr-muted">
						{JSON.stringify(a.commands, null, 2)}
					</pre>
				) : null}
				<div className="mt-0.5 flex items-center gap-2">
					{a.commands?.length ? (
						<button
							type="button"
							className="text-pr-small text-pr-accent hover:underline"
							onClick={() => setOpen((x) => !x)}
						>
							{open ? 'Hide commands' : 'Show commands'}
						</button>
					) : null}
					<span className="ml-auto flex gap-2">
						<Button variant="secondary" onClick={() => decide('denied')} data-testid="agent-approval-deny">
							Deny
						</Button>
						<Button variant="primary" onClick={() => decide('approved')} data-testid="agent-approval-approve">
							Approve
						</Button>
					</span>
				</div>
			</div>
		</li>
	);
}

function activityToast(entry: ActivityEntry, bridge: AgentBridge, session: EditorSession): void {
	// Only what an external agent changed: dry runs, rejections and in-page calls stay quiet.
	if (entry.via !== 'relay' || !entry.ok || entry.dryRun) return;
	const n = entry.created.length + entry.changed.length + entry.deleted.length;
	toast({
		kind: 'agent',
		title: `Agent: ${entry.label}`.slice(0, 80),
		detail: `${entry.agent} · ${n} item${n === 1 ? '' : 's'} changed`,
		source: 'agent',
		// One slot: a burst of transactions replaces the toast instead of stacking.
		dedupeKey: 'agent-activity',
		actions: [
			{
				label: 'Undo',
				run: () => {
					if (bridge.isTopOfHistory(entry)) session.undo();
					else toast({ kind: 'info', title: 'Newer edits came after it; use the History panel' });
				},
			},
		],
	});
}

/** Mounted once by the editor shell. */
export function AgentApprovals() {
	const session = useSessionOrNull();
	const bridge = useAgentBridgeFor(session);
	const approvals = useAgentBridgeState(bridge, (s) => s.approvals);

	useEffect(() => {
		if (!bridge || !session) return;
		const offActivity = bridge.on('activity', (e) => activityToast(e as ActivityEntry, bridge, session));
		const offResolved = bridge.on('approval.resolved', (p) => {
			if ((p as { decision?: string }).decision === 'timeout')
				toast({ kind: 'warning', title: 'An agent request timed out and was not applied', source: 'agent' });
		});
		return () => {
			offActivity();
			offResolved();
		};
	}, [bridge, session]);

	if (!bridge || approvals.length === 0) return null;
	return (
		<ul
			className="pointer-events-none fixed top-[72px] left-1/2 z-[var(--pr-z-toast)] flex -translate-x-1/2 flex-col items-center gap-2"
			data-testid="agent-approvals"
			aria-label="Agent requests waiting for approval"
		>
			{approvals.map((a) => (
				<ApprovalCard key={a.approvalId} approval={a} bridge={bridge} />
			))}
		</ul>
	);
}
