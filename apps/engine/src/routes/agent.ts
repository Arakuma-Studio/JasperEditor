// Agent API and WS relay routes (ARCHITECTURE §9.2, §11). Owner: WP-2H.
//   GET  /api/agent/schema  → commands + queries JSON Schemas, registries, presets, error codes
//   POST /api/agent/query   {projectId, query, args}   → {result, revision?, via}
//   POST /api/agent/tx      {projectId, transaction}   → {result: TransactionResult, appliedBy}
//   POST /api/agent/open-project {projectId}           → editor windows open the project (wp-mcp)
//   POST /api/agent/ui      {projectId?, action, args} → an editor window's answer (mcp-cli live UI)
//   GET  /api/agent/mcp-info                            → where the MCP server is (never the token; wp-mcp)
//   WS   /agent             editor sessions (hello / request / response / event)
import fastifyWebsocket from '@fastify/websocket';
import {
	type AgentMcpInfo,
	AgentOpenProjectRequestSchema,
	type AgentOpenProjectResponse,
	AgentQueryRequestSchema,
	AgentUiRequestSchema,
	EDITOR_OPEN_PROJECT_EVENT,
	errorBody,
} from '@jasper/api';
import { AGENT_TX_LIMITS } from '@jasper/project';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AgentApiError, createAgentService } from '../agent/index.ts';
import { findMcpEntry } from '../agent/mcp-entry.ts';

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

	// mcp-cli: live-UI automation of an open editor window (relayed over WS /agent).
	app.post('/api/agent/ui', async (req, reply) => {
		const body = AgentUiRequestSchema.safeParse(req.body);
		if (!body.success)
			return reply.code(400).send(errorBody('VALIDATION_FAILED', 'Invalid UI request', body.error.issues));
		try {
			return await service.ui(body.data);
		} catch (e) {
			return sendApiError(reply, e);
		}
	});

	// jasper-mcp `open_project_in_editor`: every editor window listening on /events navigates to the project.
	app.post('/api/agent/open-project', async (req, reply) => {
		const body = AgentOpenProjectRequestSchema.safeParse(req.body);
		if (!body.success)
			return reply.code(400).send(errorBody('VALIDATION_FAILED', 'Invalid request', body.error.issues));
		const { projectId } = body.data;
		if (!(await service.projectExists(projectId)))
			return reply.code(404).send(errorBody('PROJECT_NOT_FOUND', `Project not found: ${projectId}`));
		const { broadcaster, events } = app.jasper.services as {
			broadcaster?: { subscriberCount?: number };
			events?: { publish?(type: string, payload: unknown, projectId?: string): unknown };
		};
		const editors = broadcaster?.subscriberCount ?? 0;
		events?.publish?.(EDITOR_OPEN_PROJECT_EVENT, { projectId });
		const out: AgentOpenProjectResponse = {
			projectId,
			path: `/project/${encodeURIComponent(projectId)}`,
			editors,
			live: service.isLive(projectId),
		};
		return out;
	});

	// Help ▸ Connect an AI Agent…: config snippets need the path of the stdio server and the HTTP endpoint.
	app.get('/api/agent/mcp-info', async () => {
		const { config } = app.jasper;
		const out: AgentMcpInfo = {
			stdioEntry: findMcpEntry(),
			httpUrl: `http://${config.host}:${config.port}/mcp`,
			tokenRequired: config.token !== null,
		};
		return out;
	});

	app.get('/agent', { websocket: true }, (socket) => {
		service.handleSocket(socket);
	});
}
