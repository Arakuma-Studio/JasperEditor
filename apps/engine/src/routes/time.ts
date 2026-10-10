// Workstream `time` (docs/wp-notes/time.md):
//   POST /api/scenes/detect   SceneDetectRequest → 202 EngineJob kind `scene-detect` (`?wait=1` → the finished job;
//                             result SceneDetectResult)
// and the `retime` native extension (reverse, time remaps, Frame Blending / Optical Flow, VFR media on the native
// export path).
import { join } from 'node:path';
import { SceneDetectRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { createRetimeExtension } from '../export/retime/extension.ts';
import { SceneService } from '../time/scenes.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
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

	const scenes = new SceneService(core, cacheDir);
	scenes.registerRunner();
	app.jasper.services.scenes = scenes;

	app.post<Wait>(
		'/api/scenes/detect',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(SceneDetectRequestSchema, req.body);
			const job = await scenes.submit(body);
			if (req.query.wait !== '1') return reply.code(202).send(job);
			const done = await core.queue.wait(job.id);
			if (done.state !== 'succeeded')
				throw new HttpError(
					422,
					done.error?.code ?? 'SCENE_DETECT_FAILED',
					done.error?.message ?? done.state,
					{
						jobId: done.id,
					},
				);
			return done;
		}),
	);
}
