// Project store and leases (ARCHITECTURE §9.2, S01:PER-001/025/040).
import {
	EnvelopeSchema,
	LeaseRequestSchema,
	ProjectCreateRequestSchema,
	ProjectViewSchema,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type P = { Params: { projectId: string } };
type PL = { Params: { projectId: string; leaseId: string } };

function parseIfMatch(h: string | string[] | undefined): number | '*' {
	const v = (Array.isArray(h) ? h[0] : h)?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
	if (v === undefined || v === '')
		throw new HttpError(428, 'BAD_REQUEST', 'If-Match: <baseRevision> is required');
	if (v === '*') return '*';
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0)
		throw new HttpError(400, 'BAD_REQUEST', 'If-Match must be a revision number');
	return n;
}

export default async function projectsRoutes(app: FastifyInstance): Promise<void> {
	const { projects, leases } = coreServices(app);

	app.get(
		'/api/projects',
		guarded(async () => ({ projects: await projects.list() })),
	);

	app.post(
		'/api/projects',
		guarded(async (req, reply) => {
			const body = parseOr400(ProjectCreateRequestSchema, req.body);
			const projectId = await projects.create(body);
			return reply.code(201).send({ projectId });
		}),
	);

	app.get<P>(
		'/api/projects/:projectId',
		guarded<P>(async (req) => projects.get(req.params.projectId)),
	);

	app.put<P>(
		'/api/projects/:projectId',
		guarded<P>(async (req) => {
			const ifMatch = parseIfMatch(req.headers['if-match']);
			const envelope = parseOr400(EnvelopeSchema, req.body);
			return projects.save(req.params.projectId, envelope, ifMatch);
		}),
	);

	app.put<P>(
		'/api/projects/:projectId/view',
		guarded<P>(async (req) => {
			const view = parseOr400(ProjectViewSchema, req.body);
			await projects.saveView(req.params.projectId, view);
			return { ok: true as const };
		}),
	);

	app.get<P>(
		'/api/projects/:projectId/versions',
		guarded<P>(async (req) => ({ versions: await projects.versions(req.params.projectId) })),
	);

	app.delete<P>(
		'/api/projects/:projectId',
		guarded<P>(async (req) => {
			await projects.delete(req.params.projectId);
			return { ok: true as const };
		}),
	);

	app.post<P>(
		'/api/projects/:projectId/lease',
		guarded<P>(async (req) => {
			const { sessionId, takeOver } = parseOr400(LeaseRequestSchema, req.body);
			if ((await projects.revision(req.params.projectId)) === null) {
				throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			}
			return leases.acquire(req.params.projectId, sessionId, { takeOver });
		}),
	);

	app.post<PL>(
		'/api/projects/:projectId/lease/:leaseId/heartbeat',
		guarded<PL>(async (req) => leases.heartbeat(req.params.projectId, req.params.leaseId)),
	);

	app.delete<PL>(
		'/api/projects/:projectId/lease/:leaseId',
		guarded<PL>(async (req) => {
			leases.release(req.params.projectId, req.params.leaseId);
			return { ok: true as const };
		}),
	);
}
