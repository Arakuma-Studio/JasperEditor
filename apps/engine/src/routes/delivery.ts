// Spec 19 §12 routes (TL-112…TL-116). Behind the engine's authentication like every `/api` route; bodies are parsed with
// zod. Jobs run through the queue, so they are cancellable with `POST /api/jobs/:id/cancel`.
import {
	AlphaDeliveryRequestSchema,
	type EngineJob,
	GamutCheckRequestSchema,
	LayerStyleReadQuerySchema,
	MAX_STYLE_FILE_BYTES,
	PsdRequestSchema,
	SplitImageRequestSchema,
} from '@jasper/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { agentNameOf } from '../agent/user-approval.ts';
import { SplitImageService } from '../export/delivery/split-image.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { JobError } from '../jobs/types.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';
import { readLayerStyles, StyleFileError } from '../title-looks/ps-styles.ts';

type WaitQuery = { Querystring: { wait?: string } };
type KeyParams = { Params: { key: string }; Querystring: { wait?: string } };

const originOf = (req: FastifyRequest): EngineJob['origin'] =>
	req.jasperEditor === true ? { type: 'user' } : { type: 'agent', agentRunId: agentNameOf(req) };

/** The request body, refused past `limit` bytes before more of it is read (AGENTS §0). */
async function readCapped(stream: Readable, limit: number): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream) {
		size += (chunk as Buffer).length;
		if (size > limit) {
			stream.destroy();
			throw new HttpError(413, 'STYLE_FILE_TOO_LARGE', `Style files are read up to ${limit / 1024 ** 2} MiB`);
		}
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

export default async function deliveryRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const { exports, queue } = core;
	const split = new SplitImageService(core);
	split.registerRunner();

	app.post<WaitQuery>(
		'/api/alpha-delivery',
		guarded<WaitQuery>(async (req, reply) => {
			const body = parseOr400(AlphaDeliveryRequestSchema, req.body);
			return replyWithJob(queue, await exports.alphaDelivery(body, originOf(req)), req.query.wait, reply, 'EXPORT_FAILED');
		}),
	);

	app.post(
		'/api/psd/plan',
		guarded(async (req) => exports.psdPlan(parseOr400(PsdRequestSchema, req.body))),
	);
	app.post<WaitQuery>(
		'/api/psd',
		guarded<WaitQuery>(async (req, reply) => {
			const body = parseOr400(PsdRequestSchema, req.body);
			return replyWithJob(queue, await exports.psd(body, originOf(req)), req.query.wait, reply, 'PSD_FAILED');
		}),
	);

	app.post<WaitQuery>(
		'/api/gamut-check',
		guarded<WaitQuery>(async (req, reply) => {
			const body = parseOr400(GamutCheckRequestSchema, req.body);
			return replyWithJob(queue, await exports.gamutCheck(body, originOf(req)), req.query.wait, reply, 'GAMUT_CHECK_FAILED');
		}),
	);

	const known = (key: string) => {
		if (!MEDIA_KEY_RE.test(key) || !core.registry.get(key))
			throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
	};
	const submitSplit = async (key: string, body: Parameters<SplitImageService['submit']>[1], req: FastifyRequest) => {
		try {
			return await split.submit(key, body, originOf(req));
		} catch (e) {
			if (e instanceof JobError) throw new HttpError(422, e.code, e.message, e.detail);
			throw e;
		}
	};
	app.post<KeyParams>(
		'/api/media/:key/split-image/analyze',
		guarded<KeyParams>(async (req, reply) => {
			known(req.params.key);
			return replyWithJob(queue, await submitSplit(req.params.key, null, req), req.query.wait, reply, 'SPLIT_FAILED');
		}),
	);
	app.post<KeyParams>(
		'/api/media/:key/split-image',
		guarded<KeyParams>(async (req, reply) => {
			known(req.params.key);
			const body = parseOr400(SplitImageRequestSchema, req.body);
			return replyWithJob(queue, await submitSplit(req.params.key, body, req), req.query.wait, reply, 'SPLIT_FAILED');
		}),
	);

	// The file travels as the raw body (`application/octet-stream`, passed through as a stream by the server).
	app.post<{ Querystring: { name?: string } }>(
		'/api/title-looks/layer-styles/read',
		guarded<{ Querystring: { name?: string } }>(async (req) => {
			const { name } = parseOr400(LayerStyleReadQuerySchema, req.query);
			const body = req.body as Readable | undefined;
			if (!body || typeof body.pipe !== 'function')
				throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file as application/octet-stream');
			const bytes = await readCapped(body, MAX_STYLE_FILE_BYTES);
			try {
				return readLayerStyles(bytes, name);
			} catch (e) {
				if (e instanceof StyleFileError)
					throw new HttpError(e.code === 'STYLE_FILE_TOO_LARGE' ? 413 : 400, e.code, e.message);
				throw e;
			}
		}),
	);
}
