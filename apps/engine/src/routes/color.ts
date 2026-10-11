import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createColorExtension } from '../color/extension.ts';
import { ocioBundleProber } from '../color/ocio-bundle.ts';
import { cubeProber } from '../color/prober.ts';
import { registerAssetProber } from '../media/probe.ts';
import { coreServices } from '../tools/services.ts';

export default async function colorRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const unregisterProber = registerAssetProber(cubeProber);
	// color-mgmt: custom OCIO config bundles (`.ocio` imports are bundled by the media service).
	const unregisterOcio = registerAssetProber(ocioBundleProber);
	const unregisterExt = core.registerNativeExtension(
		createColorExtension({
			lutCacheDir: join(core.config.paths.cacheDir, 'luts'),
			log: (m) => app.log.info(m),
		}),
	);
	core.registerCapabilityProvider((base) => ({
		features: {
			color: {
				lut3d: base.media.filters.includes('lut3d'),
				remotionWebgl: core.remotion.webglStatus.state,
			},
		},
	}));
	// Probe WebGL2 in the render browser once the engine is up (it launches Chrome: off the start-up path).
	// `JASPER_REMOTION_GL=off` disables it; `JASPER_WEBGL_PROBE=0` (default under vitest) skips the eager probe
	// (renders still probe on first use).
	const eager = process.env.JASPER_WEBGL_PROBE ?? (process.env.VITEST ? '0' : '1');
	if (eager !== '0') {
		app.addHook('onReady', async () => {
			const t = setTimeout(() => {
				void core.remotion.probeWebgl().then(() => core.capabilities.changed());
			}, 1500);
			t.unref?.();
		});
	}
	app.addHook('onClose', async () => {
		unregisterProber();
		unregisterOcio();
		unregisterExt();
	});
}
