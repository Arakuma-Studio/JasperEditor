// Audio sync (wp-multicam; docs/wp-notes/multicam.md).
//   POST /api/sync/audio   SyncAudioRequest → SyncAudioResponse (synchronous: decode + two-pass GCC-PHAT)
// Registers the `features.audioSync` capability block.
import { SyncAudioRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { MAX_ANALYSIS_SECONDS, SyncService } from '../sync/service.ts';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

export default async function syncRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const sync = new SyncService({ ffmpeg: core.ffmpeg, registry: core.registry });
	app.jasper.services.sync = sync;
	core.registerCapabilityProvider(() => ({
		features: {
			audioSync: {
				state: core.ffmpeg.bins.ffmpeg ? 'ready' : 'unavailable',
				method: 'gcc-phat-2pass',
				maxSeconds: MAX_ANALYSIS_SECONDS,
			},
		},
	}));
	app.post(
		'/api/sync/audio',
		guarded(async (req, reply) => {
			const body = parseOr400(SyncAudioRequestSchema, req.body);
			const ac = new AbortController();
			req.raw.on('close', () => {
				if (!reply.sent) ac.abort();
			});
			return reply.send(await sync.analyse(body, ac.signal));
		}),
	);
}
