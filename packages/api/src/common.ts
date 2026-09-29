// Engine HTTP contract basics (ARCHITECTURE §9.2, S04:ENG-022/024).
import { z } from 'zod';

export const API_VERSION = 1;
export const API_HEADER = 'x-jasper-api';
export const AUTH_COOKIE = 'jasper_session';
export const IF_MATCH_HEADER = 'if-match';

/** Stable engine error codes (S04:ENG-022 plus the codes used by ARCHITECTURE §9–§11). */
export const ENGINE_ERROR_CODES = [
	'BAD_REQUEST',
	'VALIDATION_FAILED',
	'UNAUTHORIZED',
	'FORBIDDEN_HOST',
	'NOT_FOUND',
	'NOT_IMPLEMENTED',
	'METHOD_NOT_ALLOWED',
	'PAYLOAD_TOO_LARGE',
	'INTERNAL',
	'ASSET_NOT_FOUND',
	'UNSUPPORTED_MEDIA',
	'DISK_FULL',
	'QUOTA_EXCEEDED',
	'PROVIDER_NOT_CONFIGURED',
	'BINARY_MISSING',
	'LOCAL_MODE_ONLY',
	'PROJECT_NOT_FOUND',
	'REVISION_CONFLICT',
	'LEASE_HELD',
	'LEASE_NOT_FOUND',
	'UPLOAD_NOT_FOUND',
	'UPLOAD_OFFSET_MISMATCH',
	'UPLOAD_SIZE_MISMATCH',
	'JOB_NOT_FOUND',
	'JOB_CANCELLED',
	'JOB_NOT_RETRYABLE',
	'PATH_NOT_ELIGIBLE',
	'FRAME_COUNT_MISMATCH',
	'FONT_NOT_FOUND',
	'TEMPLATE_NOT_FOUND',
	'MG_UNAVAILABLE',
	'INVALID_SPEC',
	'NO_SESSION',
	'APPROVAL_DENIED',
	'APPROVAL_TIMEOUT',
	'TRANSACTION_REJECTED',
] as const;
export const EngineErrorCodeSchema = z.enum(ENGINE_ERROR_CODES);
export type EngineErrorCode = z.infer<typeof EngineErrorCodeSchema>;

/** Every error response body (S04:ENG-022). Unknown codes from newer engines are tolerated. */
export const ErrorShapeSchema = z.object({
	code: z.string(),
	message: z.string(),
	detail: z.unknown().optional(),
	retryable: z.boolean(),
});
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;

export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
	'DISK_FULL',
	'INTERNAL',
	'NO_SESSION',
	'LEASE_HELD',
]);

export function errorBody(code: EngineErrorCode | string, message: string, detail?: unknown): ErrorShape {
	return { code, message, ...(detail !== undefined ? { detail } : {}), retryable: RETRYABLE_CODES.has(code) };
}

export const RationalSchema = z.object({
	num: z.number().int().positive(),
	den: z.number().int().positive(),
});
export const IsoTimeSchema = z.string();
