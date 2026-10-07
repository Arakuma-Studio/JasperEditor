// Workstream `time` (docs/wp-notes/time.md): the `retime` native extension (reverse, time remaps, Frame Blending /
// Optical Flow, VFR media on the native export path).
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRetimeExtension } from '../export/retime/extension.ts';
import { coreServices } from '../tools/services.ts';

export default async function timeRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const unregister = core.registerNativeExtension(
		createRetimeExtension({
			ffmpeg: core.ffmpeg,
			cacheDir: join(app.jasper.config.paths.cacheDir, 'retime'),
			getExtensions: () => core.exports.nativeExtensions.all(),
			log: (msg) => app.log.debug(msg),
		}),
	);
	app.addHook('onClose', async () => unregister());
}
