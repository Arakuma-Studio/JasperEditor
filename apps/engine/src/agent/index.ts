// Agent API stage 1 (WP-2H): service wiring for the engine (ARCHITECTURE §9.1 `agent/`, §11).
import { TERMINAL_JOB_STATES } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import { defaultRegistries } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { AgentApiError, AgentService, type StillCaptureRequest } from './service.ts';
import type { AgentProjectStore } from './store.ts';

export * from './approvals.ts';
export * from './revisions.ts';
export * from './service.ts';
export * from './sessions.ts';
export * from './store.ts';

/** Polls an engine job through the app's own routes until it finishes. */
async function waitForJob(
	app: FastifyInstance,
	headers: Record<string, string>,
	jobId: string,
	timeoutMs: number,
) {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const r = await app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(jobId)}`, headers });
		if (r.statusCode >= 400) throw fromInject(r.statusCode, r.body);
		const job = r.json() as { state: string; result?: unknown; error?: { code: string; message: string } };
		if (TERMINAL_JOB_STATES.has(job.state as never)) {
			if (job.state !== 'succeeded')
				throw new AgentApiError(
					502,
					job.error?.code ?? 'INTERNAL',
					job.error?.message ?? `Still job ${job.state}`,
				);
			return job.result;
		}
		if (Date.now() > until) throw new AgentApiError(504, 'INTERNAL', 'Timed out waiting for the still');
		await new Promise((r2) => setTimeout(r2, 200));
	}
}

function fromInject(status: number, body: string): AgentApiError {
	try {
		const e = JSON.parse(body) as { code?: string; message?: string };
		return new AgentApiError(status, e.code ?? 'INTERNAL', e.message ?? `HTTP ${status}`);
	} catch {
		return new AgentApiError(status, 'INTERNAL', `HTTP ${status}`);
	}
}

/** Creates the agent service for an engine instance and registers it as `services.agent`. */
export function createAgentService(app: FastifyInstance): AgentService {
	const { config, services } = app.jasper;
	const internalHeaders = (): Record<string, string> => ({
		host: `127.0.0.1:${config.port}`,
		...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
	});
	const service = new AgentService({
		engineVersion: config.version,
		registries: defaultRegistries(mgRegistry),
		store: () => services.agentStore as AgentProjectStore,
		publish: (type, payload, projectId) => {
			const events = services.events as { publish(type: string, payload: unknown, projectId?: string): void };
			events.publish(type, payload, projectId);
		},
		captureStill: async (req: StillCaptureRequest) => {
			const headers = { ...internalHeaders(), 'content-type': 'application/json' };
			const r = await app.inject({
				method: 'POST',
				url: '/api/stills',
				headers,
				payload: JSON.stringify({
					envelope: req.envelope,
					sequenceId: req.sequenceId,
					frame: req.frame,
					width: req.width,
				}),
			});
			if (r.statusCode >= 400) throw fromInject(r.statusCode, r.body);
			const job = r.json() as { id: string };
			const result = await waitForJob(app, internalHeaders(), job.id, 60_000);
			return { jobId: job.id, sequenceId: req.sequenceId, frame: req.frame, ...(result as object) };
		},
	});
	services.agent = service;
	return service;
}
