// GET /api/capabilities (ARCHITECTURE §9.2, S04:RT-002). `render.fframes` comes from WP-2G through
// `registerCapabilityProvider`.
import type { FastifyInstance } from 'fastify';
import { coreServices } from '../tools/services.ts';

export default async function capabilitiesRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	app.get('/api/capabilities', async () => core.capabilities.get());
}
