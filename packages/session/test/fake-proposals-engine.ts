// A fake of the engine's proposal routes for tests (session slice, web ghosts): the pure model behind every route,
// and accept relayed into the session as the user's ONE transaction, like the engine with the editor key.
import type { ProposalChangedEvent, ProposalSummary } from '@jasper/api';
import {
	anchorFingerprint,
	createProposal,
	type DecisionResult,
	defaultRegistries,
	markAccepted,
	type Proposal,
	planAccept,
	proposalCounts,
	proposalDecided,
	rejectItems,
	reopenItems,
	reopenRefusals,
	selectAlternative,
	setItemNote,
} from '@jasper/project';
import type { EditorSession, ProposalsEngine } from '../src/index.ts';

const REG = defaultRegistries();

export class FakeEngine implements ProposalsEngine {
	readonly proposals = new Map<string, Proposal>();
	readonly calls: string[] = [];
	private readonly listeners = new Set<(e: ProposalChangedEvent) => void>();
	private t = Date.parse('2026-10-16T10:00:00.000Z');
	private n = 0;
	failNext: string | null = null;
	constructor(private readonly session: () => EditorSession) {}
	now = () => new Date((this.t += 1000)).toISOString();
	subscribe = (cb: (e: ProposalChangedEvent) => void) => {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	};
	private emit(
		p: Proposal,
		change: ProposalChangedEvent['change'],
		itemIds?: string[],
		extra: Partial<ProposalChangedEvent> = {},
	) {
		for (const l of this.listeners)
			l({
				projectId: p.projectId,
				proposalId: p.id,
				change,
				counts: proposalCounts(p),
				...(itemIds ? { itemIds } : {}),
				...extra,
			});
	}
	private put(
		p: Proposal,
		change: ProposalChangedEvent['change'],
		itemIds?: string[],
		extra: Partial<ProposalChangedEvent> = {},
	) {
		const stamped = { ...p, updatedAt: this.now() };
		this.proposals.set(p.id, stamped);
		this.emit(stamped, change, itemIds, extra);
		return stamped;
	}
	private get(id: string): Proposal {
		if (this.failNext) {
			const code = this.failNext;
			this.failNext = null;
			throw Object.assign(new Error(`failed: ${code}`), { code, status: 409, detail: { code } });
		}
		const p = this.proposals.get(id);
		if (!p) throw Object.assign(new Error('not found'), { code: 'PROPOSAL_NOT_FOUND', status: 404 });
		return p;
	}
	create(draft: Record<string, unknown>, author: Proposal['author'] = { agent: 'sound-agent' }): Proposal {
		const s = this.session();
		const r = createProposal(
			s.getCommitted(),
			draft,
			{
				id: `prp_${String(++this.n).padStart(16, '0')}`,
				projectId: s.projectId,
				author,
				now: this.now(),
				revision: s.revision,
			},
			{ registries: REG },
		);
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return this.put(r.proposal, 'created');
	}
	async listProposals(): Promise<{ proposals: ProposalSummary[]; warnings: string[] }> {
		this.calls.push('list');
		return {
			proposals: [...this.proposals.values()].map((p) => ({
				id: p.id,
				projectId: p.projectId,
				sequenceId: p.sequenceId,
				feature: p.feature,
				title: p.title,
				summary: p.summary,
				author: p.author,
				createdAt: p.createdAt,
				updatedAt: p.updatedAt,
				expiresAt: p.updatedAt,
				baseRevision: p.baseRevision,
				itemCount: p.items.length,
				counts: proposalCounts(p),
				decided: proposalDecided(p),
			})),
			warnings: [],
		};
	}
	async getProposal(_pid: string, id: string) {
		this.calls.push(`get ${id}`);
		return { proposal: this.get(id), expiresAt: 'x', revision: null };
	}
	async acceptProposal(
		_pid: string,
		id: string,
		req: { itemIds: string[] | 'all'; partial?: boolean; expectedRevision?: number },
		/** Who accepts: the editor (default; relayed as the user's edit) or an allowed agent. */
		as: { agent: string } | 'user' = 'user',
	) {
		this.calls.push(`accept ${JSON.stringify(req.itemIds)}`);
		const s = this.session();
		const p0 = this.get(id);
		const plan = planAccept(
			s.getCommitted(),
			p0,
			req.itemIds,
			as,
			{ registries: REG, revision: s.revision },
			{
				partial: req.partial === true,
			},
		);
		if (!plan.ok)
			throw Object.assign(new Error(plan.errors[0]!.message), {
				code: 'PROPOSAL_STALE',
				detail: { code: 'E_PROPOSAL_STALE', stale: plan.stale },
			});
		if (!plan.composed)
			return {
				proposal: plan.proposal,
				applied: [],
				added: [],
				skipped: [],
				stale: plan.stale,
				result: null,
				appliedBy: null,
				revision: s.revision,
			};
		// the engine relays the ONE composed transaction into the open editor as the user's edit (asUser)
		const result = await s.submit({ ...plan.composed.tx, origin: as } as never);
		if (!result.ok) throw Object.assign(new Error('rejected'), { code: 'TRANSACTION_REJECTED' });
		const accepted = this.put(
			markAccepted(plan.proposal, plan.composed.itemIds, {
				revision: result.revision,
				refs: result.refs,
				at: this.now(),
				created: result.created,
			}),
			'accepted',
			plan.composed.itemIds,
			{ revision: result.revision },
		);
		return {
			proposal: accepted,
			applied: plan.composed.itemIds,
			added: plan.composed.added,
			skipped: plan.composed.skipped,
			stale: plan.stale,
			result,
			appliedBy: 'session' as const,
			revision: result.revision,
		};
	}
	private decide(id: string, r: DecisionResult, change: ProposalChangedEvent['change']) {
		if (!r.ok) throw Object.assign(new Error('refused'), { code: 'VALIDATION_FAILED' });
		const ok = r;
		if (!ok.changed.length) return { proposal: this.get(id), changed: [] };
		return { proposal: this.put(ok.proposal, change, ok.changed), changed: ok.changed };
	}
	async rejectProposal(_pid: string, id: string, req: { itemIds: string[] | 'all' }) {
		this.calls.push(`reject ${JSON.stringify(req.itemIds)}`);
		return this.decide(id, rejectItems(this.get(id), req.itemIds, this.now()), 'rejected');
	}
	async reopenProposal(_pid: string, id: string, req: { itemIds: string[] | 'all' }) {
		this.calls.push(`reopen ${JSON.stringify(req.itemIds)}`);
		const p = this.get(id);
		// like the engine: an accepted item whose accept is still in the document is not reopened
		const refused = reopenRefusals(this.session().getCommitted(), p, req.itemIds);
		if (refused.length)
			throw Object.assign(new Error(refused[0]!.message), {
				code: 'PROPOSAL_STILL_APPLIED',
				status: 409,
				detail: { code: 'E_STILL_APPLIED' },
			});
		return this.decide(id, reopenItems(p, req.itemIds, this.now()), 'reopened');
	}
	async noteProposalItem(_pid: string, id: string, req: { itemId: string; note: string | null }) {
		this.calls.push(`note ${req.itemId}`);
		return this.decide(id, setItemNote(this.get(id), req.itemId, req.note, this.now()), 'noted');
	}
	async selectProposalAlternative(_pid: string, id: string, req: { itemId: string; alternative: number }) {
		this.calls.push(`select ${req.itemId} ${req.alternative}`);
		return this.decide(
			id,
			selectAlternative(this.get(id), req.itemId, req.alternative, this.now()),
			'selected',
		);
	}
	async markProposalApplied(
		_pid: string,
		id: string,
		req: { itemIds: string[]; revision: number; refs: Record<string, string>; created?: string[] },
	) {
		this.calls.push(`applied ${JSON.stringify(req.itemIds)}`);
		const p = this.get(id);
		const ids = req.itemIds.filter((x) => p.items.find((it) => it.id === x)?.state !== 'accepted');
		if (ids.length === 0) return { proposal: p, changed: [] };
		const doc = this.session().getCommitted();
		if (req.created?.length && !req.created.some((x) => anchorFingerprint(doc, x) !== null))
			throw Object.assign(new Error('the document does not have what the accept created'), {
				code: 'PROPOSAL_NOT_APPLIED',
				status: 409,
				detail: { code: 'E_NOT_APPLIED' },
			});
		const next = markAccepted(p, ids, {
			revision: req.revision,
			refs: req.refs,
			at: this.now(),
			...(req.created ? { created: req.created } : {}),
		});
		return { proposal: this.put(next, 'accepted', ids, { revision: req.revision }), changed: ids };
	}
	async deleteProposal(_pid: string, id: string) {
		this.calls.push(`delete ${id}`);
		const p = this.get(id);
		this.proposals.delete(id);
		this.emit(p, 'deleted');
		return { proposalId: id, deleted: true as const };
	}
}
