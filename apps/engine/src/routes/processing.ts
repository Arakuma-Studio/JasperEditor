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
import { requireUserApproval } from '../agent/user-approval.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { processingLicenses } from '../processing/licenses.ts';
import { ProcessingService } from '../processing/service.ts';
import { SettingsError } from '../processing/settings.ts';
import { registerLicenseProvider } from '../tools/licenses.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type KeyParams = { Params: { key: string } };
type ModelParams = { Params: { modelId: string } };

export default async function processingRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new ProcessingService(core);
	app.jasper.services.processing = svc;
	svc.registerRunners();
	core.registerCapabilityProvider(async () => ({ features: { processing: await svc.features() } }));
	registerLicenseProvider(() => processingLicenses(svc));

	app.post<KeyParams>(
		'/api/media/:key/process',
		guarded<KeyParams>(async (req) => {
			if (!MEDIA_KEY_RE.test(req.params.key) || !core.registry.get(req.params.key))
				throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
			const body = parseOr400(ProcessRequestSchema, req.body ?? {});
			return svc.submitProcess(req.params.key, body);
		}),
	);

	app.get(
		'/api/processing/models',
		guarded(async () => ({ models: await svc.models.list() })),
	);

	app.post<ModelParams>(
		'/api/processing/models/:modelId/install',
		guarded<ModelParams>(async (req) => {
			// wp speech: the catalogue's speech models install through the same job
			if (!svc.models.entry(req.params.modelId) && !svc.speechModels.entry(req.params.modelId))
				throw new HttpError(404, 'MODEL_UNKNOWN', `Unknown model ${req.params.modelId}`);
			return svc.submitInstall(req.params.modelId);
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
			// Changing where media is sent (the remote executor) is the user's decision (S07:PRA-001): the editor's
			// Preferences dialog saves directly, an agent — MCP `set_processing_settings` or any other client without
			// the editor key (security review AGT-3) — is asked about in the editor, in the window that has
			// `approvalProjectId` open when given.
			const r = body.remote;
			await requireUserApproval(app, req, {
				label: 'Change processing settings',
				summary: r
					? `remote executor: ${r.user}@${r.host}:${r.port} ${r.remoteDir} (${r.enabled ? 'enabled' : 'disabled'})`
					: 'remove the remote executor',
				reasons: ['changes where media is sent for processing (remote executor)'],
				projectId: req.query.approvalProjectId ?? null,
			});
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
		guarded(async () => {
			try {
				return await svc.submitSetup();
			} catch (e) {
				const err = e as { code?: string; message?: string };
				if (err.code === 'REMOTE_NOT_CONFIGURED') throw new HttpError(409, err.code, err.message ?? '');
				throw e;
			}
		}),
	);
}
