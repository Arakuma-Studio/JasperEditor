// Spec 18 AF-ACT-001…003: the pure parts of the agent activity UI — outcomes and filters of the activity log, which
// agent edits may be undone (never the user's own interleaved edits), burst grouping for the toast, and the header
// chip's state machine.
import type { ProposalSummary } from '@jasper/api';
import type { HistoryEntryView, HistoryState } from '@jasper/session';
import { describe, expect, it } from 'vitest';
import { AgentBurstTracker, BURST_WINDOW_MS, burstToastText } from '../src/agent-activity/bursts.ts';
import {
	activityAgents,
	activityOutcome,
	entryUndoPlan,
	filterActivity,
	planAgentUndo,
} from '../src/agent-activity/model.ts';
import {
	agentPresence,
	ERROR_MS,
	PRESENCE_MS,
	type PresenceJob,
	WORKING_MS,
} from '../src/agent-activity/presence.ts';
import type { ActivityEntry } from '../src/agent-bridge/bridge.ts';

let seq = 0;
function entry(p: Partial<ActivityEntry> = {}): ActivityEntry {
	return {
		id: ++seq,
		time: 1_000_000,
		label: 'Add marker',
		agent: 'bot',
		via: 'relay',
		ok: true,
		dryRun: false,
		revision: 1,
		historyEntryId: null,
		summary: 'marker.add',
		commandCount: 1,
		created: ['mk_1'],
		changed: [],
		deleted: [],
		errors: [],
		warnings: [],
		...p,
	};
}

/** A history whose entries are `user` or an agent name, `index` = applied count (default: all). */
function history(origins: string[], index = origins.length): HistoryState {
	const entries: HistoryEntryView[] = origins.map((o, i) => ({
		id: i + 1,
		label: o === 'user' ? 'Edit' : 'Agent: x',
		origin: o === 'user' ? 'user' : { agent: o },
		time: 0,
		revisionBefore: i,
		revisionAfter: i + 1,
		created: [],
		changed: [],
		deleted: [],
	}));
	return { entries, index, canUndo: index > 0, canRedo: index < entries.length };
}

describe('activity outcomes and filters (AF-ACT-001)', () => {
	it('classifies applied, failed, denied and dry-run entries', () => {
		expect(activityOutcome(entry())).toBe('applied');
		expect(activityOutcome(entry({ dryRun: true }))).toBe('dryRun');
		expect(activityOutcome(entry({ dryRun: true, ok: false }))).toBe('dryRun');
		expect(
			activityOutcome(
				entry({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED', message: 'no', commandIndex: -1 }] }),
			),
		).toBe('denied');
		expect(
			activityOutcome(
				entry({ ok: false, errors: [{ code: 'E_APPROVAL_TIMEOUT', message: 'late', commandIndex: -1 }] }),
			),
		).toBe('denied');
		expect(
			activityOutcome(entry({ ok: false, errors: [{ code: 'E_NOT_FOUND', message: 'x', commandIndex: 0 }] })),
		).toBe('failed');
	});

	it('filters by agent and outcome; lists agents once, sorted', () => {
		const list = [
			entry({ agent: 'codex' }),
			entry({ agent: 'bot', ok: false, errors: [{ code: 'E_X', message: 'x', commandIndex: 0 }] }),
			entry({ agent: 'bot' }),
		];
		expect(activityAgents(list)).toEqual(['bot', 'codex']);
		expect(filterActivity(list, { agent: null, outcome: null })).toHaveLength(3);
		expect(filterActivity(list, { agent: 'bot', outcome: null }).map((e) => e.id)).toEqual([
			list[1]!.id,
			list[2]!.id,
		]);
		expect(filterActivity(list, { agent: 'bot', outcome: 'failed' }).map((e) => e.id)).toEqual([list[1]!.id]);
		expect(filterActivity(list, { agent: 'codex', outcome: 'failed' })).toEqual([]);
	});
});

describe('agent undo plans never undo the user’s own edits (AF-ACT-001/003)', () => {
	it('undoes a contiguous run of the agent’s entries at the top of the stack', () => {
		expect(planAgentUndo([2, 3], history(['user', 'bot', 'bot']))).toEqual({ ok: true, count: 2 });
		expect(planAgentUndo([3], history(['user', 'bot', 'bot']))).toEqual({ ok: true, count: 1 });
	});

	it('refuses when a newer edit (the user’s or another agent’s) is on top', () => {
		expect(planAgentUndo([2, 3], history(['user', 'bot', 'bot', 'user']))).toEqual({
			ok: false,
			reason: 'newer-edits',
		});
		expect(planAgentUndo([2], history(['user', 'bot', 'bot']))).toEqual({ ok: false, reason: 'newer-edits' });
	});

	it('refuses when a user edit is interleaved inside the run', () => {
		expect(planAgentUndo([2, 4], history(['user', 'bot', 'user', 'bot']))).toEqual({
			ok: false,
			reason: 'interleaved',
		});
	});

	it('undoes what is left when part of the run was already undone; reports undone and gone runs', () => {
		// entries 2,3,4 by the agent; 4 already undone (index 3)
		expect(planAgentUndo([2, 3, 4], history(['user', 'bot', 'bot', 'bot'], 3))).toEqual({
			ok: true,
			count: 2,
		});
		expect(planAgentUndo([2, 3], history(['user', 'bot', 'bot'], 1))).toEqual({
			ok: false,
			reason: 'undone',
		});
		expect(planAgentUndo([9], history(['user', 'bot']))).toEqual({ ok: false, reason: 'gone' });
		expect(planAgentUndo([], history(['user']))).toEqual({ ok: false, reason: 'not-undoable' });
	});

	it('never counts a user entry as the agent’s even when its id is listed', () => {
		expect(planAgentUndo([1], history(['user']))).toEqual({ ok: false, reason: 'not-undoable' });
	});

	it('an activity row is undoable only while it is the top of the stack', () => {
		const h = history(['user', 'bot', 'bot']);
		expect(entryUndoPlan(entry({ historyEntryId: 3 }), h)).toEqual({ ok: true, count: 1 });
		expect(entryUndoPlan(entry({ historyEntryId: 2 }), h)).toEqual({ ok: false, reason: 'newer-edits' });
		expect(entryUndoPlan(entry({ historyEntryId: null }), h)).toEqual({ ok: false, reason: 'not-undoable' });
		expect(entryUndoPlan(entry({ historyEntryId: 3 }), history(['user', 'bot', 'bot'], 2))).toEqual({
			ok: false,
			reason: 'undone',
		});
	});
});

describe('burst grouping (AF-ACT-003)', () => {
	it('groups transactions less than 2 s apart and starts a new burst after a pause', () => {
		const tracker = new AgentBurstTracker();
		const h = history(['bot', 'bot', 'bot', 'bot']);
		const a = tracker.add(entry({ time: 0, historyEntryId: 1 }), h);
		const b = tracker.add(entry({ time: 1500, historyEntryId: 2 }), h);
		const c = tracker.add(entry({ time: 1500 + BURST_WINDOW_MS, historyEntryId: 3 }), h);
		expect(b.id).toBe(a.id);
		expect(b.count).toBe(2);
		expect(b.historyIds).toEqual([1, 2]);
		expect(c.id).toBe(a.id);
		expect(c.count).toBe(3);
		const d = tracker.add(entry({ time: 1501 + 2 * BURST_WINDOW_MS, historyEntryId: 4 }), h);
		expect(d.id).not.toBe(a.id);
		expect(d.count).toBe(1);
		expect(d.historyIds).toEqual([4]);
	});

	it('a user edit between two agent transactions starts a new burst', () => {
		const tracker = new AgentBurstTracker();
		const h = history(['bot', 'user', 'bot']);
		const a = tracker.add(entry({ time: 0, historyEntryId: 1 }), h);
		const b = tracker.add(entry({ time: 300, historyEntryId: 3 }), h);
		expect(b.id).not.toBe(a.id);
		expect(b.historyIds).toEqual([3]);
	});

	it('counts transactions that changed nothing but has nothing of theirs to undo', () => {
		const tracker = new AgentBurstTracker();
		const h = history(['bot']);
		tracker.add(entry({ time: 0, historyEntryId: 1, created: ['a', 'b'] }), h);
		const b = tracker.add(entry({ time: 100, historyEntryId: null, created: [], changed: ['a'] }), h);
		expect(b.count).toBe(2);
		expect(b.items).toBe(3);
		expect(b.historyIds).toEqual([1]);
	});

	it('keeps the agents of a burst and names the toast "Agent: N edits"', () => {
		const tracker = new AgentBurstTracker();
		const h = history(['bot', 'codex']);
		const one = tracker.add(entry({ time: 0, historyEntryId: 1, label: 'Add marker' }), h);
		expect(burstToastText(one)).toEqual({ title: 'Agent: Add marker', detail: 'bot · 1 item changed' });
		const two = tracker.add(entry({ time: 10, historyEntryId: 2, agent: 'codex', created: ['a', 'b'] }), h);
		expect(two.agents).toEqual(['bot', 'codex']);
		expect(burstToastText(two)).toEqual({ title: 'Agent: 2 edits', detail: 'bot, codex · 3 items changed' });
	});

	it('names no item count for a transaction that changes no items (an agent note, a brief)', () => {
		const tracker = new AgentBurstTracker();
		const h = history(['bot']);
		const note = tracker.add(
			entry({ time: 0, historyEntryId: 1, label: 'Add agent note', created: [], changed: [], deleted: [] }),
			h,
		);
		expect(burstToastText(note)).toEqual({ title: 'Agent: Add agent note', detail: 'bot' });
	});
});

const job = (p: Partial<PresenceJob> & { agent?: string }): PresenceJob => ({
	id: 'j1',
	title: 'Transcribe',
	state: 'running',
	progress: 0.4,
	origin: { type: 'agent', agentRunId: p.agent ?? 'bot' },
	createdAt: new Date(0).toISOString(),
	...p,
});

const proposal = (p: Partial<ProposalSummary>): ProposalSummary =>
	({
		id: 'prp_0000000000000001',
		projectId: 'p',
		sequenceId: null,
		feature: 'generic',
		title: 'Rough cut',
		summary: '',
		author: { agent: 'bot' },
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		expiresAt: new Date(0).toISOString(),
		baseRevision: 0,
		itemCount: 3,
		counts: {} as ProposalSummary['counts'],
		decided: false,
		waiting: null,
		...p,
	}) as ProposalSummary;

describe('header chip state machine (AF-ACT-002)', () => {
	const now = 10 * 60_000 + 5_000;
	const base = { activity: [], approvals: [], proposals: [], jobs: [], now };

	it('no agents: idle with nothing to show', () => {
		expect(agentPresence(base)).toEqual({ agents: [], phase: 'idle', attention: 0, nextChangeAt: null });
	});

	it('working while transactions arrive, then idle after the working window, then gone', () => {
		const p = agentPresence({ ...base, activity: [entry({ time: now - 1000 })] });
		expect(p.phase).toBe('working');
		expect(p.agents[0]).toMatchObject({ agent: 'bot', phase: 'working', step: 'Add marker' });
		expect(p.nextChangeAt).toBe(now - 1000 + WORKING_MS);
		const later = agentPresence({ ...base, activity: [entry({ time: now - WORKING_MS - 1 })] });
		expect(later.phase).toBe('idle');
		expect(later.agents[0]!.phase).toBe('idle');
		expect(later.nextChangeAt).toBe(now - WORKING_MS - 1 + PRESENCE_MS);
		expect(agentPresence({ ...base, activity: [entry({ time: now - PRESENCE_MS - 1 })] }).agents).toEqual([]);
	});

	it('working while one of its jobs runs; the step names the job and its progress', () => {
		const p = agentPresence({ ...base, jobs: [job({})] });
		expect(p.agents[0]).toMatchObject({
			agent: 'bot',
			phase: 'working',
			step: 'Transcribe 40%',
			runningJobs: 1,
		});
		// user jobs are not an agent's
		expect(agentPresence({ ...base, jobs: [job({ origin: { type: 'user' } })] }).agents).toEqual([]);
	});

	it('error after a failed transaction until a later success or the error window ends', () => {
		const failed = entry({
			time: now - 20_000,
			ok: false,
			errors: [{ code: 'E_NOT_FOUND', message: 'No such clip', commandIndex: 0 }],
		});
		const p = agentPresence({ ...base, activity: [failed] });
		expect(p.phase).toBe('error');
		expect(p.agents[0]).toMatchObject({ phase: 'error', error: 'No such clip' });
		expect(p.nextChangeAt).toBe(failed.time + ERROR_MS);
		// newest first, like the bridge's log
		const recovered = agentPresence({ ...base, activity: [entry({ time: now - 15_000 }), failed] });
		expect(recovered.agents[0]!.phase).toBe('idle');
		// a denial is the user's decision, not the agent's error; a failed dry run is the agent checking
		const denied = entry({
			time: now - 20_000,
			ok: false,
			errors: [{ code: 'E_APPROVAL_DENIED', message: 'denied', commandIndex: -1 }],
		});
		expect(agentPresence({ ...base, activity: [denied] }).agents[0]!.phase).toBe('idle');
		expect(agentPresence({ ...base, activity: [{ ...failed, dryRun: true }] }).agents[0]!.phase).toBe('idle');
		// a failed job is an error too
		const fj = job({
			state: 'failed',
			finishedAt: new Date(now - 1000).toISOString(),
			error: { code: 'X', message: 'Out of disk', retryable: false },
		});
		expect(agentPresence({ ...base, jobs: [fj] }).agents[0]).toMatchObject({
			phase: 'error',
			error: 'Out of disk',
		});
	});

	it('waiting for review while the agent polls its proposal or one of its proposals is undecided', () => {
		const p = agentPresence({
			...base,
			proposals: [proposal({ waiting: { agent: 'bot', since: new Date(now - 60_000).toISOString() } })],
		});
		expect(p.phase).toBe('review');
		expect(p.attention).toBe(1);
		expect(p.agents[0]).toMatchObject({ agent: 'bot', phase: 'review', reviews: 1 });
		const fresh = agentPresence({
			...base,
			proposals: [proposal({ updatedAt: new Date(now - 1000).toISOString() })],
		});
		expect(fresh.agents[0]!.phase).toBe('review');
		// decided, the user's own, or long untouched and nobody waiting: not a reason to show the agent
		expect(
			agentPresence({
				...base,
				proposals: [proposal({ decided: true, updatedAt: new Date(now).toISOString() })],
			}).agents,
		).toEqual([]);
		expect(
			agentPresence({
				...base,
				proposals: [proposal({ author: 'user', updatedAt: new Date(now).toISOString() })],
			}).agents,
		).toEqual([]);
		expect(agentPresence({ ...base, proposals: [proposal({})] }).agents).toEqual([]);
	});

	it('approval pending outranks every other state; agents are listed most urgent first', () => {
		const p = agentPresence({
			...base,
			activity: [
				entry({ agent: 'codex', time: now - 100 }),
				entry({ time: now - 30_000, ok: false, errors: [{ code: 'E_X', message: 'x', commandIndex: 0 }] }),
			],
			approvals: [{ agent: 'bot' }],
		});
		expect(p.phase).toBe('approval');
		expect(p.attention).toBe(1);
		expect(p.agents.map((a) => [a.agent, a.phase])).toEqual([
			['bot', 'approval'],
			['codex', 'working'],
		]);
	});

	it('ignores nonfinite times', () => {
		const p = agentPresence({ ...base, jobs: [job({ state: 'failed', finishedAt: 'not a date' })] });
		expect(p.agents).toEqual([]);
		expect(p.nextChangeAt).toBeNull();
	});
});
