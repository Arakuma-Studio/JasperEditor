// NDJSON /events routes (ARCHITECTURE §9.2). Owner: WP-2F. WP-00 stub answering 501 until WP-2F implements it.
import type { FastifyInstance } from 'fastify';
import { registerStubRoutes } from './stub.ts';

export default async function eventsRoutes(app: FastifyInstance): Promise<void> {
	registerStubRoutes(app, ['events']);
}
