// Agent API and WS relay routes (ARCHITECTURE §9.2). Owner: WP-2H. WP-00 stub answering 501 until WP-2H implements it.
import type { FastifyInstance } from 'fastify';
import { registerStubRoutes } from './stub.ts';

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
	registerStubRoutes(app, ['agentSchema', 'agentQuery', 'agentTx', 'agentWs']);
}
