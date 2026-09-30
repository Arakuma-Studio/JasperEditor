// Clip processing (M2, S07, ARCHITECTURE §19.4). Owner: wp-m2-process. Stubs answer 501 until implemented.
import type { FastifyInstance } from 'fastify';
import { registerStubRoutes } from './stub.ts';

export default async function processingRoutes(app: FastifyInstance): Promise<void> {
	registerStubRoutes(app, [
		'mediaProcess',
		'processingModels',
		'processingModelInstall',
		'processingSettingsGet',
		'processingSettingsPut',
		'processingRemoteProbe',
		'processingRemoteSetup',
	]);
}
