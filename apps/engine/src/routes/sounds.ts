// Sound library routes (spec 12 §2.1, §2.8; wp-note "WP1.2 engine library"):
//   GET  /api/sounds                     search (rankSounds) with facets
//   GET  /api/sounds/status              library status (counts, starter kit, indexing)
//   GET  /api/sounds/:soundId            one sound (a take id `snd_…~t<n>` names a take of a recording, P6-E9;
//                                        every :soundId route takes both)
//   GET  /api/sounds/:soundId/audio      its bytes (audio types only, nosniff, CSP sandbox, Range; a take's range as WAV)
//   GET  /api/sounds/:soundId/visual     waveform peaks + spectrogram (u8, base64)
//   POST /api/sounds/:soundId/register   registers its file for a project; returns RegisteredMedia + provenance
//   POST /api/sounds/index               a `sound-index` job
//   GET  /api/sounds/roots               user folders
//   GET  /api/sounds/packs               the pack catalogue with what is installed (WP6.1)
//   POST /api/sounds/packs/:packId/install   a `sound-pack-install` job (202; open to agents like model installs:
//                                        catalogue-pinned, size-bounded downloads)
//   DELETE /api/sounds/packs/:packId     removes an installed pack (an agent needs the user's approval: AGT-3)
//   GET  /api/sounds/semantic            Describe-it search status (P6-E14, WP-E9): model, embedded sounds, job
//   GET  /api/sounds/semantic/models     its model catalogue (licence, size, installed, available)
//   POST /api/sounds/semantic/models/:modelId/install   the processing catalogue's `model-download` job (202; open to
//                                        agents like every model install: pinned, sha256-checked, licence shown first)
//   DELETE /api/sounds/semantic/models/:modelId   removes it and its cached embeddings (an agent needs the user's
//                                        approval: AGT-3)
//   POST /api/sounds/semantic/embed      a `sound-embed` job (202): embeddings of the sounds that lack one
//   POST /api/sounds/:soundId/moments    a `sound-moment` job: the best windows of a sound for a description (?wait=1)
//   PUT  /api/sounds/roots               the new folder list (local mode; an agent adding, removing, relicensing or
//                                        re-crediting a folder needs the user's approval: security review AGT-3;
//                                        409 SOUND_ROOTS_CHANGED when the list changed while the approval waited)
import {
	RegisterSoundRequestSchema,
	SoundEmbedRequestSchema,
	SoundIndexRequestSchema,
	SoundMomentRequestSchema,
	SoundRootsPutRequestSchema,
	SoundSearchQuerySchema,
} from '@jasper/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { agentNameOf, type OperationApproval, requireUserApproval } from '../agent/user-approval.ts';
import { replyWithJob } from '../jobs/reply.ts';
import type { ProcessingService } from '../processing/service.ts';
import type { SoundRootsPlan } from '../sounds/roots.ts';
import { SoundService } from '../sounds/service.ts';
import { serveFile } from '../tools/http.ts';
import { registerLicenseProvider } from '../tools/licenses.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type P = { Params: { soundId: string } };
type ModelP = { Params: { modelId: string } };
type PackP = { Params: { packId: string } };

const MB = (n: number) => `${(n / 1_048_576).toFixed(n < 10 * 1_048_576 ? 1 : 0)} MB`;

/** Longest path or change shown per folder on the approval card (the card's summary holds 600 characters). */
const CARD_ITEM_CHARS = 120;
const cut = (text: string, max = CARD_ITEM_CHARS) =>
	text.length <= max ? text : `…${text.slice(text.length - (max - 1))}`;

/**
 * The approval card of a folder-list change, or null when it decides nothing about the user's files (renaming,
 * enabling, disabling). The summary starts with the count of every kind of change, then removals, licence and credit
 * changes, then additions, each item cut to CARD_ITEM_CHARS (a long path cannot push a removal off the card); the label
 * names every kind.
 */
export function rootsApprovalCard(plan: SoundRootsPlan): OperationApproval | null {
	const { added, removed, relicensed, recredited } = plan;
	if (!added.length && !removed.length && !relicensed.length && !recredited.length) return null;
	const lines: string[] = [
		`This adds ${added.length}, removes ${removed.length}, relicenses ${relicensed.length} and changes the credit line of ${recredited.length} sound folder(s)`,
	];
	const reasons: string[] = [];
	const kinds: string[] = [];
	if (removed.length) {
		kinds.push('remove');
		lines.push(
			`remove ${removed.map((r) => `"${cut(r.label, 80)}" (${cut(r.path)})`).join(', ')} from your sound library`,
		);
		reasons.push('its sounds leave the library (the files themselves are not touched)');
	}
	if (relicensed.length) {
		kinds.push('relicense');
		lines.push(`declare ${relicensed.map((r) => `"${cut(r.label, 80)}" as ${r.license}`).join(', ')}`);
		reasons.push('a licence declaration decides whether its sounds count as safe for commercial use');
	}
	if (recredited.length) {
		kinds.push('change credits');
		lines.push(
			`change the credit line of ${recredited
				.map((c) => `"${cut(c.root.label, 80)}" (${c.changes.map((x) => cut(x)).join('; ')})`)
				.join(', ')}`,
		);
		reasons.push('the credit line and author are what projects using its sounds print as their attribution');
	}
	if (added.length) {
		kinds.push('add');
		lines.push(
			`add ${added.map((r) => `the folder "${cut(r.path)}" (declared ${r.license})`).join(', ')} to your sound library`,
		);
		reasons.push(
			'the library will read every audio file in it and offer the sounds under the licence declared here',
		);
	}
	const single: Record<string, string> = {
		add: 'Add a sound folder',
		remove: 'Remove a sound folder',
		relicense: 'Change a sound folder’s licence',
		'change credits': 'Change a sound folder’s credit line',
	};
	const label = kinds.length === 1 ? single[kinds[0]!]! : `Sound folders: ${kinds.join(', ')}`;
	return { label, summary: lines.join('; '), reasons };
}

const originOf = (req: FastifyRequest) =>
	req.jasperEditor ? ({ type: 'user' } as const) : ({ type: 'agent', agentRunId: agentNameOf(req) } as const);

export default async function soundRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const processing = (app.jasper.services.processing as ProcessingService | undefined) ?? null;
	const svc = new SoundService(core, { log: (m) => app.log.warn(m), processing });
	app.jasper.services.sounds = svc;
	const unregister = core.registerCapabilityProvider(async () => ({
		features: { sound: await svc.capability() },
	}));
	const auto = () => {
		void svc
			.autoIndex()
			.catch((e) => app.log.warn(`sound library: auto-index failed: ${(e as Error).message}`));
	};
	const unregisterLicenses = registerLicenseProvider(() => svc.packs.licenses());
	app.addHook('onReady', async () => auto());
	app.addHook('onClose', async () => {
		unregister();
		unregisterLicenses();
		svc.semantic.close();
		await svc.analyzer.close();
	});

	app.get(
		'/api/sounds',
		guarded(async (req) => {
			const q = parseOr400(SoundSearchQuerySchema, req.query ?? {});
			auto();
			return svc.search(q);
		}),
	);
	app.get(
		'/api/sounds/semantic',
		guarded(async () => svc.semantic.status()),
	);
	app.get(
		'/api/sounds/semantic/models',
		guarded(async () => ({ models: await svc.semantic.listModels() })),
	);
	app.post<ModelP>(
		'/api/sounds/semantic/models/:modelId/install',
		guarded<ModelP>(async (req, reply) => {
			const id = req.params.modelId;
			const m = (await svc.semantic.listModels()).find((x) => x.id === id);
			if (!m || !processing)
				throw new HttpError(
					404,
					'MODEL_UNKNOWN',
					`Unknown Describe-it search model ${String(id).slice(0, 64)}`,
				);
			if (!m.installed && !m.available)
				throw new HttpError(
					409,
					'MODEL_DOWNLOAD_PENDING',
					`${m.name}: ${m.unavailableReason ?? 'not available yet'}`,
				);
			const job = processing.submitInstall(id, originOf(req));
			// once installed, the library is embedded in the background
			void core.queue
				.wait(job.id)
				.then((j) => (j.state === 'succeeded' ? svc.semantic.autoEmbed() : null))
				.catch(() => undefined);
			reply.code(202);
			return job;
		}),
	);
	app.delete<ModelP>(
		'/api/sounds/semantic/models/:modelId',
		guarded<ModelP>(async (req) => {
			const id = req.params.modelId;
			const m = (await svc.semantic.listModels()).find((x) => x.id === id);
			const store = svc.semantic.models;
			if (!m || !store)
				throw new HttpError(
					404,
					'MODEL_UNKNOWN',
					`Unknown Describe-it search model ${String(id).slice(0, 64)}`,
				);
			if (m.job)
				throw new HttpError(409, 'MODEL_BUSY', 'The model is being downloaded; cancel the job first');
			const busy = core.queue
				.list({ active: true })
				.some((j) => j.kind === 'sound-embed' || j.kind === 'sound-moment');
			if (busy)
				throw new HttpError(
					409,
					'MODEL_BUSY',
					'The model is in use (an embedding or Find Moment job); cancel it first',
				);
			// Nothing on disk: nothing to ask about (idempotent).
			if (m.installed || m.missingBytes < m.sizeBytes)
				// Security review AGT-3: like removing any downloaded model.
				await requireUserApproval(app, req, {
					label: 'Remove a downloaded model',
					summary: `remove the Describe-it search model ${m.name} (${MB(m.sizeBytes)}) and its cached embeddings from this computer`,
					reasons: [
						'Describe-it search and Find Moment stop working until it is downloaded again (keyword search keeps working)',
					],
				});
			const removedEmbeddings = await svc.semantic.forget(id);
			const r = await store.remove(id);
			core.capabilities.changed();
			return { modelId: id, freedBytes: r.freedBytes, removedEmbeddings };
		}),
	);
	app.post(
		'/api/sounds/semantic/embed',
		guarded(async (req, reply) => {
			const body = parseOr400(SoundEmbedRequestSchema, req.body ?? {});
			const job = await svc.semantic.startEmbed({
				...(body.full ? { full: true } : {}),
				origin: originOf(req),
			});
			reply.code(202);
			return job;
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
		'/api/sounds/packs',
		guarded(async () => svc.listPacks()),
	);
	app.post<PackP>(
		'/api/sounds/packs/:packId/install',
		guarded<PackP>(async (req, reply) => {
			const job = await svc.submitPackInstall(req.params.packId, originOf(req));
			reply.code(202);
			return job;
		}),
	);
	app.delete<PackP>(
		'/api/sounds/packs/:packId',
		guarded<PackP>(async (req) => {
			const id = req.params.packId;
			const { packs } = await svc.listPacks();
			const p = packs.find((x) => x.id === id);
			if (!p) throw new HttpError(404, 'SOUND_PACK_UNKNOWN', `Unknown sound pack ${String(id).slice(0, 64)}`);
			if (p.job)
				throw new HttpError(409, 'SOUND_PACK_BUSY', 'The pack is being installed; cancel the job first');
			// Nothing installed: nothing to ask about (idempotent).
			if (p.state !== 'available')
				// Security review AGT-3: like removing a downloaded model.
				await requireUserApproval(app, req, {
					label: 'Remove a sound pack',
					summary: `remove the sound pack "${p.title.slice(0, 120)}" (${p.sounds} sounds, ${MB(p.installedBytes ?? p.installBytes)}) from this computer's sound library`,
					reasons: [
						'its sounds leave the sound library for every project and agent until it is installed again (a download)',
						'projects that already use its sounds keep their own copies',
					],
				});
			return svc.removePack(id, originOf(req));
		}),
	);
	app.get(
		'/api/sounds/roots',
		guarded(async () => ({ roots: await svc.visibleRoots(), local: svc.local })),
	);
	app.put(
		'/api/sounds/roots',
		guarded(async (req) => {
			const body = parseOr400(SoundRootsPutRequestSchema, req.body ?? {});
			const plan = await svc.plannedRoots(body);
			const card = rootsApprovalCard(plan);
			// The plan carries the list's revision: if the list changed while the card waited, saving it is refused
			// (409 SOUND_ROOTS_CHANGED) instead of silently undoing the other change.
			if (card) await requireUserApproval(app, req, card);
			const out = await svc.applyRoots(plan, originOf(req));
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
			const file = await svc.audioFileOf(e);
			return serveFile(req, reply, file, { cache: 'revalidate', contentType: svc.audioType(file) });
		}),
	);
	app.post<{ Params: { soundId: string }; Querystring: { wait?: string } }>(
		'/api/sounds/:soundId/moments',
		guarded<{ Params: { soundId: string }; Querystring: { wait?: string } }>(async (req, reply) => {
			const body = parseOr400(SoundMomentRequestSchema, req.body ?? {});
			if (body.startSec !== undefined && body.endSec !== undefined && body.endSec <= body.startSec)
				throw new HttpError(400, 'INVALID_RANGE', 'endSec must be after startSec');
			const job = await svc.semantic.submitMoments(req.params.soundId, body, originOf(req));
			return replyWithJob(core.queue, job, req.query.wait, reply, 'MOMENT_FAILED');
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
