// Clip processing (M2, S07, ARCHITECTURE §19.4). Owner: wp-m2-process.
//   POST /api/media/:key/process                 → `process` job (PRC-010)
//   GET  /api/processing/models                  → catalogue + install state (PST-031)
//   POST /api/processing/models/:modelId/install → `model-download` job
//   GET/PUT /api/settings/processing             → remote executor settings (PRM-001)
//   POST /api/processing/remote/probe            → RemoteProbeResult (PRM-003)
//   POST /api/processing/remote/setup            → `remote-setup` job (PRM-004)
// Also registers the `features.processing` capability block and the licence entries of vid.stab (WASM),
// ONNX Runtime, OpenCV.js and the bundled model weights (Help ▸ About ▸ Licenses).
import { ProcessingSettingsSchema, ProcessRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { processingLicenses } from '../processing/licenses.ts';
import { ProcessingService } from '../processing/service.ts';
import { SettingsError } from '../processing/settings.ts';
import { registerLicenseProvider } from '../tools/licenses.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type KeyParams = { Params: { key: string } };
/** The parts of the agent service (services.agent) used for approvals. */
type AgentLike = {
	isLive(projectId: string): boolean;
	approvals: {
		request(req: {
			projectId: string;
			label: string;
			agent: string;
			reasons: string[];
			commandCount: number;
			summary?: string;
		}): { decision: Promise<'approved' | 'denied' | 'timeout'> };
	};
};
type ModelParams = { Params: { modelId: string } };

export function processingService(app: FastifyInstance): ProcessingService {
	const s = app.jasper.services.processing as ProcessingService | undefined;
	if (!s) throw new Error('processing service not initialized');
	return s;
}

export default async function processingRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new ProcessingService(core);
	app.jasper.services.processing = svc;
	svc.registerRunners();
	core.registerCapabilityProvider(async () => ({ features: { processing: await svc.features() } }));
	registerLicenseProvider(() => processingLicenses(svc));

	const origin = (_req: unknown) => ({ type: 'user' as const });

	app.post<KeyParams>(
		'/api/media/:key/process',
		guarded<KeyParams>(async (req) => {
			if (!MEDIA_KEY_RE.test(req.params.key) || !core.registry.get(req.params.key))
				throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
			const body = parseOr400(ProcessRequestSchema, req.body ?? {});
			return svc.submitProcess(req.params.key, body, origin(req));
		}),
	);

	app.get(
		'/api/processing/models',
		guarded(async () => ({ models: await svc.models.list() })),
	);

	app.post<ModelParams>(
		'/api/processing/models/:modelId/install',
		guarded<ModelParams>(async (req) => {
			if (!svc.catalogEntry(req.params.modelId))
				throw new HttpError(404, 'MODEL_UNKNOWN', `Unknown model ${req.params.modelId}`);
			return svc.submitInstall(req.params.modelId, origin(req));
		}),
	);

	app.get(
		'/api/settings/processing',
		guarded(async () => svc.settings.get()),
	);

	type PutQuery = { Querystring: { approvalProjectId?: string; agent?: string } };
	app.put<PutQuery>(
		'/api/settings/processing',
		guarded<PutQuery>(async (req) => {
			const body = parseOr400(ProcessingSettingsSchema, req.body ?? {});
			// Agents (MCP set_processing_settings) change where media is sent: the user approves in the editor
			// window that has `approvalProjectId` open (S07:PRA-001), like destructive transactions.
			const approvalProjectId = req.query.approvalProjectId;
			if (approvalProjectId) {
				const agent = app.jasper.services.agent as AgentLike | undefined;
				if (!agent?.isLive(approvalProjectId))
					throw new HttpError(
						409,
						'E_NO_SESSION',
						"Changing the processing settings needs the user's approval: open the project in the editor first",
					);
				const r = body.remote;
				const { decision } = agent.approvals.request({
					projectId: approvalProjectId,
					label: 'Change processing settings',
					agent: (req.query.agent ?? 'agent').slice(0, 64),
					reasons: ['changes where media is sent for processing (remote executor)'],
					commandCount: 0,
					summary: r
						? `remote executor: ${r.user}@${r.host}:${r.port} ${r.remoteDir} (${r.enabled ? 'enabled' : 'disabled'})`
						: 'remove the remote executor',
				});
				const d = await decision;
				if (d !== 'approved')
					throw new HttpError(
						403,
						d === 'timeout' ? 'E_APPROVAL_TIMEOUT' : 'E_APPROVAL_DENIED',
						d === 'timeout' ? 'The user did not answer the approval request' : 'The user denied the change',
					);
			}
			try {
				const saved = await svc.settings.put(body);
				core.capabilities.changed();
				return saved;
			} catch (e) {
				if (e instanceof SettingsError) throw new HttpError(400, e.code, e.message);
				throw e;
			}
		}),
	);

	app.post(
		'/api/processing/remote/probe',
		guarded(async () => {
			try {
				return await svc.probeRemote();
			} catch (e) {
				const err = e as { code?: string; message?: string };
				if (err.code === 'REMOTE_NOT_CONFIGURED') throw new HttpError(409, err.code, err.message ?? '');
				throw e;
			}
		}),
	);

	app.post(
		'/api/processing/remote/setup',
		guarded(async (req) => {
			try {
				return await svc.submitSetup(origin(req));
			} catch (e) {
				const err = e as { code?: string; message?: string };
				if (err.code === 'REMOTE_NOT_CONFIGURED') throw new HttpError(409, err.code, err.message ?? '');
				throw e;
			}
		}),
	);
}
