// Route helpers: zod validation and the S04:ENG-022 error shape for every service error.
import { errorBody } from '@jasper/api';
import type { FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import type { z } from 'zod';

export function fail(reply: FastifyReply, status: number, code: string, message: string, detail?: unknown) {
	return reply
		.code(status)
		.type('application/json')
		.send(errorBody(code, message, detail));
}

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
	}
}

/** Parses `value` or throws a 400 VALIDATION_FAILED HttpError listing the zod issues. */
export function parseOr400<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
	const r = schema.safeParse(value);
	if (!r.success) {
		const first = r.error.issues[0];
		throw new HttpError(
			400,
			'VALIDATION_FAILED',
			first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request',
			r.error.issues.slice(0, 20),
		);
	}
	return r.data;
}

const STATUS_BY_CODE: Record<string, number> = {
	BAD_REQUEST: 400,
	VALIDATION_FAILED: 400,
	NOT_FOUND: 404,
	ASSET_NOT_FOUND: 404,
	PROJECT_NOT_FOUND: 404,
	JOB_NOT_FOUND: 404,
	UPLOAD_NOT_FOUND: 404,
	LEASE_NOT_FOUND: 404,
	FONT_NOT_FOUND: 404,
	UNSUPPORTED_MEDIA: 415,
	REVISION_CONFLICT: 409,
	LEASE_HELD: 409,
	UPLOAD_OFFSET_MISMATCH: 409,
	UPLOAD_SIZE_MISMATCH: 400,
	JOB_NOT_RETRYABLE: 409,
	PATH_NOT_ELIGIBLE: 409,
	LOCAL_MODE_ONLY: 403,
	DISK_FULL: 507,
	BINARY_MISSING: 503,
	NOT_IMPLEMENTED: 501,
};

/**
 * Node system errors (`ENOSPC`, `EACCES`, `ENOENT`… with `syscall`/`errno`) are not service errors: their
 * `code` is not an ENG-022 code and their message carries absolute paths. Maps them to stable codes.
 */
export function systemErrorReply(
	e: unknown,
): { status: number; code: string; message: string; detail: unknown } | null {
	const err = e as { code?: unknown; syscall?: unknown; errno?: unknown } | null;
	if (!err || typeof err.code !== 'string' || !/^E[A-Z0-9]+$/.test(err.code)) return null;
	if (typeof err.syscall !== 'string' && typeof err.errno !== 'number') return null;
	const detail = { errno: err.code, ...(typeof err.syscall === 'string' ? { syscall: err.syscall } : {}) };
	switch (err.code) {
		case 'ENOSPC':
		case 'EDQUOT':
			return { status: 507, code: 'DISK_FULL', message: 'The engine storage is full', detail };
		case 'ENOENT':
		case 'ENOTDIR':
			return { status: 404, code: 'NOT_FOUND', message: 'A file the request needs does not exist', detail };
		default:
			return {
				status: 500,
				code: 'INTERNAL',
				message: `Engine storage error (${err.code})`,
				detail,
			};
	}
}

/** Maps service errors (they all carry `code`, and some `status`/`detail`) to an HTTP error reply. */
export function sendServiceError(reply: FastifyReply, e: unknown) {
	const sys = systemErrorReply(e);
	if (sys) {
		if (sys.status >= 500) reply.log.error(e);
		return fail(reply, sys.status, sys.code, sys.message, sys.detail);
	}
	const err = e as {
		code?: string;
		status?: number;
		statusCode?: number;
		message?: string;
		detail?: unknown;
	};
	const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
	const status = err.status ?? STATUS_BY_CODE[code] ?? (code === 'INTERNAL' ? 500 : 400);
	if (status >= 500 && code === 'INTERNAL') {
		reply.log.error(e);
		return fail(reply, 500, 'INTERNAL', 'Internal engine error');
	}
	return fail(reply, status, code, err.message ?? code, err.detail);
}

/** Wraps an async route handler so thrown service errors become ENG-022 replies. */
export function guarded<RG extends RouteGenericInterface = RouteGenericInterface>(
	fn: (req: FastifyRequest<RG>, reply: FastifyReply) => Promise<unknown>,
) {
	return async (req: FastifyRequest<RG>, reply: FastifyReply) => {
		try {
			return await fn(req, reply);
		} catch (e) {
			return sendServiceError(reply, e);
		}
	};
}
