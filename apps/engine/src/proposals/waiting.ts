// "<agent> is waiting for your review" (spec 12 §2.7 Review, WP3.3b): the engine infers it from an agent polling a
// proposal. jasper-mcp's `wait_for_proposal` reads the proposal once a second without `?revalidate` until the user
// decides; an agent's `get_proposal` revalidates and reads it once. So two plain reads of the same proposal by an agent
// (no editor key) within `pollGapMs` mean "waiting", and no read for `idleMs` means it stopped. Each flip is announced
// (`proposal.changed` `waiting`) and the list carries the current state. Nothing is stored; an engine restart forgets
// it (the next poll brings it back within a second).

export type Waiting = { agent: string; since: string };

type Entry = {
	agent: string;
	firstAt: number;
	lastAt: number;
	since: string | null;
	timer: unknown;
};

export type WaitWatchOptions = {
	/** Announces a change: who waits now (null: nobody). */
	publish(projectId: string, proposalId: string, waiting: Waiting | null): void;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Two reads at most this far apart are a poll (default 2.5 s; jasper-mcp polls every 1 s). */
	pollGapMs?: number;
	/** No read for this long ends the wait (default 3.5 s). */
	idleMs?: number;
	/** Proposals followed at once (default 1 000; the oldest is forgotten beyond it). */
	maxEntries?: number;
};

export class ProposalWaitWatch {
	private readonly entries = new Map<string, Entry>();
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly pollGapMs: number;
	private readonly idleMs: number;
	private readonly maxEntries: number;

	constructor(private readonly opts: WaitWatchOptions) {
		this.now = opts.now ?? Date.now;
		this.setTimer =
			opts.setTimer ??
			((fn, ms) => {
				const h = setTimeout(fn, ms);
				(h as { unref?: () => void }).unref?.();
				return h;
			});
		this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.pollGapMs = opts.pollGapMs ?? 2500;
		this.idleMs = opts.idleMs ?? 3500;
		this.maxEntries = opts.maxEntries ?? 1000;
	}

	private static key(projectId: string, proposalId: string): string {
		return `${projectId}/${proposalId}`;
	}

	/** An agent read the proposal without revalidating (what a waiting `wait_for_proposal` does every second). */
	poll(projectId: string, proposalId: string, agent: string): void {
		const key = ProposalWaitWatch.key(projectId, proposalId);
		const at = this.now();
		let e = this.entries.get(key);
		if (e && (e.agent !== agent || at - e.lastAt > this.pollGapMs)) {
			// another agent, or a read long after the last one: a new first read
			if (e.since !== null && e.agent !== agent) this.announce(projectId, proposalId, null);
			this.clearTimer(e.timer);
			this.entries.delete(key);
			e = undefined;
		}
		if (!e) {
			if (this.entries.size >= this.maxEntries) {
				const [oldest, old] = this.entries.entries().next().value as [string, Entry];
				this.clearTimer(old.timer);
				this.entries.delete(oldest);
			}
			e = { agent, firstAt: at, lastAt: at, since: null, timer: null };
			this.entries.set(key, e);
		} else {
			e.lastAt = at;
			if (e.since === null) {
				e.since = new Date(e.firstAt).toISOString();
				this.announce(projectId, proposalId, { agent, since: e.since });
			}
		}
		this.clearTimer(e.timer);
		const entry = e;
		entry.timer = this.setTimer(() => {
			if (this.entries.get(key) !== entry) return;
			this.entries.delete(key);
			if (entry.since !== null) this.announce(projectId, proposalId, null);
		}, this.idleMs);
	}

	/** Who waits for the review of a proposal now (null: nobody). */
	waiting(projectId: string, proposalId: string): Waiting | null {
		const e = this.entries.get(ProposalWaitWatch.key(projectId, proposalId));
		return e && e.since !== null ? { agent: e.agent, since: e.since } : null;
	}

	/** The proposal is gone: stop following it (nothing is announced). */
	forget(projectId: string, proposalId: string): void {
		const key = ProposalWaitWatch.key(projectId, proposalId);
		const e = this.entries.get(key);
		if (!e) return;
		this.clearTimer(e.timer);
		this.entries.delete(key);
	}

	dispose(): void {
		for (const e of this.entries.values()) this.clearTimer(e.timer);
		this.entries.clear();
	}

	private announce(projectId: string, proposalId: string, waiting: Waiting | null): void {
		try {
			this.opts.publish(projectId, proposalId, waiting);
		} catch {
			// event fan-out never breaks a read
		}
	}
}
