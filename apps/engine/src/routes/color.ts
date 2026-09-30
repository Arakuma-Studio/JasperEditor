// Colour grading on the engine (M2, S06, ARCHITECTURE §19.2/§19.6). Owner: wp-m2-color.
// No HTTP routes of its own (LUTs are media: `.cube` files register as kind `lut`). This plugin is where the
// work package registers, at start-up:
//   - the `.cube` asset prober (media/probe.ts `registerAssetProber`),
//   - the colour native extension (`core.registerNativeExtension`: fused colour runs → baked `lut3d`),
//   - the `features.color` capability block (`core.registerCapabilityProvider`).
import type { FastifyInstance } from 'fastify';

export default async function colorRoutes(_app: FastifyInstance): Promise<void> {
	// wp-m2-color
}
