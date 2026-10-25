// Proposal service (spec 12 §2.5, P3-R2; spec 15 §2.1): creates proposals validated against the project's live
// document, accepts items as ONE transaction through the agent service (live into the open editor, or headless),
// records decisions, re-plans stale items through the feature's producer ("Refresh proposal", EA-003), and publishes
// `proposal.changed`. The accept policy gate: a request without the editor key (an agent) may accept only where the
// feature allows it — sound design: the sequence's `soundDesign.settings.agentsMayApply` (default off); edit
// automation, subtitles and transcript cleanup: Project Settings ▸ Agent Proposals (default on, EA-001); any other
// feature: refused. Destructive commands inside the accepted items still need the user's approval card when an agent
// accepts (the transaction goes through the usual classification). A draft over the transaction caps is refused with
// 413 PROPOSAL_TOO_LARGE (E_TOO_LARGE, with the range that fits; EA-004).
import { randomBytes } from 'node:crypto';
import type { ProposalChangedEvent, ProposalCountsJson, ProposalFeature } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	type Author,
	agentProposalsAllowed,
	anchorFingerprint,
	CROCKFORD_ALPHABET,
	createProposal,
	defaultRegistries,
	itemAnchors,
	looksLikeId,
	markAccepted,
	type Origin,
	PROPOSAL_FEATURES,
	type ProjectDocument,
	type Proposal,
	type ProposalContext,
	type ProposalIssue,
	type ProposalItemInput,
	type ProposalPolicyDecision,
	planAccept,
	projectFeaturePolicy,
	projectSettingFeatures,
	proposalCounts,
	REFRESHABLE_STATES,
	type Registries,
	readAgentProposals,
	refreshProposalItems,
	rejectItems,
	reopenItems,
	reopenRefusals,
	revalidate,
	SOUND_DESIGN_FEATURE,
	selectAlternative,
	selectedCommands,
	setItemNote,
	settleSetupItems,
	soundAgentAcceptBySequence,
	soundDesignSettingsOf,
	type TransactionResult,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import { HttpError } from '../tools/reply.ts';
import { type AcceptIntent, ambiguousResult, prepareIntent, reconcileEvidence } from './journal.ts';
import { type ProposalStore, proposalNotFound } from './store.ts';

/** Who asks: the editor window (editor key) or anything else (an agent), with the agent's display name. */
export type Requester = { editor: boolean; agent: string };

export type PolicyDecision = ProposalPolicyDecision;
/** Whether an agent may accept a feature's proposals in this document. */
export type ProposalPolicy = (doc: ProjectDocument, proposal: Proposal) => PolicyDecision;

/** Sound design: the sequence's "Allow agents to apply sound proposals" (default off, spec 12 §0). */
export const soundDesignPolicy: ProposalPolicy = (doc, proposal) => {
	const seq =
		proposal.sequenceId && Object.hasOwn(doc.sequences, proposal.sequenceId)
			? doc.sequences[proposal.sequenceId]
			: undefined;
	if (seq && soundDesignSettingsOf(seq).agentsMayApply === true) return { allowed: true };
	return {
		allowed: false,
		reason: seq
			? 'Agents may not apply sound proposals in this sequence: the user reviews and applies them in the editor (they can allow agents with "Allow agents to apply sound proposals")'
			: 'Agents may not apply this sound proposal: it names no sequence whose settings allow it; the user applies it in the editor',
	};
};

/**
 * A producer's re-plan of stale items ("Refresh proposal", spec 15 EA-003): given the stored proposal (its `report`
 * carries the pass's parameters), the items to re-plan and the live document, it returns a replacement per item it
 * could re-plan (same id, same temp refs), the items that no longer apply (`dropped`) and optionally a new report.
 * Pure planners in `@jasper/project` run here; never applies anything. A throw is reported, never fatal.
 */
export type ProposalRefresher = (input: {
	projectId: string;
	proposal: Proposal;
	itemIds: string[];
	doc: ProjectDocument;
	revision: number;
}) =>
	| Promise<{ items: ProposalItemInput[]; dropped?: { itemId: string; reason: string }[]; report?: unknown }>
	| { items: ProposalItemInput[]; dropped?: { itemId: string; reason: string }[]; report?: unknown };

const ID_BYTES = 10;
function newAcceptId(): string {
	return `acc_${newProposalId().slice(4)}`;
}
function newProposalId(): string {
	const bytes = randomBytes(ID_BYTES);
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += CROCKFORD_ALPHABET[(buffer >> bits) & 31];
		}
		buffer &= (1 << bits) - 1;
	}
	return `prp_${out.slice(0, 16)}`;
}

const VALIDATION_ORIGIN: Origin = { agent: 'proposal-validation' };
const issuesDetail = (code: string, errors: readonly ProposalIssue[]) => ({
	code,
	errors: errors.slice(0, 50),
});

type Publish = (type: string, payload: unknown, projectId?: string) => void;

export class ProposalService {
	readonly store: ProposalStore;
	private readonly policies = new Map<string, ProposalPolicy>([[SOUND_DESIGN_FEATURE, soundDesignPolicy]]);
	private readonly refreshers = new Map<string, ProposalRefresher>();
	/** Serializes read-modify-write of one proposal (accept holds it across the transaction). */
	private readonly locks = new KeyedMutex();
	private readonly registries: Registries;
	private readonly now: () => Date;

	constructor(
		private readonly opts: {
			agent: () => AgentService | undefined;
			store: ProposalStore;
			publish?: Publish;
			registries?: Registries;
			now?: () => Date;
			log?: (msg: string) => void;
		},
	) {
		this.store = opts.store;
		this.registries = opts.registries ?? defaultRegistries(mgRegistry);
		this.now = opts.now ?? (() => new Date());
		// spec 15 EA-001: edit automation, subtitles, transcript cleanup — Project Settings ▸ Agent Proposals
		for (const f of projectSettingFeatures()) this.registerPolicy(f.id, projectFeaturePolicy(f.id));
	}

	/** An accept or decision on the proposal is running (the store does not expire or evict it meanwhile). */
	busy(projectId: string, proposalId: string): boolean {
		return this.locks.isBusy(`${projectId}/${proposalId}`);
	}

	/** Lets a feature allow agent accepts under its own rule (default: refused). */
	registerPolicy(feature: string, policy: ProposalPolicy): () => void {
		this.policies.set(feature, policy);
		return () => {
			if (this.policies.get(feature) === policy) this.policies.delete(feature);
		};
	}

	/**
	 * Lets a feature's producer re-plan stale items on request ("Refresh proposal", spec 15 EA-003). Without one, a
	 * refresh is refused with 409 PROPOSAL_NOT_REFRESHABLE (the Review panel disables the button with that reason).
	 */
	registerRefresher(feature: string, refresher: ProposalRefresher): () => void {
		this.refreshers.set(feature, refresher);
		return () => {
			if (this.refreshers.get(feature) === refresher) this.refreshers.delete(feature);
		};
	}

	/** The proposal features with this project's agent-accept state and whether their producer refreshes. */
	async features(projectId: string): Promise<ProposalFeature[]> {
		await this.ensureProject(projectId);
		const { doc } = await this.liveDocument(projectId);
		const stored = readAgentProposals(doc.settings);
		return PROPOSAL_FEATURES.map(
			(f): ProposalFeature => ({
				id: f.id,
				name: f.name,
				description: f.description,
				itemNoun: { ...f.itemNoun },
				groups: f.groups.map((g) => ({ ...g })),
				producers: [...f.producers],
				agentAccept:
					f.agentAccept.setting === 'project'
						? {
								setting: 'project',
								allowed: agentProposalsAllowed(doc, f.id) === true,
								default: f.agentAccept.default,
								explicit: stored === null || Object.hasOwn(stored, f.id),
							}
						: { setting: 'sound-sequence', sequences: soundAgentAcceptBySequence(doc) },
				refreshable: this.refreshers.has(f.id),
			}),
		);
	}

	private ctx(revision: number): ProposalContext {
		return {
			registries: this.registries,
			revision,
			now: () => this.now().toISOString(),
			invariants: 'incremental',
		};
	}

	private agent(): AgentService {
		const a = this.opts.agent();
		if (!a) throw new HttpError(503, 'NOT_AVAILABLE', 'The agent service is not running');
		return a;
	}

	publish(
		projectId: string,
		p: Proposal | null,
		change: ProposalChangedEvent['change'],
		extra: Partial<ProposalChangedEvent> = {},
		proposalId?: string,
	): void {
		const payload: ProposalChangedEvent = {
			projectId,
			proposalId: p?.id ?? proposalId ?? '',
			change,
			...(p
				? { feature: p.feature, sequenceId: p.sequenceId, counts: proposalCounts(p) as ProposalCountsJson }
				: {}),
			...extra,
		};
		try {
			this.opts.publish?.('proposal.changed', payload, projectId);
		} catch {
			// event fan-out never breaks a decision
		}
	}

	/** The live document (the open editor's when one holds the project, else the saved one) and its revision. */
	private async liveDocument(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
		const r = await this.agent().query({ projectId, query: 'doc.get', args: {} });
		const d = r.result as ProjectDocument | undefined;
		if (!d || typeof d !== 'object' || !d.sequences || typeof d.sequences !== 'object')
			throw new HttpError(422, 'VALIDATION_FAILED', 'The project has no readable document');
		return { doc: d, revision: typeof r.revision === 'number' ? r.revision : 0 };
	}

	private async ensureProject(projectId: string): Promise<void> {
		if (!(await this.agent().projectExists(projectId)))
			throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
	}

	/**
	 * The stored proposal, read by the holder of its lock (404 when absent or expired), after its journalled accept (if
	 * any) is reconciled. `accept`: refuse while that accept cannot be settled yet (it may be in an editor that is away).
	 */
	private async load(
		projectId: string,
		proposalId: string,
		opts: { accept?: boolean } = {},
	): Promise<Proposal> {
		const settled = await this.reconcile(projectId, proposalId);
		if (settled === 'waiting' && opts.accept)
			throw new HttpError(
				409,
				'NO_SESSION',
				'An earlier accept of this proposal went to an editor window that is not connected now: its items are recorded once that window is back (or its lease expires); accept again then',
				{ code: 'E_NO_SESSION', retryable: true },
			);
		const p = await this.store.get(projectId, proposalId, { owner: true });
		if (!p) throw proposalNotFound(proposalId);
		return p;
	}

	private log(msg: string): void {
		try {
			(this.opts.log ?? ((m: string) => console.warn(m)))(msg);
		} catch {
			// logging never breaks a decision
		}
	}

	/**
	 * Reconciles the journalled accepts of a project (accepts that were not working any more: an engine that stopped
	 * between the transaction and the write of the states, a lost relay answer) before the proposals are read.
	 */
	private async reconcileProject(projectId: string): Promise<void> {
		for (const id of await this.store.intentIds(projectId)) {
			if (this.busy(projectId, id)) continue; // an accept of this engine is running: its intent is current
			try {
				await this.locks.run(`${projectId}/${id}`, () => this.reconcile(projectId, id));
			} catch (e) {
				this.log(`[proposals] could not reconcile the accept of ${id}: ${(e as Error).message}`);
			}
		}
	}

	/**
	 * The holder of the proposal's lock settles its journalled accept, if any: in the document → the items are
	 * recorded accepted (with the refs and created ids found there); not in it → the intent is rolled back. While the
	 * editor that applied it may still come back with it unsaved (its lease is alive, it is not connected), nothing is
	 * decided: 'waiting'.
	 */
	private async reconcile(projectId: string, proposalId: string): Promise<'none' | 'done' | 'waiting'> {
		const intent = await this.store.readIntent(projectId, proposalId);
		if (!intent) return 'none';
		const p = await this.store.get(projectId, proposalId, { owner: true });
		if (!p) {
			await this.store.clearIntent(projectId, proposalId);
			return 'done';
		}
		const byId = new Map(p.items.map((it) => [it.id, it]));
		if (intent.itemIds.every((id) => byId.get(id)?.state === 'accepted')) {
			// the states were written; only the intent's removal was lost
			await this.store.clearIntent(projectId, proposalId);
			return 'done';
		}
		const agent = this.agent();
		if (intent.via === 'session' && (await agent.editorAway(projectId))) return 'waiting';
		const { doc, revision } = await this.liveDocument(projectId);
		const evidence = reconcileEvidence(doc, intent);
		if (!evidence.applied) {
			await this.store.clearIntent(projectId, proposalId);
			this.log(
				`[proposals] accept ${intent.acceptId} of ${proposalId} did not reach the document (${evidence.reason}): rolled back, its items stay as they were`,
			);
			return 'done';
		}
		const at = this.now().toISOString();
		const ids = intent.itemIds.filter((id) => byId.has(id) && byId.get(id)!.state !== 'accepted');
		const marked = markAccepted(p, ids, {
			revision: Math.max(revision, intent.baseRevision + 1),
			refs: evidence.refs,
			at,
			created: evidence.created,
		});
		const accepted = settleSetupItems(marked, at).proposal;
		await this.store.put(projectId, accepted);
		await this.store.clearIntent(projectId, proposalId);
		this.log(
			`[proposals] accept ${intent.acceptId} of ${proposalId} was in the document: recorded ${ids.length} item(s) accepted`,
		);
		this.publish(projectId, accepted, 'accepted', { itemIds: ids, revision });
		return 'done';
	}

	async list(projectId: string) {
		await this.ensureProject(projectId);
		await this.reconcileProject(projectId);
		return this.store.list(projectId);
	}

	async get(projectId: string, proposalId: string, opts: { revalidate?: boolean } = {}) {
		await this.ensureProject(projectId);
		if (!opts.revalidate) {
			if (this.store.hasIntent(projectId, proposalId) && !this.busy(projectId, proposalId))
				await this.reconcileProject(projectId);
			// a plain read (not the lock holder): it does not expire a proposal an accept is working on
			const p = await this.store.get(projectId, proposalId);
			if (!p) throw proposalNotFound(proposalId);
			return { proposal: p, revision: null };
		}
		return this.locks.run(`${projectId}/${proposalId}`, async () => {
			const p = await this.load(projectId, proposalId);
			const { doc, revision } = await this.liveDocument(projectId);
			const rv = revalidate(doc, p, this.ctx(revision));
			let out = p;
			if (rv.changed) {
				out = { ...rv.proposal, updatedAt: this.now().toISOString() };
				await this.store.put(projectId, out);
				this.publish(projectId, out, 'revalidated', { itemIds: rv.stale.map((s) => s.itemId) });
			}
			return { proposal: out, revision };
		});
	}

	async create(projectId: string, body: Record<string, unknown>, who: Requester) {
		await this.ensureProject(projectId);
		const { author: requestedAuthor, ...draft } = body as { author?: Author };
		// Only the editor window may say who wrote it; an agent is always itself.
		const author: Author = who.editor ? (requestedAuthor ?? 'user') : { agent: who.agent };
		const { doc, revision } = await this.liveDocument(projectId);
		const r = createProposal(
			doc,
			draft,
			{ id: newProposalId(), projectId, author, now: this.now().toISOString(), revision },
			this.ctx(revision),
		);
		if (!r.ok) {
			const first = r.errors[0];
			if (first?.code === 'E_TOO_LARGE')
				throw new HttpError(413, 'PROPOSAL_TOO_LARGE', first.message, {
					code: 'E_TOO_LARGE',
					...(first.detail ?? {}),
				});
			throw new HttpError(
				400,
				'VALIDATION_FAILED',
				`The proposal is malformed: ${first?.message ?? 'invalid'}`,
				issuesDetail(first?.code ?? 'E_SCHEMA', r.errors),
			);
		}
		// Setup items only invalid items need are settled at once (nothing would ever apply them).
		const proposal = settleSetupItems(r.proposal, r.proposal.updatedAt).proposal;
		const { evicted } = await this.store.create(projectId, proposal);
		for (const id of evicted) this.publish(projectId, null, 'evicted', {}, id);
		this.publish(projectId, proposal, 'created');
		return { proposal, revision, evicted };
	}

	async accept(
		projectId: string,
		proposalId: string,
		req: { itemIds: string[] | 'all'; partial?: boolean; expectedRevision?: number },
		who: Requester,
	) {
		await this.ensureProject(projectId);
		return this.locks.run(`${projectId}/${proposalId}`, async () => {
			const p0 = await this.load(projectId, proposalId, { accept: true });
			const { doc, revision } = await this.liveDocument(projectId);
			if (!who.editor) {
				const policy = this.policies.get(p0.feature);
				const decision: PolicyDecision = policy
					? safePolicy(policy, doc, p0)
					: {
							allowed: false,
							reason: `Agents may not apply "${p0.feature}" proposals: the user reviews and applies them in the editor`,
						};
				if (!decision.allowed)
					throw new HttpError(403, 'APPROVAL_REQUIRED', decision.reason, {
						code: 'E_APPROVAL_REQUIRED',
						feature: p0.feature,
					});
			}
			if (req.expectedRevision !== undefined && req.expectedRevision > revision)
				throw new HttpError(
					409,
					'REVISION_CONFLICT',
					`Revision ${req.expectedRevision} is ahead of the document (${revision})`,
					{ code: 'E_REVISION_MISMATCH', revision },
				);
			const origin: Origin = who.editor ? 'user' : { agent: who.agent, runId: proposalId };
			const plan = planAccept(doc, p0, req.itemIds, origin, this.ctx(revision), {
				partial: req.partial === true,
				expectedRevision: req.expectedRevision ?? revision,
			});
			// Re-validated states are kept whatever happens next.
			let p = plan.proposal;
			const save = async (next: Proposal, change: ProposalChangedEvent['change'], extra = {}) => {
				if (next === p0) return;
				const stamped = { ...next, updatedAt: this.now().toISOString() };
				await this.store.put(projectId, stamped);
				p = stamped;
				this.publish(projectId, stamped, change, extra);
			};
			if (!plan.ok) {
				await save(p, 'revalidated', { itemIds: plan.stale.map((s) => s.itemId) });
				const notFound = plan.errors.every((e) => e.code === 'E_NOT_FOUND');
				const stale = plan.errors.some((e) => e.code === 'E_STALE' || e.code === 'E_INVALID_PARAM');
				if (notFound)
					throw new HttpError(
						404,
						'NOT_FOUND',
						plan.errors[0]!.message,
						issuesDetail('E_NOT_FOUND', plan.errors),
					);
				if (stale)
					throw new HttpError(409, 'PROPOSAL_STALE', `Nothing was applied: ${plan.errors[0]!.message}`, {
						...issuesDetail('E_PROPOSAL_STALE', plan.errors),
						stale: plan.stale,
					});
				throw new HttpError(
					409,
					'TRANSACTION_REJECTED',
					`Nothing was applied: ${plan.errors[0]?.message ?? 'the items do not apply'}`,
					issuesDetail(plan.errors[0]?.code ?? 'E_INTERNAL', plan.errors),
				);
			}
			if (!plan.composed) {
				await save(p, 'revalidated', { itemIds: plan.stale.map((s) => s.itemId) });
				return {
					proposal: p,
					applied: [],
					added: [],
					skipped:
						req.itemIds === 'all'
							? []
							: req.itemIds.filter((id) => p.items.find((i) => i.id === id)?.state === 'accepted'),
					stale: plan.stale,
					result: null,
					appliedBy: null,
					revision,
				};
			}
			const composed = plan.composed;
			const agent = this.agent();
			// The journal: the intent (with the ids the transaction will create its entities with) is on disk before the
			// transaction runs, and removed after the states are written (`reconcile` settles one left behind).
			const intent: AcceptIntent = prepareIntent(doc, composed.tx as Record<string, unknown>, {
				acceptId: newAcceptId(),
				projectId,
				proposalId,
				itemIds: composed.itemIds,
				revision,
				via: agent.isLive(projectId) ? 'session' : 'headless',
				at: this.now().toISOString(),
				registries: this.registries,
			});
			await this.store.writeIntent(projectId, intent);
			const out = await agent.transact(projectId, composed.tx, {
				fallbackAgent: who.agent,
				ids: intent.ids,
				...(who.editor ? { preApproved: true, asUser: true } : {}),
			});
			const result = out.result as TransactionResult;
			if (!result.ok) {
				// Not applied: the intent goes. A relay that lost the editor's answer may have applied it: the intent stays
				// and is reconciled when the proposal is next read.
				if (!ambiguousResult(result)) await this.store.clearIntent(projectId, proposalId);
				await save(p, 'revalidated', { itemIds: plan.stale.map((s) => s.itemId) });
				throw txError(result);
			}
			const at = this.now().toISOString();
			const marked = markAccepted(p, composed.itemIds, {
				revision: result.revision,
				refs: result.refs,
				at,
				created: result.created,
			});
			// Setup items only rejected items needed are done too (the proposal can be decided).
			const accepted = settleSetupItems(marked, at).proposal;
			await this.store.put(projectId, accepted);
			p = accepted;
			try {
				await this.store.clearIntent(projectId, proposalId);
			} catch (e) {
				// recorded; the intent left behind is cleared by the next read (every item of it is accepted)
				this.log(`[proposals] could not remove the accept journal of ${proposalId}: ${(e as Error).message}`);
			}
			this.publish(projectId, accepted, 'accepted', { itemIds: composed.itemIds, revision: result.revision });
			return {
				proposal: accepted,
				applied: composed.itemIds,
				added: composed.added,
				skipped: composed.skipped,
				stale: plan.stale,
				result,
				appliedBy: out.appliedBy,
				revision: result.revision,
			};
		});
	}

	/** reject / reopen / note / select: decisions on the stored proposal (nothing in the document changes). */
	async decide(
		projectId: string,
		proposalId: string,
		decision:
			| { kind: 'reject'; itemIds: string[] | 'all' }
			| { kind: 'reopen'; itemIds: string[] | 'all' }
			| { kind: 'note'; itemId: string; note: string | null }
			| { kind: 'select'; itemId: string; alternative: number },
		who: Requester = { editor: true, agent: 'editor' },
	) {
		// The reviewer's own actions: reopening a decision, a note, the alternative to apply. An agent proposes and may
		// withdraw (reject, delete) its items; it never overrides the user's decisions, notes or choices.
		if (!who.editor && decision.kind !== 'reject')
			throw new HttpError(
				403,
				'APPROVAL_REQUIRED',
				decision.kind === 'reopen'
					? 'Only the user reopens items in the editor; propose again instead'
					: decision.kind === 'note'
						? 'Notes are the reviewer’s: agents read them (get_proposal, wait_for_proposal)'
						: 'The reviewer chooses the alternative in the editor; agents read the choice',
				{ code: 'E_APPROVAL_REQUIRED' },
			);
		await this.ensureProject(projectId);
		return this.locks.run(`${projectId}/${proposalId}`, async () => {
			const p = await this.load(projectId, proposalId);
			const now = this.now().toISOString();
			if (decision.kind === 'reopen') await this.checkReopen(projectId, p, decision.itemIds);
			const r =
				decision.kind === 'reject'
					? rejectItems(p, decision.itemIds, now)
					: decision.kind === 'reopen'
						? reopenItems(p, decision.itemIds, now)
						: decision.kind === 'note'
							? setItemNote(p, decision.itemId, decision.note, now)
							: selectAlternative(p, decision.itemId, decision.alternative, now);
			if (!r.ok) {
				const e = r.errors[0]!;
				throw new HttpError(
					e.code === 'E_NOT_FOUND' ? 404 : 400,
					e.code === 'E_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_FAILED',
					e.message,
					issuesDetail(e.code, r.errors),
				);
			}
			let next = r.proposal;
			let changedIds = r.changed;
			if (decision.kind === 'reject' && r.changed.length) {
				const settled = settleSetupItems(next, now);
				if (settled.changed.length) {
					next = settled.proposal;
					changedIds = [...r.changed, ...settled.changed];
				}
			}
			if (decision.kind === 'select' && r.changed.length) {
				// The chosen command set must apply to the document now (with what the item requires); its anchors are
				// where things are now. A working alternative also revives an item whose own set was invalid.
				const { doc, revision } = await this.liveDocument(projectId);
				const chosen: Proposal = {
					...next,
					items: next.items.map((i) => {
						if (i.id !== decision.itemId) return i;
						const { reason: _r, ...rest } = i;
						return {
							...rest,
							state: i.state === 'invalid' ? ('pending' as const) : i.state,
							anchors: itemAnchors(doc, selectedCommands(i), i.meta),
						};
					}),
				};
				const plan = planAccept(doc, chosen, [decision.itemId], VALIDATION_ORIGIN, this.ctx(revision));
				if (!plan.ok)
					throw new HttpError(
						400,
						'VALIDATION_FAILED',
						`Alternative ${decision.alternative} of item ${decision.itemId} does not apply now: ${plan.errors[0]?.message ?? 'its commands fail'}`,
						issuesDetail(plan.errors[0]?.code ?? 'E_INVALID_PARAM', plan.errors),
					);
				next = plan.proposal;
			}
			if (r.changed.length === 0 && next === p) return { proposal: p, changed: [] };
			await this.store.put(projectId, next);
			const change =
				decision.kind === 'reject'
					? 'rejected'
					: decision.kind === 'reopen'
						? 'reopened'
						: decision.kind === 'note'
							? 'noted'
							: 'selected';
			this.publish(projectId, next, change, { itemIds: changedIds });
			return { proposal: next, changed: changedIds };
		});
	}

	/**
	 * Reopening an accepted item puts it back into review: only right after its accept was undone in the editor's
	 * History (the session does it), never while the document still has what it applied (accepting it again would apply
	 * it twice).
	 */
	private async checkReopen(projectId: string, p: Proposal, itemIds: string[] | 'all') {
		const ids = itemIds === 'all' ? null : new Set(itemIds);
		const accepted = p.items.filter((it) => it.state === 'accepted' && (!ids || ids.has(it.id)));
		if (accepted.length === 0) return;
		const { doc } = await this.liveDocument(projectId);
		const refused = reopenRefusals(
			doc,
			p,
			accepted.map((it) => it.id),
		);
		if (refused.length)
			throw new HttpError(
				409,
				'PROPOSAL_STILL_APPLIED',
				refused[0]!.message,
				issuesDetail('E_STILL_APPLIED', refused),
			);
	}

	/**
	 * The editor's Redo of an accept the user had undone (and the session reopened): the document has the items again,
	 * so they are recorded as accepted with the revision after the redo and the refs the original accept defined.
	 * Nothing is applied here. Editor only: an agent could otherwise hide items from review without applying them.
	 */
	async markApplied(
		projectId: string,
		proposalId: string,
		req: { itemIds: string[]; revision: number; refs: Record<string, string>; created?: string[] },
		who: Requester,
	) {
		if (!who.editor)
			throw new HttpError(
				403,
				'APPROVAL_REQUIRED',
				'Only the editor window records a redone accept; agents accept with accept_proposal',
				{ code: 'E_APPROVAL_REQUIRED' },
			);
		await this.ensureProject(projectId);
		return this.locks.run(`${projectId}/${proposalId}`, async () => {
			const p = await this.load(projectId, proposalId);
			const known = new Set(p.items.map((it) => it.id));
			const unknown = req.itemIds.filter((id) => !known.has(id));
			if (unknown.length)
				throw new HttpError(404, 'NOT_FOUND', `No item ${unknown[0]} in the proposal`, {
					code: 'E_NOT_FOUND',
					errors: unknown
						.slice(0, 50)
						.map((id) => ({ code: 'E_NOT_FOUND', message: `No item ${id}`, itemId: id })),
				});
			const badRef = Object.entries(req.refs).find(([, v]) => !looksLikeId(v));
			if (badRef)
				throw new HttpError(400, 'VALIDATION_FAILED', `Ref ${badRef[0]} does not name an entity id`, {
					code: 'E_INVALID_PARAM',
				});
			const ids = req.itemIds.filter((id) => p.items.find((it) => it.id === id)?.state !== 'accepted');
			if (ids.length === 0) return { proposal: p, changed: [] };
			if (req.created?.length) {
				// the redo must have put back what the accept created (else a later undo raced it: nothing to record)
				const { doc } = await this.liveDocument(projectId);
				if (!req.created.some((id) => anchorFingerprint(doc, id) !== null))
					throw new HttpError(
						409,
						'PROPOSAL_NOT_APPLIED',
						`The document does not have what the accept created (${req.created[0]}): nothing was recorded`,
						{ code: 'E_NOT_APPLIED' },
					);
			}
			const at = this.now().toISOString();
			const next = markAccepted(p, ids, {
				revision: req.revision,
				refs: req.refs,
				at,
				...(req.created ? { created: req.created } : {}),
			});
			await this.store.put(projectId, next);
			this.publish(projectId, next, 'accepted', { itemIds: ids, revision: req.revision });
			return { proposal: next, changed: ids };
		});
	}

	/**
	 * Stores a Sound Check of the proposal on it (`report.check`, spec 12 §4 P6-E5): the Review panel and `get_proposal`
	 * show it. Not a decision: `updatedAt` stays (an agent waiting for the review is not woken, expiry is unchanged);
	 * announced as `checked`. Resolves the stored proposal (404 when it is gone).
	 */
	async setCheck(projectId: string, proposalId: string, check: Record<string, unknown>): Promise<Proposal> {
		await this.ensureProject(projectId);
		return this.locks.run(`${projectId}/${proposalId}`, async () => {
			const p = await this.load(projectId, proposalId);
			const report =
				p.report && typeof p.report === 'object' && !Array.isArray(p.report)
					? { ...(p.report as Record<string, unknown>), check }
					: { check };
			const next: Proposal = { ...p, report };
			await this.store.put(projectId, next);
			this.publish(projectId, next, 'checked');
			return next;
		});
	}

	/**
	 * "Refresh proposal" (spec 15 EA-003): the feature's producer re-plans items on the live document — `'stale'` =
	 * the items stale after re-validation — and the replacements come back pending (validated by dry runs, fresh
	 * anchors). Nothing is applied: the reviewer (or an allowed agent) accepts them like any item. The editor and the
	 * proposal's agent may ask; accepted and rejected items are never replaced.
	 */
	async refresh(
		projectId: string,
		proposalId: string,
		req: { itemIds: string[] | 'stale' },
		_who: Requester,
	) {
		await this.ensureProject(projectId);
		return this.locks.run(`${projectId}/${proposalId}`, async () => {
			const p0 = await this.load(projectId, proposalId);
			const refresher = this.refreshers.get(p0.feature);
			if (!refresher)
				throw new HttpError(
					409,
					'PROPOSAL_NOT_REFRESHABLE',
					`The producer of "${p0.feature}" proposals does not re-plan items: make a new proposal instead`,
					{ code: 'E_NOT_REFRESHABLE', feature: p0.feature },
				);
			const { doc, revision } = await this.liveDocument(projectId);
			const rv = revalidate(doc, p0, this.ctx(revision));
			const p = rv.proposal;
			const byId = new Map(p.items.map((it) => [it.id, it]));
			let ids: string[];
			if (req.itemIds === 'stale') ids = p.items.filter((it) => it.state === 'stale').map((it) => it.id);
			else {
				const unknown = req.itemIds.filter((id) => !byId.has(id));
				if (unknown.length)
					throw new HttpError(404, 'NOT_FOUND', `No item ${unknown[0]} in the proposal`, {
						code: 'E_NOT_FOUND',
					});
				const decided = req.itemIds.filter((id) => !REFRESHABLE_STATES.includes(byId.get(id)!.state));
				if (decided.length)
					throw new HttpError(
						400,
						'VALIDATION_FAILED',
						`Item ${decided[0]} is ${byId.get(decided[0]!)!.state}: only pending, stale or invalid items are refreshed`,
						{ code: 'E_INVALID_PARAM' },
					);
				ids = [...new Set(req.itemIds)];
			}
			const save = async (next: Proposal, change: ProposalChangedEvent['change'], itemIds: string[]) => {
				if (next === p0) return p0;
				const stamped = { ...next, updatedAt: this.now().toISOString() };
				await this.store.put(projectId, stamped);
				this.publish(projectId, stamped, change, { itemIds });
				return stamped;
			};
			if (ids.length === 0) {
				const kept = await save(
					p,
					'revalidated',
					rv.stale.map((x) => x.itemId),
				);
				return { proposal: kept, refreshed: [], dropped: [], unchanged: [], stale: rv.stale, revision };
			}
			let planned: Awaited<ReturnType<ProposalRefresher>>;
			try {
				planned = await refresher({ projectId, proposal: p, itemIds: ids, doc, revision });
			} catch (e) {
				if (e instanceof HttpError) throw e;
				throw new HttpError(
					422,
					'VALIDATION_FAILED',
					`The producer could not re-plan the items: ${(e as Error).message}`,
					{ code: 'E_REFRESH_FAILED' },
				);
			}
			const r = refreshProposalItems(doc, p, ids, planned, this.ctx(revision), this.now().toISOString());
			if (!r.ok) {
				const first = r.errors[0];
				if (first?.code === 'E_TOO_LARGE')
					throw new HttpError(413, 'PROPOSAL_TOO_LARGE', first.message, {
						code: 'E_TOO_LARGE',
						...(first.detail ?? {}),
					});
				throw new HttpError(
					422,
					'VALIDATION_FAILED',
					`The producer's re-plan is malformed: ${first?.message ?? 'invalid'}`,
					issuesDetail(first?.code ?? 'E_SCHEMA', r.errors),
				);
			}
			// the rest of the proposal on the same document (items requiring a refreshed one may hold again)
			const after = revalidate(
				doc,
				settleSetupItems(r.proposal, this.now().toISOString()).proposal,
				this.ctx(revision),
			);
			const out = await save(after.proposal, 'refreshed', [...r.refreshed, ...r.dropped]);
			return {
				proposal: out,
				refreshed: r.refreshed,
				dropped: r.dropped,
				unchanged: r.unchanged,
				stale: after.stale,
				revision,
			};
		});
	}

	async delete(projectId: string, proposalId: string) {
		await this.ensureProject(projectId);
		return this.locks.run(`${projectId}/${proposalId}`, async () => {
			const p = await this.store.get(projectId, proposalId);
			if (!p || !(await this.store.delete(projectId, proposalId))) throw proposalNotFound(proposalId);
			this.publish(projectId, null, 'deleted', { feature: p.feature, sequenceId: p.sequenceId }, proposalId);
			return { proposalId, deleted: true as const };
		});
	}
}

function safePolicy(policy: ProposalPolicy, doc: ProjectDocument, p: Proposal): PolicyDecision {
	try {
		return policy(doc, p);
	} catch (e) {
		return { allowed: false, reason: `The accept policy failed: ${(e as Error).message}` };
	}
}

/** A failed accept transaction as an HTTP error: approvals keep their codes; anything else is TRANSACTION_REJECTED. */
function txError(result: Extract<TransactionResult, { ok: false }>): HttpError {
	const e = result.errors[0];
	const code = e?.code ?? 'E_INTERNAL';
	const detail = { code, errors: result.errors.slice(0, 50) };
	if (code === 'E_APPROVAL_DENIED') return new HttpError(403, 'APPROVAL_DENIED', e!.message, detail);
	if (code === 'E_APPROVAL_TIMEOUT') return new HttpError(403, 'APPROVAL_TIMEOUT', e!.message, detail);
	if (code === 'E_NO_SESSION') return new HttpError(409, 'NO_SESSION', e!.message, detail);
	if (code === 'E_REVISION_MISMATCH') return new HttpError(409, 'REVISION_CONFLICT', e!.message, detail);
	return new HttpError(409, 'TRANSACTION_REJECTED', `Nothing was applied: ${e?.message ?? code}`, detail);
}
