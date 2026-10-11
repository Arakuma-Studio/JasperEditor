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
