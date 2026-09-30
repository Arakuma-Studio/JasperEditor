// Job list and control (ARCHITECTURE §9.2, S04 §17).
import { JobListQuerySchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type J = { Params: { jobId: string } };

export default async function jobsRoutes(app: FastifyInstance): Promise<void> {
	const { queue } = coreServices(app);
	const get = (id: string) => {
		const j = queue.get(id);
		if (!j) throw new HttpError(404, 'JOB_NOT_FOUND', 'Unknown job');
		return j;
	};

	app.get(
		'/api/jobs',
		guarded(async (req) => {
			const q = parseOr400(JobListQuerySchema, req.query);
			return {
				jobs: queue.list({
					active: q.active === '1',
					...(q.projectId ? { projectId: q.projectId } : {}),
					...(q.since ? { since: q.since } : {}),
				}),
			};
		}),
	);

	app.get<J>(
		'/api/jobs/:jobId',
		guarded<J>(async (req) => get(req.params.jobId)),
	);

	app.post<J>(
		'/api/jobs/:jobId/cancel',
		guarded<J>(async (req) => {
			get(req.params.jobId);
			return queue.cancel(req.params.jobId)!;
		}),
	);

	app.post<J>(
		'/api/jobs/:jobId/retry',
		guarded<J>(async (req) => {
			get(req.params.jobId);
			return queue.retry(req.params.jobId);
		}),
	);
}
