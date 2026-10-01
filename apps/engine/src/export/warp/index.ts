// Warp stage (S09 §5, ARCHITECTURE D-28): registration helper for the tracking route plugin.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { coreServices } from '../../tools/services.ts';
import { createWarpExtension, type WarpDeps, type WarpExtension } from './extension.ts';

export {
	createWarpExtension,
	layerSpan,
	WARP_EXTENSION_ID,
	WARP_VERSION,
	type WarpDeps,
	type WarpExtension,
	type WarpPrepared,
	type WarpStats,
	warpClaims,
	warpFrames,
} from './extension.ts';
export { destRect, type PixelRect, warpFrame } from './kernel.ts';

/**
 * Builds the `warp` extension from the engine's core services (cache `<appdir>/cache/warp`), registers it
 * (`core.registerNativeExtension`) and flags `app.jasper.services.warpStage`. Returns the extension.
 */
export function registerWarpStage(
	app: FastifyInstance,
	opts: Pick<WarpDeps, 'threads' | 'effects'> = {},
): WarpExtension {
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
