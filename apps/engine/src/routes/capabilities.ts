import type { FastifyInstance } from 'fastify';
import { thirdPartyLicenses } from '../tools/licenses.ts';
import { coreServices } from '../tools/services.ts';

export default async function capabilitiesRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	app.get('/api/capabilities', async () => core.capabilities.get());
	app.get('/api/licenses', async () => {
		const caps = await core.capabilities.get();
		return thirdPartyLicenses({
			ffmpegPath: core.ffmpeg.bins.ffmpeg,
			ffmpegVersion: caps.media.ffmpegVersion,
			license: caps.media.encoding?.license ?? 'unknown',
		});
	});
}
