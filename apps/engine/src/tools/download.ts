// Resumable, verified downloads (spec 16 SG-022): a file downloads into `<dest>.partial`; after a transient error
// (connection reset, timeout, HTTP 5xx/429) it retries with exponential backoff and resumes with an HTTP Range
// request from the bytes already on disk, never from zero (unless the server ignores Range). The sha256 covers the
// bytes already present (re-hashed on resume) and the rest as they arrive; the file is renamed into place only when
// size and hash match the pin. Cancellation (AbortSignal) keeps the partial file for the next attempt.
// `file://` URLs and plain paths are copied (tests, local catalogue overrides).
import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export class DownloadError extends Error {
	constructor(
		readonly code: 'DOWNLOAD_FAILED' | 'CHECKSUM',
		message: string,
		/** A later attempt may succeed (network, server). */
		readonly transient = false,
	) {
		super(message);
		this.name = 'DownloadError';
	}
}

export type DownloadSpec = { url: string; sha256: string; sizeBytes: number };

export type DownloadOptions = {
	signal?: AbortSignal;
	/** Bytes of this file present so far (including resumed bytes). */
	onProgress?(bytes: number): void;
	/** Attempts after the first (default 5). */
	retries?: number;
	/** First backoff delay (ms; doubles each retry, default 1000). */
	backoffMs?: number;
	/** Injected fetch (tests). */
	fetch?: typeof fetch;
	/** Called before each retry (tests, logs). */
	onRetry?(attempt: number, error: Error, resumeFrom: number): void;
};

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((res, rej) => {
		const t = setTimeout(res, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				rej(signal.reason ?? new Error('aborted'));
			},
			{ once: true },
		);
	});

async function hashFile(path: string, upTo: number, hash: Hash): Promise<void> {
	if (upTo <= 0) return;
	await new Promise<void>((res, rej) => {
		createReadStream(path, { start: 0, end: upTo - 1 })
			.on('data', (c) => hash.update(c))
			.on('end', () => res())
			.on('error', rej);
	});
}

function transientStatus(s: number): boolean {
	return s === 408 || s === 425 || s === 429 || s >= 500;
}

/**
 * Downloads `spec` to `dest` (verified). Resumes a `<dest>.partial` left by an earlier, interrupted or cancelled
 * attempt. Throws `DownloadError` (CHECKSUM: the partial file is deleted; DOWNLOAD_FAILED: kept for resuming).
 */
export async function downloadVerified(spec: DownloadSpec, dest: string, opts: DownloadOptions = {}): Promise<void> {
	await mkdir(dirname(dest), { recursive: true });
	const partial = `${dest}.partial`;
	if (!/^https?:/.test(spec.url)) return copyLocal(spec, dest, partial, opts);
	const retries = opts.retries ?? 5;
	const fetchFn = opts.fetch ?? fetch;
	let lastError: Error | null = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
		let have = (await stat(partial).catch(() => null))?.size ?? 0;
		if (have > spec.sizeBytes) {
			await rm(partial, { force: true });
			have = 0;
		}
		if (attempt > 0) {
			opts.onRetry?.(attempt, lastError as Error, have);
			await sleep((opts.backoffMs ?? 1000) * 2 ** (attempt - 1), opts.signal);
		}
		try {
			if (have < spec.sizeBytes) await fetchRange(spec, partial, have, fetchFn, opts);
			const hash = createHash('sha256');
			await hashFile(partial, spec.sizeBytes, hash);
			const size = (await stat(partial)).size;
			const sha = hash.digest('hex');
			if (size !== spec.sizeBytes || sha !== spec.sha256) {
				await rm(partial, { force: true });
				throw new DownloadError(
					'CHECKSUM',
					`checksum mismatch (got ${sha}, ${size} bytes; expected ${spec.sha256}, ${spec.sizeBytes} bytes)`,
				);
			}
			await rename(partial, dest);
			return;
		} catch (e) {
			if (opts.signal?.aborted) throw e;
			if (e instanceof DownloadError && !e.transient) throw e;
			lastError = e instanceof Error ? e : new Error(String(e));
		}
	}
	throw new DownloadError(
		'DOWNLOAD_FAILED',
		`Download failed after ${retries + 1} attempts: ${lastError?.message ?? 'unknown error'}`,
	);
}

/** One request from byte `from` appended to the partial file. */
async function fetchRange(
	spec: DownloadSpec,
	partial: string,
	from: number,
	fetchFn: typeof fetch,
	opts: DownloadOptions,
): Promise<void> {
	let res: Response;
	try {
		res = await fetchFn(spec.url, {
			redirect: 'follow',
			headers: from > 0 ? { Range: `bytes=${from}-` } : {},
			...(opts.signal ? { signal: opts.signal } : {}),
		});
	} catch (e) {
		if (opts.signal?.aborted) throw e;
		throw new DownloadError('DOWNLOAD_FAILED', `Download failed: ${(e as Error).message}`, true);
	}
	if (res.status === 416 && from > 0) {
		// the partial file is already complete (or longer): verification decides
		await res.body?.cancel();
		return;
	}
	if (!res.ok || !res.body)
		throw new DownloadError('DOWNLOAD_FAILED', `Download failed (HTTP ${res.status})`, transientStatus(res.status));
	let append = from > 0;
	if (from > 0 && res.status !== 206) {
		// the server ignored Range: start over (the only case that restarts from zero)
		append = false;
	} else if (from > 0) {
		const m = /bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
		if (!m || Number(m[1]) !== from) {
			await res.body.cancel();
			throw new DownloadError('DOWNLOAD_FAILED', 'The server resumed at the wrong offset', true);
		}
	}
	let got = append ? from : 0;
	const limit = spec.sizeBytes;
	const meter = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			got += chunk.length;
			// a body longer than the pinned size is never the pinned file: stop before it fills the disk
			if (got > limit)
				return cb(new DownloadError('CHECKSUM', `the download is larger than the expected ${limit} bytes`));
			opts.onProgress?.(got);
			cb(null, chunk);
		},
	});
	try {
		await pipeline(
			Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
			meter,
			createWriteStream(partial, { flags: append ? 'a' : 'w' }),
			...(opts.signal ? [{ signal: opts.signal }] : []),
		);
	} catch (e) {
		if (opts.signal?.aborted) throw e;
		if (e instanceof DownloadError) {
			if (e.code === 'CHECKSUM') await rm(partial, { force: true });
			throw e;
		}
		throw new DownloadError('DOWNLOAD_FAILED', `Download interrupted: ${(e as Error).message}`, true);
	}
}

async function copyLocal(spec: DownloadSpec, dest: string, partial: string, opts: DownloadOptions): Promise<void> {
	const src = spec.url.startsWith('file:') ? fileURLToPath(spec.url) : resolve(spec.url);
	const hash = createHash('sha256');
	let got = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			hash.update(chunk);
			got += chunk.length;
			if (got > spec.sizeBytes)
				return cb(new DownloadError('CHECKSUM', `the file is larger than the expected ${spec.sizeBytes} bytes`));
			opts.onProgress?.(got);
			cb(null, chunk);
		},
	});
	try {
		await pipeline(createReadStream(src), meter, createWriteStream(partial), ...(opts.signal ? [{ signal: opts.signal }] : []));
	} catch (e) {
		await rm(partial, { force: true });
		if (e instanceof DownloadError || opts.signal?.aborted) throw e;
		throw new DownloadError('DOWNLOAD_FAILED', `Copy failed: ${(e as Error).message}`);
	}
	const sha = hash.digest('hex');
	if (sha !== spec.sha256 || got !== spec.sizeBytes) {
		await rm(partial, { force: true });
		throw new DownloadError(
			'CHECKSUM',
			`checksum mismatch (got ${sha}, ${got} bytes; expected ${spec.sha256}, ${spec.sizeBytes} bytes)`,
		);
	}
	await rename(partial, dest);
}
