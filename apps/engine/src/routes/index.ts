// Registers one plugin per area (ARCHITECTURE §9.1). Owners replace their plugin's body; this list only
// changes additively.
import type { FastifyInstance } from 'fastify';
import agentRoutes from './agent.ts';
import capabilitiesRoutes from './capabilities.ts';
import eventsRoutes from './events.ts';
import exportsRoutes from './exports.ts';
import fontsRoutes from './fonts.ts';
import jobsRoutes from './jobs.ts';
import mediaRoutes from './media.ts';
import mgRoutes from './mg.ts';
import projectsRoutes from './projects.ts';
import stillsRoutes from './stills.ts';
import uploadsRoutes from './uploads.ts';

export const ROUTE_PLUGINS = [
	capabilitiesRoutes,
	eventsRoutes,
	projectsRoutes,
	mediaRoutes,
	uploadsRoutes,
	jobsRoutes,
	exportsRoutes,
	stillsRoutes,
	fontsRoutes,
	mgRoutes,
	agentRoutes,
] as const;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
	// Plugins are registered without encapsulation-breaking wrappers so they share app.jasper.
	for (const plugin of ROUTE_PLUGINS) await plugin(app);
}
