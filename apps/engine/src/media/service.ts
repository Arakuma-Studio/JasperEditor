// Media ingest on the engine (S01:LIFE-010, S04 §5): canonicalize → fingerprint → dedupe → probe (an
// interactive-lane job) → registry record → follow-up derivative jobs (S04:IN-011).
import { copyFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { MediaStatus, RegisteredMedia } from '@jasper/api';
import type { DerivativeService } from '../derivatives/service.ts';
import type { Broadcaster } from '../events/broadcaster.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { exists, safeFileName } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import { fingerprintFile, fingerprintHex, mediaKeyFor } from './fingerprint.ts';
import { type ProbeResult, probeFile } from './probe.ts';
import type { MediaRecord, MediaRegistry } from './registry.ts';

type ProbeJobInput = { path: string; name: string };

class MediaError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'MediaError';
	}
}

export class MediaService {
	private readonly mutex = new KeyedMutex();

	constructor(
		private readonly deps: {
			mediaDir: string;
			ff: Ffmpeg;
			queue: JobQueue;
			registry: MediaRegistry;
			derivatives: DerivativeService;
			broadcaster: Broadcaster;
			/** Include `path` locators in RegisteredMedia (desktop/dev). */
			exposePaths: boolean;
		},
	) {}

	registerRunners(): void {
		this.deps.queue.registerRunner('probe', (ctx) => this.runProbe(ctx));
	}

	private async runProbe(ctx: JobContext): Promise<ProbeResult> {
		const input = ctx.input as ProbeJobInput;
		if (!(await exists(input.path)))
			throw new JobError('ASSET_NOT_FOUND', `File not found: ${input.name}`, false);
		return probeFile(this.deps.ff, input.path, { signal: ctx.signal, onSpawn: ctx.trackChild });
	}

	/** Probes through the job queue (visible in the Jobs panel) and waits for the result. */
	private async probe(
		path: string,
		fingerprint: string,
		name: string,
		projectId?: string,
	): Promise<ProbeResult> {
		const job = this.deps.queue.submit({
			kind: 'probe',
			title: `Probe – ${name}`,
			priority: 'interactive',
			cpuSlots: 1,
			origin: { type: 'user' },
			...(projectId ? { projectId } : {}),
			dedupeKey: `probe:${fingerprintHex(fingerprint)}`,
			input: { path, name } satisfies ProbeJobInput,
		});
		const done = await this.deps.queue.wait(job.id);
		if (done.state !== 'succeeded') {
			const code =
				done.error?.code === 'TOOL_FAILED' ? 'UNSUPPORTED_MEDIA' : (done.error?.code ?? 'INTERNAL');
			throw new MediaError(code, done.error?.message ?? `Probe ${done.state}`);
		}
		return done.result as ProbeResult;
	}

	/**
	 * Registers an engine-local file by path (local/dev mode only, S04:SC-002). `copyIntoProject` makes a
	 * managed copy under `<appdir>/media/<mediaKey>/` instead of referencing the file in place.
	 */
	async registerPath(
		rawPath: string,
		opts: { projectId?: string; copyIntoProject?: boolean } = {},
	): Promise<RegisteredMedia> {
		if (!isAbsolute(rawPath)) throw new MediaError('BAD_REQUEST', 'Paths must be absolute');
		let path: string;
		try {
			path = await realpath(resolve(rawPath));
		} catch {
			throw new MediaError('ASSET_NOT_FOUND', 'File not found');
		}
		const st = await stat(path).catch(() => null);
		if (!st?.isFile()) throw new MediaError('ASSET_NOT_FOUND', 'Not a regular file');
		const { fingerprint, sizeBytes } = await fingerprintFile(path);
		const mediaKey = mediaKeyFor(fingerprint);
		return this.mutex.run(mediaKey, async () => {
			const existing = this.deps.registry.get(mediaKey);
			if (existing && (await this.deps.registry.availability(mediaKey)) === 'online') {
				this.deps.derivatives.autoQueue(existing, opts.projectId);
				return this.deps.registry.toRegistered(existing, { exposePath: this.deps.exposePaths });
			}
			const probe = existing ?? (await this.probe(path, fingerprint, basename(path), opts.projectId));
			let storage: MediaRecord['storage'] = { type: 'path', path };
			let mtimeMs = st.mtimeMs;
			if (opts.copyIntoProject) {
				const dest = join(this.deps.mediaDir, mediaKey, safeFileName(basename(path)));
				await mkdir(join(this.deps.mediaDir, mediaKey), { recursive: true });
				await copyFile(path, dest);
				storage = { type: 'managed', path: dest };
				mtimeMs = (await stat(dest)).mtimeMs;
			}
			const record = this.makeRecord(
				mediaKey,
				fingerprint,
				basename(path),
				sizeBytes,
				mtimeMs,
				storage,
				probe,
			);
			await this.deps.registry.put(record);
			this.announce(record, opts.projectId);
			return this.deps.registry.toRegistered(record, { exposePath: this.deps.exposePaths });
		});
	}

	/**
	 * Registers a completed upload: moves `tmpFile` to `<appdir>/media/<mediaKey>/<name>` (or discards it
	 * when the same content is already managed) and probes it.
	 */
	async registerUploaded(
		tmpFile: string,
		originalName: string,
		opts: { projectId?: string } = {},
	): Promise<RegisteredMedia> {
		const { fingerprint, sizeBytes } = await fingerprintFile(tmpFile);
		const mediaKey = mediaKeyFor(fingerprint);
		return this.mutex.run(mediaKey, async () => {
			const existing = this.deps.registry.get(mediaKey);
			if (existing && (await this.deps.registry.availability(mediaKey)) === 'online') {
				await rm(tmpFile, { force: true });
				this.deps.derivatives.autoQueue(existing, opts.projectId);
				return this.deps.registry.toRegistered(existing, { exposePath: this.deps.exposePaths });
			}
			const dir = join(this.deps.mediaDir, mediaKey);
			await mkdir(dir, { recursive: true });
			const dest = join(dir, safeFileName(originalName, 'media'));
			await rename(tmpFile, dest);
			let probe: ProbeResult;
			try {
				probe = await this.probe(dest, fingerprint, originalName, opts.projectId);
			} catch (e) {
				await rm(dir, { recursive: true, force: true });
				throw e;
			}
			const mtimeMs = (await stat(dest)).mtimeMs;
			const record = this.makeRecord(
				mediaKey,
				fingerprint,
				safeFileName(originalName, 'media'),
				sizeBytes,
				mtimeMs,
				{ type: 'managed', path: dest },
				probe,
			);
			await this.deps.registry.put(record);
			this.announce(record, opts.projectId);
			return this.deps.registry.toRegistered(record, { exposePath: this.deps.exposePaths });
		});
	}

	/**
	 * Registers a file the engine produced itself (M2, S07:PRC-003: a processed version). The file stays where
	 * the producer wrote it (a content-addressed managed location); the record carries `derivedFrom`. The
	 * usual derivatives follow, plus `proxy-720` (mandatory: browsers cannot decode ProRes).
	 */
	async registerDerived(
		file: string,
		opts: { fromMediaKey: string; recipeHash: string; name: string; projectId?: string },
	): Promise<RegisteredMedia> {
		const st = await stat(file).catch(() => null);
		if (!st?.isFile()) throw new MediaError('ASSET_NOT_FOUND', 'Processed file not found');
		const { fingerprint, sizeBytes } = await fingerprintFile(file);
		const mediaKey = mediaKeyFor(fingerprint);
		return this.mutex.run(mediaKey, async () => {
			const existing = this.deps.registry.get(mediaKey);
			let record: MediaRecord;
			if (existing && (await this.deps.registry.availability(mediaKey)) === 'online') {
				record = existing.derivedFrom
					? existing
					: { ...existing, derivedFrom: { mediaKey: opts.fromMediaKey, recipeHash: opts.recipeHash } };
				if (record !== existing) await this.deps.registry.put(record);
			} else {
				const probe = await this.probe(file, fingerprint, opts.name, opts.projectId);
				record = {
					...this.makeRecord(
						mediaKey,
						fingerprint,
						opts.name,
						sizeBytes,
						st.mtimeMs,
						{ type: 'managed', path: file },
						probe,
					),
					derivedFrom: { mediaKey: opts.fromMediaKey, recipeHash: opts.recipeHash },
				};
				await this.deps.registry.put(record);
				this.deps.broadcaster.publish('media.updated', { mediaKey, status: 'processing' }, opts.projectId);
			}
			this.deps.derivatives.autoQueue(record, opts.projectId);
			if (record.kind === 'video')
				this.deps.derivatives.request(record, ['proxy-720'], {
					...(opts.projectId ? { projectId: opts.projectId } : {}),
				});
			return this.deps.registry.toRegistered(record, { exposePath: this.deps.exposePaths });
		});
	}

	private makeRecord(
		mediaKey: string,
		fingerprint: string,
		originalName: string,
		sizeBytes: number,
		mtimeMs: number,
		storage: MediaRecord['storage'],
		p: ProbeResult | MediaRecord,
	): MediaRecord {
		return {
			mediaKey,
			fingerprint,
			originalName,
			sizeBytes,
			mtimeMs,
			container: p.container,
			kind: p.kind,
			probe: p.probe,
			browserPlayable: p.browserPlayable,
			storage,
			durationSec: p.durationSec,
			display: p.display,
			hasAudio: p.hasAudio,
			interlaced: !!p.interlaced,
			registeredAt: new Date().toISOString(),
			...(p.lut ? { lut: p.lut } : {}),
		};
	}

	private announce(r: MediaRecord, projectId?: string): void {
		this.deps.broadcaster.publish('media.updated', { mediaKey: r.mediaKey, status: 'processing' }, projectId);
		this.deps.derivatives.autoQueue(r, projectId);
	}

	/** `GET /api/media/:key` (ARCHITECTURE §9.2). */
	async status(mediaKey: string): Promise<MediaStatus | null> {
		const r = this.deps.registry.get(mediaKey);
		if (!r) return null;
		const online = (await this.deps.registry.availability(mediaKey)) === 'online';
		const derivatives = await this.deps.derivatives.status(r);
		const busy = Object.values(derivatives).some((d) => d.state === 'queued' || d.state === 'running');
		return { mediaKey, status: online ? (busy ? 'processing' : 'online') : 'missing', derivatives };
	}
}
