import type { ErrorShape } from '@jasper/api';

/** An engine error response (S04:ENG-022) or a client-side failure (network, invalid response). */
export class EngineError extends Error {
	readonly code: string;
	readonly status: number;
	readonly detail?: unknown;
	readonly retryable: boolean;
	constructor(
		code: string,
		message: string,
		opts: { status?: number; detail?: unknown; retryable?: boolean } = {},
	) {
		super(message);
		this.name = 'EngineError';
		this.code = code;
		this.status = opts.status ?? 0;
		this.detail = opts.detail;
		this.retryable = opts.retryable ?? false;
	}
	static fromShape(shape: ErrorShape, status: number): EngineError {
		return new EngineError(shape.code, shape.message, {
			status,
			detail: shape.detail,
			retryable: shape.retryable,
		});
	}
}
