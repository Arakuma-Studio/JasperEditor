// anime.js (M2, S11 §3, ARCHITECTURE §20.5). Owner: wp-m2-anime-core.
// No HTTP routes of its own. Registers, at start-up:
//   - the anime.js entry of GET /api/licenses (MIT, `registerLicenseProvider`),
//   - the `features.anime` capability block (anime.js version, text presets, anime templates).
import type { FastifyInstance } from 'fastify';
import { animeCapability, animeLicense } from '../anime/index.ts';
import { registerLicenseProvider } from '../tools/licenses.ts';
import { coreServices } from '../tools/services.ts';

export default async function animeRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const unregisterLicense = registerLicenseProvider(() => [animeLicense()]);
	const anime = animeCapability();
	const unregisterCapability = core.registerCapabilityProvider(() => ({ features: { anime } }));
	app.addHook('onClose', async () => {
		unregisterLicense();
		unregisterCapability();
	});
}
