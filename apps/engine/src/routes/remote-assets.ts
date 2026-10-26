// social-comment §7.8: Settings ▸ Privacy & Network ("Platform fonts & emoji for social templates", spec 04 OF-002)
// and the remote-asset service (status, prefetch / retry, first-fetch notice).
import { NetworkSettingsSchema, RemoteAssetPrefetchRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type PutQuery = { Querystring: { approvalProjectId?: string } };

export default async function remoteAssetRoutes(app: FastifyInstance): Promise<void> {
	const { fonts, remoteAssets } = coreServices(app);

	app.get(
		'/api/settings/network',
		guarded(async () => remoteAssets.settings.get()),
	);

	app.put<PutQuery>(
		'/api/settings/network',
		guarded<PutQuery>(async (req) => {
			const body = parseOr400(NetworkSettingsSchema, req.body ?? {});
			// Allowing downloads is the user's decision: an agent that turns a network use on is asked about in the
			// editor (switching it off needs no approval).
			if (body.platformAssets && !(await remoteAssets.settings.get()).platformAssets)
				await requireUserApproval(app, req, {
					label: 'Allow platform fonts & emoji downloads',
					summary:
						'lets the engine download platform fonts and emoji images for social-comment templates (Settings ▸ Privacy & Network)',
					reasons: ['turns on a network use (downloads from the remote-asset manifest)'],
					projectId: req.query.approvalProjectId ?? null,
					noEditor: 'E_NO_SESSION',
				});
			return remoteAssets.putSettings(body);
		}),
	);

	app.get(
		'/api/remote-assets',
		guarded(async () => remoteAssets.status()),
	);

	app.post(
		'/api/remote-assets/prefetch',
		guarded(async (req) => {
			const body = parseOr400(RemoteAssetPrefetchRequestSchema, req.body ?? {});
			return remoteAssets.prefetch(body, (face) => fonts.isBundledFace(face));
		}),
	);

	app.post(
		'/api/remote-assets/notice/ack',
		guarded(async () => remoteAssets.acknowledgeNotice()),
	);
}
