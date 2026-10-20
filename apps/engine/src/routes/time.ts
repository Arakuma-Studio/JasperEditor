import { join } from 'node:path';
import { SceneDetectRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { createRetimeExtension } from '../export/retime/extension.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { SceneService } from '../time/scenes.ts';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type Wait = { Querystring: { wait?: string } };

export default async function timeRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const cacheDir = join(app.jasper.config.paths.cacheDir, 'retime');
	const unregister = core.registerNativeExtension(
		createRetimeExtension({
			ffmpeg: core.ffmpeg,
			cacheDir,
			getExtensions: () => core.exports.nativeExtensions.all(),
			log: (msg) => app.log.debug(msg),
		}),
	);
	app.addHook('onClose', async () => unregister());

	// Finished detections are kept for Sound Design's scene cue source (sounds/analysis/scenes).
	const scenes = new SceneService(
		core,
		cacheDir,
		join(app.jasper.config.paths.soundsDir, 'analysis', 'scenes'),
	);
	scenes.registerRunner();
	app.jasper.services.scenes = scenes;

	app.post<Wait>(
		'/api/scenes/detect',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(SceneDetectRequestSchema, req.body);
			const job = await scenes.submit(body);
			return replyWithJob(core.queue, job, req.query.wait, reply, 'SCENE_DETECT_FAILED');
		}),
	);
}
