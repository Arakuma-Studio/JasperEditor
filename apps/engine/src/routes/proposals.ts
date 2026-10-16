// Proposal routes (spec 12 §2.5, §2.8; P3-R2), under `/api/projects/:projectId/proposals`:
//   GET    …                         summaries (expired ones are deleted, unreadable files moved aside with a warning)
//   POST   …                         create from a draft, validated by dry runs against the live document
//   GET    …/:proposalId[?revalidate=1]
//   POST   …/:proposalId/accept      ONE transaction, live into the open editor or headless; policy-gated for agents
//   POST   …/:proposalId/reject | reopen | note | select
//   POST   …/:proposalId/applied     editor only: a Redo in the editor re-applied an undone accept (records it)
//   DELETE …/:proposalId
// Every change publishes `proposal.changed`. An agent reading a proposal again and again without revalidating (MCP
// `wait_for_proposal`) is "waiting for the review": announced as `proposal.changed` `waiting` and listed as `waiting`.
import {
	ProposalAcceptRequestSchema,
	type ProposalAcceptResponse,
	ProposalCreateRequestSchema,
	type ProposalCreateResponse,
	type ProposalDecisionResponse,
	type ProposalDeleteResponse,
	ProposalGetQuerySchema,
	type ProposalListResponse,
	ProposalMarkAppliedRequestSchema,
	ProposalNoteRequestSchema,
	ProposalRejectRequestSchema,
	ProposalReopenRequestSchema,
	type ProposalResponse,
	ProposalSelectRequestSchema,
	type ProposalSummary,
} from '@jasper/api';
import { PROPOSAL_ID_RE, type Proposal, proposalCounts, proposalDecided } from '@jasper/project';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { agentNameOf } from '../agent/user-approval.ts';
import { isProjectId } from '../projects/store.ts';
import { ProposalService } from '../proposals/service.ts';
import { ProposalStore, proposalNotFound } from '../proposals/store.ts';
import { ProposalWaitWatch } from '../proposals/waiting.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';

type P = { Params: { projectId: string } };
type PP = { Params: { projectId: string; proposalId: string } };

function projectIdOf(req: FastifyRequest<P>): string {
	const id = req.params.projectId;
	if (!isProjectId(id)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
	return id;
}
function ids(req: FastifyRequest<PP>): { projectId: string; proposalId: string } {
	const projectId = projectIdOf(req as unknown as FastifyRequest<P>);
	const proposalId = req.params.proposalId;
	if (!PROPOSAL_ID_RE.test(proposalId)) throw proposalNotFound(String(proposalId).slice(0, 64));
	return { projectId, proposalId };
}
const requester = (req: FastifyRequest) => ({ editor: req.jasperEditor === true, agent: agentNameOf(req) });

export default async function proposalRoutes(app: FastifyInstance): Promise<void> {
	const { services, config } = app.jasper;
	let service: ProposalService | null = null;
	const store = new ProposalStore({
		paths: config.paths,
		log: (m) => app.log.warn(m),
		onRemoved: (projectId, p, why) =>
			service?.publish(projectId, null, why, { feature: p.feature, sequenceId: p.sequenceId }, p.id),
	});
	service = new ProposalService({
		agent: () => services.agent as AgentService | undefined,
		store,
		// Looked up per event: the bus is the engine's (tests may swap it).
		publish: (type, payload, projectId) =>
			(services.events as { publish(type: string, payload: unknown, projectId?: string): void }).publish(
				type,
				payload,
				projectId,
			),
	});
	services.proposals = service;
	const svc = service;
	const expiresAt = (p: Proposal) => store.expiresAt(p);
	const waits = new ProposalWaitWatch({
		publish: (projectId, proposalId, waiting) =>
			svc.publish(projectId, null, 'waiting', { waiting }, proposalId),
	});
	app.addHook('onClose', async () => waits.dispose());

	app.get<P>(
		'/api/projects/:projectId/proposals',
		guarded<P>(async (req) => {
			const { proposals, warnings } = await svc.list(projectIdOf(req));
			const out: ProposalListResponse = {
				proposals: proposals.map(
					(p): ProposalSummary => ({
						id: p.id,
						projectId: p.projectId,
						sequenceId: p.sequenceId,
						feature: p.feature,
						title: p.title,
						summary: p.summary,
						author: p.author,
						createdAt: p.createdAt,
						updatedAt: p.updatedAt,
						expiresAt: expiresAt(p),
						baseRevision: p.baseRevision,
						itemCount: p.items.length,
						counts: proposalCounts(p),
						decided: proposalDecided(p),
						waiting: waits.waiting(p.projectId, p.id),
					}),
				),
				warnings,
			};
			return out;
		}),
	);

	app.post<P>(
		'/api/projects/:projectId/proposals',
		guarded<P>(async (req) => {
			const projectId = projectIdOf(req);
			// Shape first (strict); the model validates again and dry-runs every item.
			parseOr400(ProposalCreateRequestSchema, req.body ?? {});
			const r = await svc.create(projectId, req.body as Record<string, unknown>, requester(req));
			const out: ProposalCreateResponse = { ...r, expiresAt: expiresAt(r.proposal) };
			return out;
		}),
	);

	app.get<PP>(
		'/api/projects/:projectId/proposals/:proposalId',
		guarded<PP>(async (req) => {
			const { projectId, proposalId } = ids(req);
			const q = parseOr400(ProposalGetQuerySchema, req.query ?? {});
			const revalidate = q.revalidate === '1' || q.revalidate === 'true';
			const r = await svc.get(projectId, proposalId, { revalidate });
			// a plain read by an agent: one poll of a wait for the user's review
			if (!revalidate && req.jasperEditor !== true) waits.poll(projectId, proposalId, agentNameOf(req));
			const out: ProposalResponse = { ...r, expiresAt: expiresAt(r.proposal) };
			return out;
		}),
	);

	app.post<PP>(
		'/api/projects/:projectId/proposals/:proposalId/accept',
		guarded<PP>(async (req) => {
			const { projectId, proposalId } = ids(req);
			const body = parseOr400(ProposalAcceptRequestSchema, req.body ?? {});
			const out: ProposalAcceptResponse = await svc.accept(projectId, proposalId, body, requester(req));
			return out;
		}),
	);

	const decision = (path: string, build: (body: unknown) => Parameters<ProposalService['decide']>[2]) =>
		app.post<PP>(
			`/api/projects/:projectId/proposals/:proposalId/${path}`,
			guarded<PP>(async (req) => {
				const { projectId, proposalId } = ids(req);
				const out: ProposalDecisionResponse = await svc.decide(projectId, proposalId, build(req.body ?? {}));
				return out;
			}),
		);
	decision('reject', (b) => ({
		kind: 'reject',
		itemIds: parseOr400(ProposalRejectRequestSchema, b).itemIds,
	}));
	decision('reopen', (b) => ({
		kind: 'reopen',
		itemIds: parseOr400(ProposalReopenRequestSchema, b).itemIds,
	}));
	decision('note', (b) => {
		const r = parseOr400(ProposalNoteRequestSchema, b);
		return { kind: 'note', itemId: r.itemId, note: r.note };
	});
	decision('select', (b) => {
		const r = parseOr400(ProposalSelectRequestSchema, b);
		return { kind: 'select', itemId: r.itemId, alternative: r.alternative };
	});

	app.post<PP>(
		'/api/projects/:projectId/proposals/:proposalId/applied',
		guarded<PP>(async (req) => {
			const { projectId, proposalId } = ids(req);
			const body = parseOr400(ProposalMarkAppliedRequestSchema, req.body ?? {});
			const out: ProposalDecisionResponse = await svc.markApplied(
				projectId,
				proposalId,
				body,
				requester(req),
			);
			return out;
		}),
	);

	app.delete<PP>(
		'/api/projects/:projectId/proposals/:proposalId',
		guarded<PP>(async (req) => {
			const { projectId, proposalId } = ids(req);
			const out: ProposalDeleteResponse = await svc.delete(projectId, proposalId);
			waits.forget(projectId, proposalId);
			return out;
		}),
	);
}
