import { CamTrackSolveRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { CamTrackService } from '../camtrack/service.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { registerAssetProber } from '../media/probe.ts';
import { hdrProber } from '../three-d/hdr-prober.ts';
import { modelProber } from '../three-d/model-prober.ts';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type Wait = { Querystring: { wait?: string } };

export default async function camtrackRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new CamTrackService(core);
	app.jasper.services.camtrack = svc;
	svc.registerRunners();
	const unregisterProber = registerAssetProber(modelProber);
	const unregisterHdr = registerAssetProber(hdrProber);
	app.addHook('onClose', async () => {
		unregisterProber();
		unregisterHdr();
	});

	app.post<Wait>(
		'/api/camtrack/solve',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(CamTrackSolveRequestSchema, req.body);
			const job = await svc.submit(body);
			return replyWithJob(core.queue, job, req.query.wait, reply, 'CAMTRACK_FAILED');
		}),
	);
}
