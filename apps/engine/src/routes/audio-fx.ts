import { join } from 'node:path';
import {
	AudioClassifyRequestSchema,
	BeatsRequestSchema,
	type EnvelopeJson,
	RemixPlanRequestSchema,
} from '@jasper/api';
import { loadProject, type ProjectDocument, type Sequence } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { agentNameOf } from '../agent/user-approval.ts';
import { BeatService } from '../audio/beats.ts';
import { ClassifyService, requestTargets } from '../audio/classify.ts';
import { RemixPlanError, RemixPlanner } from '../audio/remix.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { isProjectId } from '../projects/store.ts';
import { liveDocument } from '../sound-design/plan.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

export default async function audioFxRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const planner = new RemixPlanner(core.ffmpeg);
	// Sound Design beat cues (spec 12 §2.8): shared with the cue route and the plan job through `services.beats`.
	const beats = new BeatService(
		core.ffmpeg,
		core.registry,
		join(app.jasper.config.paths.soundsDir, 'analysis', 'beats'),
	);
	app.jasper.services.beats = beats;
	app.post(
		'/api/audio/beats',
		guarded(async (req) => {
			const body = parseOr400(BeatsRequestSchema, req.body);
			if (!MEDIA_KEY_RE.test(body.mediaKey) || !core.registry.get(body.mediaKey))
				throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
			const ac = new AbortController();
			req.raw.on('close', () => {
				if (!req.raw.complete || req.raw.destroyed) ac.abort();
			});
			return beats.analyze(body, ac.signal);
		}),
	);
	// Essential Sound Auto Tag (spec 12 P6-R3): an `audio-classify` job; results cached per file and range.
	const classify = new ClassifyService(core, join(app.jasper.config.paths.soundsDir, 'analysis', 'classify'));
	classify.registerRunner();
	app.jasper.services.classify = classify;
	app.post<{ Querystring: { wait?: string } }>(
		'/api/audio/classify',
		guarded<{ Querystring: { wait?: string } }>(async (req, reply) => {
			const body = parseOr400(AudioClassifyRequestSchema, req.body ?? {});
			let doc: ProjectDocument | null = null;
			let projectId: string | null = null;
			if (body.clipIds) {
				if (body.envelope) {
					try {
						doc = loadProject(body.envelope as EnvelopeJson).document;
					} catch (e) {
						throw new HttpError(400, 'VALIDATION_FAILED', `Invalid project: ${(e as Error).message}`);
					}
					projectId =
						body.projectId && isProjectId(body.projectId)
							? body.projectId
							: typeof doc.projectId === 'string' && isProjectId(doc.projectId)
								? doc.projectId
								: null;
				} else {
					if (!isProjectId(body.projectId!)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
					const agent = app.jasper.services.agent as AgentService | undefined;
					if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The agent service is not running');
					if (!(await agent.projectExists(body.projectId!)))
						throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
					doc = (await liveDocument(agent, body.projectId!)).doc;
					projectId = body.projectId!;
				}
			} else
				for (const k of body.mediaKeys ?? [])
					if (!MEDIA_KEY_RE.test(k)) throw new HttpError(400, 'VALIDATION_FAILED', `Not a media key: ${k}`);
			let seq: Sequence | null = null;
			if (doc) {
				const seqId = body.sequenceId ?? Object.keys(doc.sequences)[0];
				seq =
					seqId !== undefined && Object.hasOwn(doc.sequences, seqId) ? (doc.sequences[seqId] ?? null) : null;
				if (!seq)
					throw new HttpError(
						404,
						'SEQUENCE_NOT_FOUND',
						body.sequenceId ? `Sequence not found: ${body.sequenceId}` : 'The project has no sequence',
					);
				if (!body.clipIds!.some((id) => Object.hasOwn(seq!.clips, id)))
					throw new HttpError(404, 'CLIP_NOT_FOUND', 'None of the clips is in the sequence');
			} else if (!(body.mediaKeys ?? []).some((k) => core.registry.get(k)))
				throw new HttpError(404, 'ASSET_NOT_FOUND', 'None of the media keys is registered');
			const targets = requestTargets(body, doc, seq, core.registry);
			const job = classify.submit(
				{ projectId: projectId ?? body.projectId ?? null, sequenceId: seq?.id ?? null, targets },
				req.jasperEditor === true ? { type: 'user' } : { type: 'agent', agentRunId: agentNameOf(req) },
			);
			return replyWithJob(core.queue, job, req.query.wait, reply, 'CLASSIFY_FAILED');
		}),
	);
	app.post(
		'/api/audio/remix-plan',
		guarded(async (req) => {
			const body = parseOr400(RemixPlanRequestSchema, req.body);
			if (!MEDIA_KEY_RE.test(body.mediaKey) || !core.registry.get(body.mediaKey))
				throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
			const path = await core.registry.resolvePath(body.mediaKey);
			if (!path) throw new HttpError(409, 'MEDIA_OFFLINE', 'The media is offline');
			try {
				return await planner.plan(path, body);
			} catch (e) {
				if (e instanceof RemixPlanError) throw new HttpError(422, e.code, e.message);
				throw e;
			}
		}),
	);
}
