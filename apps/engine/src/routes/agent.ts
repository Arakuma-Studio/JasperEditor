// Agent API and WS relay routes (ARCHITECTURE §9.2, §11). Owner: WP-2H.
//   GET  /api/agent/schema  → commands + queries JSON Schemas, registries, presets, error codes
//   POST /api/agent/query   {projectId, query, args}   → {result, revision?, via}
//   POST /api/agent/tx      {projectId, transaction}   → {result: TransactionResult, appliedBy}
//   WS   /agent             editor sessions (hello / request / response / event)
import fastifyWebsocket from '@fastify/websocket';
import { AgentQueryRequestSchema, errorBody } from '@jasper/api';
import { AGENT_TX_LIMITS } from '@jasper/project';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AgentApiError, createAgentService } from '../agent/index.ts';

const TxBodySchema = z.object({
	projectId: z.string().min(1),
	transaction: z.record(z.string(), z.unknown()),
});

function sendApiError(reply: FastifyReply, e: unknown) {
	if (e instanceof AgentApiError) return reply.code(e.status).send(errorBody(e.code, e.message, e.detail));
	throw e;
}

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
	if (!app.hasDecorator('websocketServer'))
		await app.register(fastifyWebsocket, { options: { maxPayload: AGENT_TX_LIMITS.maxBytes + 1024 * 1024 } });
	const service = createAgentService(app);
	app.addHook('onClose', async () => service.close());

	app.get('/api/agent/schema', async () => service.schema());

	app.post('/api/agent/query', async (req, reply) => {
		const body = AgentQueryRequestSchema.safeParse(req.body);
		if (!body.success)
			return reply.code(400).send(errorBody('VALIDATION_FAILED', 'Invalid agent query', body.error.issues));
		try {
			return await service.query(body.data);
		} catch (e) {
			return sendApiError(reply, e);
		}
	});

	app.post('/api/agent/tx', async (req, reply) => {
		const body = TxBodySchema.safeParse(req.body);
		if (!body.success)
			return reply
				.code(400)
				.send(errorBody('VALIDATION_FAILED', 'Invalid agent transaction request', body.error.issues));
		const length = Number(req.headers['content-length']);
		try {
			return await service.transact(body.data.projectId, body.data.transaction, {
				byteLength: Number.isFinite(length) ? length : undefined,
			});
		} catch (e) {
			return sendApiError(reply, e);
		}
	});

	app.get('/agent', { websocket: true }, (socket) => {
		service.handleSocket(socket);
	});
}
