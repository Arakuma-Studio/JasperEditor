// MCP over Streamable HTTP at /mcp (docs/wp-notes/wp-mcp.md): the same tools, resources and prompts as
// the `jasper-mcp` stdio server (@jasper/mcp), for MCP clients that connect by URL. Each MCP session gets
// its own server instance whose tools call this engine's HTTP API on 127.0.0.1 with the engine token.
// Auth is the engine's: loopback Host check always, `Authorization: Bearer <token>` in token mode.
import { randomUUID } from 'node:crypto';
import { createJasperMcpServer, FixedEngineLink } from '@jasper/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Sessions idle longer than this are closed. */
const MCP_SESSION_IDLE_MS = 30 * 60_000;
const MCP_MAX_SESSIONS = 32;

type Session = {
	transport: StreamableHTTPServerTransport;
	close(): Promise<void>;
	lastSeen: number;
};

function rpcError(reply: FastifyReply, status: number, code: number, message: string) {
	return reply.code(status).send({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export default async function mcpRoutes(app: FastifyInstance): Promise<void> {
	const { config } = app.jasper;
	const sessions = new Map<string, Session>();

	const sweep = setInterval(() => {
		const now = Date.now();
		for (const [id, s] of sessions)
			if (now - s.lastSeen > MCP_SESSION_IDLE_MS) {
				sessions.delete(id);
				void s.close();
			}
	}, 60_000);
	sweep.unref();
	app.addHook('onClose', async () => {
		clearInterval(sweep);
		await Promise.all([...sessions.values()].map((s) => s.close()));
		sessions.clear();
	});

	const lookup = (req: FastifyRequest): { id?: string; session?: Session } => {
		const raw = req.headers['mcp-session-id'];
		const id = Array.isArray(raw) ? raw[0] : raw;
		return { id, session: id ? sessions.get(id) : undefined };
	};

	app.post('/mcp', async (req, reply) => {
		const { id, session } = lookup(req);
		let s = session;
		if (id && !s) return rpcError(reply, 404, -32001, 'Session not found; initialize a new session');
		if (!s) {
			if (!isInitializeRequest(req.body))
				return rpcError(reply, 400, -32000, 'Bad Request: send initialize first (no valid mcp-session-id)');
			if (sessions.size >= MCP_MAX_SESSIONS) {
				// Drop the least recently used session.
				const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
				if (oldest) {
					sessions.delete(oldest[0]);
					void oldest[1].close();
				}
			}
			// The tools talk to this engine over loopback HTTP, authenticated like any other client.
			const link = new FixedEngineLink(`http://127.0.0.1:${config.port}`, config.token);
			const { server } = createJasperMcpServer({ link });
			let created: Session | null = null;
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sid) => {
					if (created) sessions.set(sid, created);
				},
			});
			created = {
				transport,
				lastSeen: Date.now(),
				close: async () => {
					await transport.close().catch(() => {});
					await server.close().catch(() => {});
				},
			};
			transport.onclose = () => {
				if (transport.sessionId) sessions.delete(transport.sessionId);
			};
			await server.connect(transport);
			s = created;
		}
		s.lastSeen = Date.now();
		reply.hijack();
		await s.transport.handleRequest(req.raw, reply.raw, req.body);
	});

	// Server → client stream (GET) and session termination (DELETE) for an existing session.
	const existing = async (req: FastifyRequest, reply: FastifyReply) => {
		const { id, session } = lookup(req);
		if (!id) return rpcError(reply, 400, -32000, 'Bad Request: mcp-session-id header required');
		if (!session) return rpcError(reply, 404, -32001, 'Session not found');
		session.lastSeen = Date.now();
		reply.hijack();
		await session.transport.handleRequest(req.raw, reply.raw);
	};
	app.get('/mcp', existing);
	app.delete('/mcp', existing);
}
