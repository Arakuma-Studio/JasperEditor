// Media range view routes (spec 18 §2.3 AF-VIEW-002; docs/wp-notes/agent-footage-view.md). Authenticated like every
// /api route; bodies validated by @jasper/api schemas; the work runs inside the request and stops when the client goes
// away (`clientGoneSignal`):
//   POST /api/media/:mediaKey/frames       {times ≤ 16, width ≤ 960, height? ≤ 1080} → PNG frames (base64)
//   POST /api/media/:mediaKey/range-audio  {start, end, streamIndex?} → 10 ms levels + voice classes of the range
//   POST /api/sequence-range-audio         {envelope, sequenceId, startFrame, endFrame} → the same of the mix
import {
	type EnvelopeJson,
	MediaFramesRequestSchema,
	type MediaFramesResponse,
	MediaRangeAudioRequestSchema,
	RANGE_VIEW_MAX_FRAME_HEIGHT,
	RANGE_VIEW_MAX_SECONDS,
	SequenceRangeAudioRequestSchema,
} from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import { loadProject, type ProjectDocument } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { extractFrames, mediaRangeAudio, sequenceRangeAudio } from '../media/range-view.ts';
import type { MediaRecord } from '../media/registry.ts';
import { clientGoneSignal, guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';
import type { VoiceAnalysisService } from '../voice/service.ts';

type K = { Params: { mediaKey: string } };

export default async function rangeViewRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);

	/** The record and its online file; 404 for an unknown key, 409 MEDIA_OFFLINE when the file is gone or changed. */
	const online = async (key: string): Promise<{ record: MediaRecord; path: string }> => {
		const record = MEDIA_KEY_RE.test(key) ? core.registry.get(key) : null;
		if (!record) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
		const path = await core.registry.resolvePath(key);
		if (!path)
			throw new HttpError(409, 'MEDIA_OFFLINE', `${record.originalName} is offline (missing or changed)`);
		return { record, path };
	};

	app.post<K>(
		'/api/media/:mediaKey/frames',
		guarded<K>(async (req, reply) => {
			const signal = clientGoneSignal(reply);
			const body = parseOr400(MediaFramesRequestSchema, req.body ?? {});
			const { record, path } = await online(req.params.mediaKey);
			const frames = await extractFrames({
				ff: core.ffmpeg,
				path,
				record,
				times: body.times,
				box: { width: body.width, height: body.height ?? RANGE_VIEW_MAX_FRAME_HEIGHT },
				signal,
			});
			const out: MediaFramesResponse = {
				mediaKey: record.mediaKey,
				durationSec: record.durationSec,
				frames,
			};
			return out;
		}),
	);

	app.post<K>(
		'/api/media/:mediaKey/range-audio',
		guarded<K>(async (req, reply) => {
			const signal = clientGoneSignal(reply);
			const body = parseOr400(MediaRangeAudioRequestSchema, req.body ?? {});
			const { record, path } = await online(req.params.mediaKey);
			return mediaRangeAudio({
				ff: core.ffmpeg,
				path,
				record,
				start: body.start,
				end: body.end,
				...(body.streamIndex !== undefined ? { streamIndex: body.streamIndex } : {}),
				voice: (app.jasper.services.voiceAnalysis as VoiceAnalysisService | undefined) ?? null,
				signal,
			});
		}),
	);

	app.post(
		'/api/sequence-range-audio',
		guarded(async (req, reply) => {
			const signal = clientGoneSignal(reply);
			const body = parseOr400(SequenceRangeAudioRequestSchema, req.body ?? {});
			let doc: ProjectDocument;
			try {
				doc = loadProject(body.envelope as EnvelopeJson, { mgTemplates: mgRegistry }).document;
			} catch (e) {
				throw new HttpError(400, 'VALIDATION_FAILED', `Invalid project: ${(e as Error).message}`);
			}
			const seq = Object.hasOwn(doc.sequences, body.sequenceId) ? doc.sequences[body.sequenceId] : undefined;
			if (!seq) throw new HttpError(404, 'SEQUENCE_NOT_FOUND', `Sequence not found: ${body.sequenceId}`);
			return sequenceRangeAudio({
				ff: core.ffmpeg,
				doc,
				seq,
				startFrame: body.startFrame,
				endFrame: body.endFrame,
				maxSeconds: RANGE_VIEW_MAX_SECONDS,
				registry: core.registry,
				signal,
			});
		}),
	);
}
