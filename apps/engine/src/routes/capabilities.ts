// Capabilities routes (ARCHITECTURE §9.2). Owner: WP-2F (render.fframes: WP-2G). WP-00 stub answering 501 until WP-2F (render.fframes: WP-2G) implements it.
import type { FastifyInstance } from 'fastify';
import { registerStubRoutes } from './stub.ts';

export default async function capabilitiesRoutes(app: FastifyInstance): Promise<void> {
	registerStubRoutes(app, ['capabilities']);
}
