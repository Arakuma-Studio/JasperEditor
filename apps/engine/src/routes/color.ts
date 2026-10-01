// Colour grading on the engine (M2, S06, ARCHITECTURE §19.2/§19.6). Owner: wp-m2-color.
// No HTTP routes of its own (LUTs are media: `.cube` files register as kind `lut`). This plugin registers, at
// start-up:
//   - the `.cube` asset prober (media/probe.ts `registerAssetProber`),
//   - the colour native extension (`core.registerNativeExtension`: fused colour runs → baked `lut3d`),
//   - the `features.color` capability block (`core.registerCapabilityProvider`),
//   - the WebGL2 probe of the Remotion render browser (S06:CG-042), started once the server is ready.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createColorExtension } from '../color/extension.ts';
import { cubeProber } from '../color/prober.ts';
import { registerAssetProber } from '../media/probe.ts';
import { coreServices } from '../tools/services.ts';

export default async function colorRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const unregisterProber = registerAssetProber(cubeProber);
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
		unregisterExt();
	});
}
