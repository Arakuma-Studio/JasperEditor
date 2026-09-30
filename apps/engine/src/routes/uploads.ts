// Resumable chunked uploads (S04:IN-005, ARCHITECTURE §9.2).
import type { Readable } from 'node:stream';
import { UploadCreateRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type U = { Params: { uploadId: string }; Querystring: { offset?: string } };

export default async function uploadsRoutes(app: FastifyInstance): Promise<void> {
	const { uploads } = coreServices(app);

	app.post(
		'/api/uploads',
		guarded(async (req, reply) => {
			const body = parseOr400(UploadCreateRequestSchema, req.body);
			return reply.code(201).send(await uploads.create(body));
		}),
	);

	app.put<U>(
		'/api/uploads/:uploadId',
		guarded<U>(async (req) => {
			const raw = req.query.offset;
			if (raw === undefined || !/^\d+$/.test(raw))
				throw new HttpError(400, 'VALIDATION_FAILED', 'offset query is required');
			const body = req.body as Readable | Buffer | undefined;
			if (!body || typeof (body as Readable).pipe !== 'function') {
				throw new HttpError(415, 'BAD_REQUEST', 'Chunks must be sent as application/octet-stream');
			}
			const len = req.headers['content-length'] ? Number(req.headers['content-length']) : undefined;
			return uploads.append(
				req.params.uploadId,
				Number(raw),
				body as Readable,
				Number.isFinite(len) ? len : undefined,
			);
		}),
	);

	app.post<U>(
		'/api/uploads/:uploadId/complete',
		guarded<U>(async (req) => uploads.complete(req.params.uploadId)),
	);

	app.delete<U>(
		'/api/uploads/:uploadId',
		guarded<U>(async (req) => {
			await uploads.abort(req.params.uploadId);
			return { ok: true as const };
		}),
	);
}
