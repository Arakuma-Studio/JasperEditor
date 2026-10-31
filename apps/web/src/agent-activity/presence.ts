// Agent presence for the header status chip (spec 18 AF-ACT-002, spec 05 AG-010). External agents reach the editor
// through the engine (MCP → HTTP → WS /agent relay); neither the engine nor the relay keeps a list of MCP clients, so
// the editor knows an agent by what it does in this project: its transactions (the bridge's activity log), its
// approval requests, its proposals and its engine jobs. An agent counts as connected while any of those is recent
// (PRESENCE_MS) or still open (a pending approval, a proposal it waits on, a running job).
//
// State per agent, most urgent first:
//   approval  — one of its requests waits for Approve / Deny;
//   review    — it waits for the review of a proposal (`waiting`), or one of its undecided proposals changed recently;
//   error     — its latest outcome (applied or failed transaction, finished job) failed, within ERROR_MS;
//   working   — a transaction within WORKING_MS, or a job of its running or queued;
//   idle      — otherwise.
import type { EngineJob, ProposalSummary } from '@jasper/api';
import type { ActivityEntry } from '../agent-bridge/bridge.ts';
import { activityOutcome } from './model.ts';

export const WORKING_MS = 10_000;
export const ERROR_MS = 5 * 60_000;
export const PRESENCE_MS = 10 * 60_000;

export type AgentPhase = 'idle' | 'working' | 'review' | 'approval' | 'error';
const URGENCY: Record<AgentPhase, number> = { approval: 0, review: 1, error: 2, working: 3, idle: 4 };

export type PresenceJob = Pick<EngineJob, 'id' | 'title' | 'state' | 'progress' | 'origin' | 'createdAt'> &
	Partial<Pick<EngineJob, 'finishedAt' | 'error'>>;

export type PresenceInput = {
	/** Newest first (the bridge's log). */
	activity: readonly ActivityEntry[];
	approvals: readonly { agent: string }[];
	proposals: readonly Pick<ProposalSummary, 'author' | 'decided' | 'updatedAt' | 'waiting' | 'title'>[];
	jobs: readonly PresenceJob[];
	now: number;
};

export type AgentPresence = {
	agent: string;
	phase: AgentPhase;
	/** Pending approval requests. */
	approvals: number;
	/** Proposals waiting for the user's review. */
	reviews: number;
	runningJobs: number;
	/** What it is doing or did last ("Add marker", "Transcribe 40%"). */
	step: string | null;
	/** Message of its latest failure while in `error`. */
	error: string | null;
};

export type PresenceSummary = {
	agents: AgentPresence[];
	/** The most urgent state of any agent (idle with none). */
	phase: AgentPhase;
	/** Approvals and reviews waiting for the user. */
	attention: number;
	/** When the summary changes by time alone (re-evaluate then), or null. */
	nextChangeAt: number | null;
};

const RUNNING = new Set(['queued', 'running', 'paused', 'cancelling']);

function time(iso: string | undefined): number | null {
	if (!iso) return null;
	const v = Date.parse(iso);
	return Number.isFinite(v) ? v : null;
}

type Acc = {
	approvals: number;
	reviews: number;
	reviewTitle: string | null;
	runningJobs: number;
	jobStep: string | null;
	/** Latest transaction (any outcome). */
	lastActive: number | null;
	lastLabel: string | null;
	/** Latest applied-or-failed outcome. */
	outcome: { at: number; failed: boolean; message: string | null } | null;
	/** Latest moment the agent was seen (presence). */
	seen: number | null;
};

const newAcc = (): Acc => ({
	approvals: 0,
	reviews: 0,
	reviewTitle: null,
	runningJobs: 0,
	jobStep: null,
	lastActive: null,
	lastLabel: null,
	outcome: null,
	seen: null,
});

const later = (a: number | null, b: number) => (a === null || b > a ? b : a);

export function agentPresence(input: PresenceInput): PresenceSummary {
	const { now } = input;
	const accs = new Map<string, Acc>();
	const acc = (agent: string) => {
		let a = accs.get(agent);
		if (!a) {
			a = newAcc();
			accs.set(agent, a);
		}
		return a;
	};
	for (const e of input.activity) {
		if (!Number.isFinite(e.time)) continue;
		const a = acc(e.agent);
		if (a.lastActive === null || e.time > a.lastActive) {
			a.lastActive = e.time;
			a.lastLabel = e.label;
		}
		a.seen = later(a.seen, e.time);
		const o = activityOutcome(e);
		if ((o === 'applied' || o === 'failed') && (a.outcome === null || e.time > a.outcome.at))
			a.outcome = { at: e.time, failed: o === 'failed', message: e.errors[0]?.message ?? null };
	}
	for (const ap of input.approvals) acc(ap.agent).approvals++;
	for (const p of input.proposals) {
		if (p.decided) continue;
		if (p.waiting) {
			const a = acc(p.waiting.agent);
			a.reviews++;
			a.reviewTitle ??= p.title;
			continue;
		}
		const at = time(p.updatedAt);
		if (typeof p.author !== 'object' || at === null || now - at >= PRESENCE_MS) continue;
		const a = acc(p.author.agent);
		a.reviews++;
		a.reviewTitle ??= p.title;
		a.seen = later(a.seen, at);
	}
	for (const j of input.jobs) {
		if (j.origin.type !== 'agent') continue;
		if (RUNNING.has(j.state)) {
			const a = acc(j.origin.agentRunId);
			a.runningJobs++;
			const pct =
				typeof j.progress === 'number' && Number.isFinite(j.progress) ? Math.round(j.progress * 100) : null;
			a.jobStep ??= pct === null ? j.title : `${j.title} ${pct}%`;
			continue;
		}
		const at = time(j.finishedAt);
		if (at === null || now - at >= PRESENCE_MS) continue;
		const a = acc(j.origin.agentRunId);
		a.seen = later(a.seen, at);
		if (j.state === 'succeeded' || j.state === 'failed')
			if (a.outcome === null || at > a.outcome.at)
				a.outcome = { at, failed: j.state === 'failed', message: j.error?.message ?? null };
	}

	const agents: AgentPresence[] = [];
	const changes: number[] = [];
	const pending = (at: number) => {
		if (at > now) changes.push(at);
	};
	for (const [agent, a] of accs) {
		const open = a.approvals > 0 || a.reviews > 0 || a.runningJobs > 0;
		const recent = a.seen !== null && now - a.seen < PRESENCE_MS;
		if (!open && !recent) continue;
		if (a.seen !== null) pending(a.seen + PRESENCE_MS);
		const working = a.runningJobs > 0 || (a.lastActive !== null && now - a.lastActive < WORKING_MS);
		if (a.lastActive !== null) pending(a.lastActive + WORKING_MS);
		const failed = a.outcome?.failed === true && now - a.outcome.at < ERROR_MS;
		if (a.outcome?.failed) pending(a.outcome.at + ERROR_MS);
		const phase: AgentPhase =
			a.approvals > 0
				? 'approval'
				: a.reviews > 0
					? 'review'
					: failed
						? 'error'
						: working
							? 'working'
							: 'idle';
		agents.push({
			agent,
			phase,
			approvals: a.approvals,
			reviews: a.reviews,
			runningJobs: a.runningJobs,
			step: phase === 'review' ? a.reviewTitle : (a.jobStep ?? a.lastLabel),
			error: failed ? (a.outcome?.message ?? null) : null,
		});
	}
	agents.sort((x, y) => URGENCY[x.phase] - URGENCY[y.phase] || x.agent.localeCompare(y.agent));
	const phase = agents[0]?.phase ?? 'idle';
	const attention = agents.reduce((n, a) => n + a.approvals + a.reviews, 0);
	return { agents, phase, attention, nextChangeAt: changes.length ? Math.min(...changes) : null };
}
