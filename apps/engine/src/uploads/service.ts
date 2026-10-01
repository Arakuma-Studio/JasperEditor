// Resumable chunked uploads (S04:IN-005, SC-005, ARCHITECTURE §9.2): create a session (disk-space check) →
// PUT chunks at byte offsets (a wrong offset is rejected with the expected one) → complete (size verified,
// file moved to `<appdir>/media/<mediaKey>/`, probed, derivatives queued). Sessions expire after 24 h idle.
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type RegisteredMedia, UPLOAD_CHUNK_BYTES, type UploadCreateRequest } from '@jasper/api';
import type { MediaService } from '../media/service.ts';
import { atomicWriteJson, freeDiskBytes, randomId, readJsonOrNull, safeFileName } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';

const UPLOAD_TTL_MS = 24 * 3600 * 1000;
/** Keep this much free space beyond the upload itself. */
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;
const UPLOAD_ID_RE = /^up_[0-9a-f]{24}$/;

type Session = {
	uploadId: string;
	projectId: string;
	fileName: string;
	byteSize: number;
	/** M2 (wp-m2-mg): `mg-bundle` uploads are completed by the bundle import, not the media registry. */
	purpose?: 'media' | 'mg-bundle';
	touchedAt: string;
};

class UploadError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'UploadError';
	}
}

export class UploadService {
	private readonly mutex = new KeyedMutex();
	private sweepTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly deps: {
			/** `<appdir>/media/.uploads` */
			dir: string;
			media: MediaService;
			now?: () => number;
			/** Test hook: override the free-space probe. */
			freeBytes?: (dir: string) => Promise<number | null>;
		},
	) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private sessionDir(id: string): string {
		return join(this.deps.dir, id);
	}
	private dataFile(id: string): string {
		return join(this.sessionDir(id), 'data.part');
	}
	private metaFile(id: string): string {
		return join(this.sessionDir(id), 'session.json');
	}

	start(): void {
		void this.sweep();
		this.sweepTimer = setInterval(() => void this.sweep(), 3600_000);
		this.sweepTimer.unref();
	}

	stop(): void {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
	}

	async create(req: UploadCreateRequest): Promise<{ uploadId: string; chunkSize: number; offset: number }> {
		await mkdir(this.deps.dir, { recursive: true });
		const free = await (this.deps.freeBytes ?? freeDiskBytes)(this.deps.dir);
		if (free !== null && free < req.byteSize + DISK_MARGIN_BYTES) {
			throw new UploadError('DISK_FULL', 507, 'Not enough free disk space for this upload', {
				freeBytes: free,
				needed: req.byteSize + DISK_MARGIN_BYTES,
			});
		}
		const uploadId = randomId('up', 12);
		const t = new Date(this.now()).toISOString();
		const session: Session = {
			uploadId,
			projectId: req.projectId,
			fileName: safeFileName(req.fileName, 'upload.bin'),
			byteSize: req.byteSize,
			...(req.purpose && req.purpose !== 'media' ? { purpose: req.purpose } : {}),
			touchedAt: t,
		};
		await mkdir(this.sessionDir(uploadId), { recursive: true });
		await atomicWriteJson(this.metaFile(uploadId), session);
		await writeFile(this.dataFile(uploadId), '');
		return { uploadId, chunkSize: UPLOAD_CHUNK_BYTES, offset: 0 };
	}

	private async load(uploadId: string): Promise<Session> {
		if (!UPLOAD_ID_RE.test(uploadId)) throw new UploadError('UPLOAD_NOT_FOUND', 404, 'Unknown upload');
		const s = await readJsonOrNull<Session>(this.metaFile(uploadId));
		if (!s) throw new UploadError('UPLOAD_NOT_FOUND', 404, 'Unknown upload');
		if (this.now() - Date.parse(s.touchedAt) > UPLOAD_TTL_MS) {
			await rm(this.sessionDir(uploadId), { recursive: true, force: true });
			throw new UploadError('UPLOAD_NOT_FOUND', 404, 'Upload session expired');
		}
		return s;
	}

	private async currentOffset(uploadId: string): Promise<number> {
		try {
			return (await stat(this.dataFile(uploadId))).size;
		} catch {
			return 0;
		}
	}

	/** Appends a chunk at `offset`; returns the new offset. Chunks are serialized per session. */
	append(
		uploadId: string,
		offset: number,
		body: Readable,
		contentLength?: number,
	): Promise<{ offset: number }> {
		return this.mutex.run(uploadId, async () => {
			const s = await this.load(uploadId);
			const current = await this.currentOffset(uploadId);
			if (offset !== current) {
				body.resume();
				throw new UploadError('UPLOAD_OFFSET_MISMATCH', 409, `Expected offset ${current}`, {
					expectedOffset: current,
				});
			}
			if (contentLength !== undefined && current + contentLength > s.byteSize) {
				body.resume();
				throw new UploadError('UPLOAD_SIZE_MISMATCH', 400, 'Chunk exceeds the declared file size', {
					byteSize: s.byteSize,
				});
			}
			let written = 0;
			const limit = s.byteSize - current;
			const out = createWriteStream(this.dataFile(uploadId), { flags: 'a' });
			try {
				await pipeline(
					body,
					async function* (source: AsyncIterable<Buffer>) {
						for await (const chunk of source) {
							written += chunk.length;
							if (written > limit) {
								throw new UploadError('UPLOAD_SIZE_MISMATCH', 400, 'Chunk exceeds the declared file size', {
									byteSize: s.byteSize,
								});
							}
							yield chunk;
						}
					},
					out,
				);
			} catch (e) {
				// Roll the file back to the last acknowledged offset so the client can resume cleanly.
				await truncate(this.dataFile(uploadId), current).catch(() => undefined);
				throw e;
			}
			s.touchedAt = new Date(this.now()).toISOString();
			await atomicWriteJson(this.metaFile(uploadId), s);
			return { offset: current + written };
		});
	}

	/** Verifies the size, then hands the file to the media service (probe, registry, derivatives). */
	complete(uploadId: string): Promise<RegisteredMedia> {
		return this.mutex.run(uploadId, async () => {
			const s = await this.load(uploadId);
			const size = await this.currentOffset(uploadId);
			if (size !== s.byteSize) {
				throw new UploadError('UPLOAD_SIZE_MISMATCH', 409, `Received ${size} of ${s.byteSize} bytes`, {
					expectedOffset: size,
					byteSize: s.byteSize,
				});
			}
			if (s.purpose === 'mg-bundle')
				throw new UploadError(
					'BAD_REQUEST',
					409,
					'This upload is a Remotion bundle: complete it with POST /api/mg-bundles/import {uploadId}',
				);
			const media = await this.deps.media.registerUploaded(this.dataFile(uploadId), s.fileName, {
				projectId: s.projectId,
			});
			await rm(this.sessionDir(uploadId), { recursive: true, force: true });
			return media;
		});
	}

	/**
	 * M2 (wp-m2-mg, additive): hands a fully received upload of `purpose` to its consumer (a bundle zip for
	 * `POST /api/mg-bundles/import`). `release()` deletes the session once the consumer is done with the file.
	 */
	take(
		uploadId: string,
		purpose: 'mg-bundle',
	): Promise<{ file: string; fileName: string; projectId: string; release(): Promise<void> }> {
		return this.mutex.run(uploadId, async () => {
			const s = await this.load(uploadId);
			if (s.purpose !== purpose)
				throw new UploadError(
					'BAD_REQUEST',
					409,
					`Upload ${uploadId} was not created with purpose ${purpose}`,
				);
			const size = await this.currentOffset(uploadId);
			if (size !== s.byteSize)
				throw new UploadError('UPLOAD_SIZE_MISMATCH', 409, `Received ${size} of ${s.byteSize} bytes`, {
					expectedOffset: size,
					byteSize: s.byteSize,
				});
			return {
				file: this.dataFile(uploadId),
				fileName: s.fileName,
				projectId: s.projectId,
				release: () => rm(this.sessionDir(uploadId), { recursive: true, force: true }),
			};
		});
	}

	abort(uploadId: string): Promise<void> {
		return this.mutex.run(uploadId, async () => {
			await this.load(uploadId);
			await rm(this.sessionDir(uploadId), { recursive: true, force: true });
		});
	}

	/** Removes sessions idle for more than 24 h (S04:SC-005). */
	async sweep(): Promise<number> {
		let removed = 0;
		let names: string[];
		try {
			names = await readdir(this.deps.dir);
		} catch {
			return 0;
		}
		for (const id of names) {
			if (!UPLOAD_ID_RE.test(id)) continue;
			const s = await readJsonOrNull<Session>(this.metaFile(id));
			const touched = s ? Date.parse(s.touchedAt) : 0;
			if (this.mutex.isBusy(id)) continue;
			if (!s || this.now() - touched > UPLOAD_TTL_MS) {
				await rm(this.sessionDir(id), { recursive: true, force: true });
				removed++;
			}
		}
		return removed;
	}
}
