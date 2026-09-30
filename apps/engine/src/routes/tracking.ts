// Tracking (M2, S09, ARCHITECTURE §19.5). Owner: wp-m2-track. Stubs answer 501 until implemented.
// Also where the work package registers the `warp` native extension (corner pin / animated Motion).
import type { FastifyInstance } from 'fastify';
import { registerStubRoutes } from './stub.ts';

export default async function trackingRoutes(app: FastifyInstance): Promise<void> {
	registerStubRoutes(app, ['trackingTrack']);
}
