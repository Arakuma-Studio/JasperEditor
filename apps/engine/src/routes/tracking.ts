// Tracking (M2, S09, ARCHITECTURE §19.5). Owner: wp-m2-track.
//   POST /api/tracking/track   TrackRequest → 202 EngineJob (kind `track`; result = TrackResult)
// Registers the `track` job runner, the `features.tracking` capability block, and (below) the `warp` native
// extension (corner pin / animated Motion).
import { TrackRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { registerWarpStage } from '../export/warp/index.ts';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';
import { TrackingService } from '../tracking/service.ts';

export const TRACKING_SERVICE_KEY = 'tracking';

export default async function trackingRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const tracking = new TrackingService(core);
	app.jasper.services[TRACKING_SERVICE_KEY] = tracking;
	core.queue.registerRunner('track', tracking.runner);
	// `warpStage` is set by the warp stage registration (same work package) once the extension is registered.
	core.registerCapabilityProvider(() => ({
		features: { tracking: tracking.capability(app.jasper.services.warpStage === true) },
	}));
	app.addHook('onClose', async () => tracking.shutdown());

	app.post(
		'/api/tracking/track',
		guarded(async (req, reply) => {
			const body = parseOr400(TrackRequestSchema, req.body);
			return reply.code(202).send(await tracking.submit(body));
		}),
	);

	// The warp stage: corner pins and keyframed Motion / opacity on the native export path (S09:TRK-032, D-28).
	registerWarpStage(app);
}
