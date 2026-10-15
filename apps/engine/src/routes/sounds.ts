// Sound library routes (spec 12 §2.1, §2.8; wp-note "WP1.2 engine library"):
//   GET  /api/sounds                     search (rankSounds) with facets
//   GET  /api/sounds/status              library status (counts, starter kit, indexing)
//   GET  /api/sounds/:soundId            one sound
//   GET  /api/sounds/:soundId/audio      its bytes (audio types only, nosniff, CSP sandbox, Range)
//   GET  /api/sounds/:soundId/visual     waveform peaks + spectrogram (u8, base64)
//   POST /api/sounds/:soundId/register   registers its file for a project; returns RegisteredMedia + provenance
//   POST /api/sounds/index               a `sound-index` job
//   GET  /api/sounds/roots               user folders
//   PUT  /api/sounds/roots               the new folder list (local mode; an agent adding, removing or relicensing
//                                        a folder needs the user's approval: security review AGT-3)
import {
	RegisterSoundRequestSchema,
	SoundIndexRequestSchema,
	SoundRootsPutRequestSchema,
	SoundSearchQuerySchema,
} from '@jasper/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { agentNameOf, requireUserApproval } from '../agent/user-approval.ts';
import { SoundService } from '../sounds/service.ts';
import { serveFile } from '../tools/http.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type P = { Params: { soundId: string } };

const originOf = (req: FastifyRequest) =>
	req.jasperEditor ? ({ type: 'user' } as const) : ({ type: 'agent', agentRunId: agentNameOf(req) } as const);

export default async function soundRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new SoundService(core, { log: (m) => app.log.warn(m) });
	app.jasper.services.sounds = svc;
	const unregister = core.registerCapabilityProvider(async () => ({
		features: { sound: await svc.capability() },
	}));
	const auto = () => {
		void svc
			.autoIndex()
			.catch((e) => app.log.warn(`sound library: auto-index failed: ${(e as Error).message}`));
	};
	app.addHook('onReady', async () => auto());
	app.addHook('onClose', async () => unregister());

	app.get(
		'/api/sounds',
		guarded(async (req) => {
			const q = parseOr400(SoundSearchQuerySchema, req.query ?? {});
			auto();
			return svc.search(q);
		}),
	);
	app.get(
		'/api/sounds/status',
		guarded(async () => {
			auto();
			return svc.status();
		}),
	);
	app.post(
		'/api/sounds/index',
		guarded(async (req, reply) => {
			const body = parseOr400(SoundIndexRequestSchema, req.body ?? {});
			reply.code(202);
			return svc.startIndex({ ...(body.full ? { full: true } : {}), origin: originOf(req) });
		}),
	);
	app.get(
		'/api/sounds/roots',
		guarded(async () => ({ roots: await svc.roots.list(), local: svc.local })),
	);
	app.put(
		'/api/sounds/roots',
		guarded(async (req) => {
			const body = parseOr400(SoundRootsPutRequestSchema, req.body ?? {});
			const plan = await svc.plannedRoots(body);
			const lines: string[] = [];
			const reasons: string[] = [];
			if (plan.added.length) {
				lines.push(
					`add ${plan.added.map((r) => `the folder "${r.path}" (declared ${r.license})`).join(', ')} to your sound library`,
				);
				reasons.push(
					'the library will read every audio file in it and offer the sounds under the licence declared here',
				);
			}
			if (plan.removed.length) {
				lines.push(
					`remove ${plan.removed.map((r) => `"${r.label}" (${r.path})`).join(', ')} from your sound library`,
				);
				reasons.push('its sounds leave the library (the files themselves are not touched)');
			}
			if (plan.relicensed.length) {
				lines.push(`declare ${plan.relicensed.map((r) => `"${r.label}" as ${r.license}`).join(', ')}`);
				reasons.push('a licence declaration decides whether its sounds count as safe for commercial use');
			}
			if (lines.length)
				await requireUserApproval(app, req, {
					label: plan.added.length
						? 'Add a sound folder'
						: plan.removed.length
							? 'Remove a sound folder'
							: 'Change a sound folder’s licence',
					summary: lines.join('; ').slice(0, 1000),
					reasons,
				});
			const out = await svc.applyRoots(plan.next, plan, originOf(req));
			return { ...out, local: svc.local };
		}),
	);
	app.get<P>(
		'/api/sounds/:soundId',
		guarded<P>(async (req) => svc.get(req.params.soundId)),
	);
	app.get<P>(
		'/api/sounds/:soundId/audio',
		guarded<P>(async (req, reply) => {
			const e = await svc.get(req.params.soundId);
			const file = await svc.fileOf(e);
			return serveFile(req, reply, file, { cache: 'revalidate', contentType: svc.audioType(file) });
		}),
	);
	app.get<P>(
		'/api/sounds/:soundId/visual',
		guarded<P>(async (req) => svc.visual(await svc.get(req.params.soundId))),
	);
	app.post<P>(
		'/api/sounds/:soundId/register',
		guarded<P>(async (req) => {
			const { projectId } = parseOr400(RegisterSoundRequestSchema, req.body ?? {});
			if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			return svc.register(req.params.soundId, projectId);
		}),
	);
}
