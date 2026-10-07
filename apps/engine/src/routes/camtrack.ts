// three-d on the engine:
//   POST /api/camtrack/solve   CamTrackSolveRequest → `camtrack` job (`?wait=1` → the finished job)
// Also registers the `camtrack` job runner and the 3D model asset prober (.glb / .gltf / .obj → kind `model`).
import { CamTrackSolveRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { CamTrackService } from '../camtrack/service.ts';
import { registerAssetProber } from '../media/probe.ts';
import { modelProber } from '../three-d/model-prober.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type Wait = { Querystring: { wait?: string } };

export default async function camtrackRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new CamTrackService(core);
	app.jasper.services.camtrack = svc;
	svc.registerRunners();
	const unregisterProber = registerAssetProber(modelProber);
	app.addHook('onClose', async () => unregisterProber());

	app.post<Wait>(
		'/api/camtrack/solve',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(CamTrackSolveRequestSchema, req.body);
			const job = await svc.submit(body);
			if (req.query.wait !== '1') return reply.code(202).send(job);
			const done = await core.queue.wait(job.id);
			if (done.state !== 'succeeded')
				throw new HttpError(422, done.error?.code ?? 'CAMTRACK_FAILED', done.error?.message ?? done.state, {
					jobId: done.id,
				});
			return done;
		}),
	);
}
