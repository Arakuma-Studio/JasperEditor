// Proposal service (spec 12 §2.5, P3-R2): creates proposals validated against the project's live document, accepts
// items as ONE transaction through the agent service (live into the open editor, or headless), records decisions,
// and publishes `proposal.changed`. The accept policy gate: a request without the editor key (an agent) may accept
// only where the feature allows it (sound design: the sequence's `soundDesign.settings.agentsMayApply`); other
// features default to refusing. Destructive commands inside the accepted items still need the user's approval
// card when an agent accepts (the transaction goes through the usual classification).
import { randomBytes } from 'node:crypto';
import type { ProposalChangedEvent, ProposalCountsJson } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	type Author,
	CROCKFORD_ALPHABET,
	createProposal,
	defaultRegistries,
	itemAnchors,
	looksLikeId,
	markAccepted,
	type Origin,
	type ProjectDocument,
	type Proposal,
	type ProposalContext,
	type ProposalIssue,
	planAccept,
	proposalCounts,
	type Registries,
	rejectItems,
	reopenItems,
	revalidate,
	SOUND_DESIGN_FEATURE,
	selectAlternative,
	selectedCommands,
	setItemNote,
	soundDesignSettingsOf,
	type TransactionResult,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import { HttpError } from '../tools/reply.ts';
import { type ProposalStore, proposalNotFound } from './store.ts';

/** Who asks: the editor window (editor key) or anything else (an agent), with the agent's display name. */
export type Requester = { editor: boolean; agent: string };

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };
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

const ID_BYTES = 10;
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
		},
	) {
		this.store = opts.store;
		this.registries = opts.registries ?? defaultRegistries(mgRegistry);
		this.now = opts.now ?? (() => new Date());
	}

	/** Lets a feature allow agent accepts under its own rule (default: refused). */
	registerPolicy(feature: string, policy: ProposalPolicy): () => void {
		this.policies.set(feature, policy);
		return () => {
			if (this.policies.get(feature) === policy) this.policies.delete(feature);
		};
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

	private async load(projectId: string, proposalId: string): Promise<Proposal> {
		const p = await this.store.get(projectId, proposalId);
		if (!p) throw proposalNotFound(proposalId);
		return p;
	}

	async list(projectId: string) {
		await this.ensureProject(projectId);
		return this.store.list(projectId);
	}

	async get(projectId: string, proposalId: string, opts: { revalidate?: boolean } = {}) {
		await this.ensureProject(projectId);
		if (!opts.revalidate) return { proposal: await this.load(projectId, proposalId), revision: null };
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
		if (!r.ok)
			throw new HttpError(
				400,
				'VALIDATION_FAILED',
				`The proposal is malformed: ${r.errors[0]?.message ?? 'invalid'}`,
				issuesDetail(r.errors[0]?.code ?? 'E_SCHEMA', r.errors),
			);
		const { evicted } = await this.store.create(projectId, r.proposal);
		for (const id of evicted) this.publish(projectId, null, 'evicted', {}, id);
		this.publish(projectId, r.proposal, 'created');
		return { proposal: r.proposal, revision, evicted };
	}

	async accept(
		projectId: string,
		proposalId: string,
		req: { itemIds: string[] | 'all'; partial?: boolean; expectedRevision?: number },
		who: Requester,
	) {
		await this.ensureProject(projectId);
		return this.locks.run(`${projectId}/${proposalId}`, async () => {
			const p0 = await this.load(projectId, proposalId);
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
			const out = await this.agent().transact(projectId, composed.tx, {
				fallbackAgent: who.agent,
				...(who.editor ? { preApproved: true, asUser: true } : {}),
			});
			const result = out.result as TransactionResult;
			if (!result.ok) {
				await save(p, 'revalidated', { itemIds: plan.stale.map((s) => s.itemId) });
				throw txError(result);
			}
			const at = this.now().toISOString();
			const accepted = markAccepted(p, composed.itemIds, {
				revision: result.revision,
				refs: result.refs,
				at,
			});
			await this.store.put(projectId, accepted);
			p = accepted;
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
	) {
		await this.ensureProject(projectId);
		return this.locks.run(`${projectId}/${proposalId}`, async () => {
			const p = await this.load(projectId, proposalId);
			const now = this.now().toISOString();
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
							anchors: itemAnchors(doc, selectedCommands(i)),
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
			this.publish(projectId, next, change, { itemIds: r.changed });
			return { proposal: next, changed: r.changed };
		});
	}

	/**
	 * The editor's Redo of an accept the user had undone (and the session reopened): the document has the items again,
	 * so they are recorded as accepted with the revision after the redo and the refs the original accept defined.
	 * Nothing is applied here. Editor only: an agent could otherwise hide items from review without applying them.
	 */
	async markApplied(
		projectId: string,
		proposalId: string,
		req: { itemIds: string[]; revision: number; refs: Record<string, string> },
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
			const at = this.now().toISOString();
			const next = markAccepted(p, ids, { revision: req.revision, refs: req.refs, at });
			await this.store.put(projectId, next);
			this.publish(projectId, next, 'accepted', { itemIds: ids, revision: req.revision });
			return { proposal: next, changed: ids };
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
