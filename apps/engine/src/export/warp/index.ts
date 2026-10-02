// Warp stage (S09 §5, ARCHITECTURE D-28): registration helper for the tracking route plugin.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { coreServices } from '../../tools/services.ts';
import type { NativeExtension } from '../native-ext.ts';
import { createWarpExtension, type WarpDeps } from './extension.ts';

/**
 * Builds the `warp` extension from the engine's core services (cache `<appdir>/cache/warp`), registers it
 * (`core.registerNativeExtension`) and flags `app.jasper.services.warpStage`. Returns the extension.
 */
export function registerWarpStage(
	app: FastifyInstance,
	opts: Pick<WarpDeps, 'threads' | 'effects'> = {},
): NativeExtension {
	const core = coreServices(app);
	const ext = createWarpExtension({
		ffmpeg: core.ffmpeg,
		cacheDir: join(app.jasper.config.paths.cacheDir, 'warp'),
		getExtensions: () => core.exports.nativeExtensions.all(),
		log: (msg) => app.log.debug(msg),
		...opts,
	});
	core.registerNativeExtension(ext);
	app.jasper.services.warpStage = true;
	return ext;
}
