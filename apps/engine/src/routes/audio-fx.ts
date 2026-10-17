import { join } from 'node:path';
import { BeatsRequestSchema, RemixPlanRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { BeatService } from '../audio/beats.ts';
import { RemixPlanError, RemixPlanner } from '../audio/remix.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
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
