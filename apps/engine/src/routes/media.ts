import { join } from 'node:path';
import {
	DerivativesRequestSchema,
	MediaRegisterRequestSchema,
	type MediaRegisterResponse,
	type MediaStatus,
	MediaStatusBatchRequestSchema,
	type MediaStatusBatchResponse,
} from '@jasper/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { isLoopbackHost } from '../context.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import type { MediaRecord } from '../media/registry.ts';
import { contentTypeFor, serveFile } from '../tools/http.ts';
import { fail, guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type K = { Params: { mediaKey: string } };

/** Statuses read at once for one batch request (each is a few `stat` calls). */
const STATUS_BATCH_CONCURRENCY = 16;

export default async function mediaRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const { registry, media, derivatives } = core;

	const record = (key: string): MediaRecord => {
		const r = MEDIA_KEY_RE.test(key) ? registry.get(key) : null;
		if (!r) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
		return r;
	};

	app.post(
		'/api/media/register',
		guarded(async (req) => {
			// Path registration is a local/desktop feature (S04:SC-002). M1 engines are loopback-only, so it is
			// always local; a future remote mode must restrict it to configured media roots.
			if (!core.config.dev && !isLoopbackHost(core.config.host)) {
				throw new HttpError(403, 'LOCAL_MODE_ONLY', 'Path registration is only available in local mode');
			}
			const body = parseOr400(MediaRegisterRequestSchema, req.body);
			const items: (MediaRegisterResponse['items'][number] | undefined)[] = [];
			const errors: MediaRegisterResponse['errors'] = [];
			// Bounded parallelism: probes run through the queue (interactive lane), up to 4 at once (S04:IN-009).
			let next = 0;
			const worker = async () => {
				for (let i = next++; i < body.paths.length; i = next++) {
					const p = body.paths[i]!;
					try {
						items[i] = await media.registerPath(p, {
							projectId: body.projectId,
							...(body.copyIntoProject ? { copyIntoProject: true } : {}),
						});
					} catch (e) {
						const err = e as { code?: string; message?: string };
						errors.push({
							path: p,
							code: err.code ?? 'INTERNAL',
							message: err.message ?? 'Registration failed',
						});
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(4, body.paths.length) }, worker));
			const out: MediaRegisterResponse = { items: items.filter((x) => x !== undefined), errors };
			return out;
		}),
	);

	app.get<K>(
		'/api/media/:mediaKey',
		guarded<K>(async (req) => {
			record(req.params.mediaKey);
			return (await media.status(req.params.mediaKey))!;
		}),
	);

	// polish: many statuses in one request (a project with thousands of media opens with one round trip per batch
	// instead of one per medium). Unknown keys are listed, not an error: the media is offline for this engine.
	app.post(
		'/api/media/status',
		guarded(async (req) => {
			const { mediaKeys } = parseOr400(MediaStatusBatchRequestSchema, req.body);
			const keys = [...new Set(mediaKeys)];
			const statuses: MediaStatus[] = [];
			const unknown: string[] = [];
			let next = 0;
			const worker = async () => {
				for (let i = next++; i < keys.length; i = next++) {
					const key = keys[i]!;
					const s = MEDIA_KEY_RE.test(key) ? await media.status(key).catch(() => null) : null;
					if (s) statuses.push(s);
					else unknown.push(key);
				}
			};
			await Promise.all(Array.from({ length: Math.min(STATUS_BATCH_CONCURRENCY, keys.length) }, worker));
			const out: MediaStatusBatchResponse = { statuses, unknown };
			return out;
		}),
	);

	// M3 (S07:PRC-018): discard an uncommitted upload (Replace Footage cancelled / failed).
	app.delete<K>(
		'/api/media/:mediaKey',
		guarded<K>(async (req) => {
			const r = record(req.params.mediaKey);
			// Security review AGT-3: only engine-managed copies that no *saved* project references are deleted, but an
			// upload the user has just imported into an unsaved project is exactly that, and its bytes exist nowhere
			// else. An agent needs the user's approval.
			if (r.storage.type === 'managed' && !r.derivedFrom)
				await requireUserApproval(app, req, {
					label: 'Discard an uploaded media file',
					summary: `delete the engine's copy of "${r.originalName}"`,
					reasons: ['the file was uploaded to the engine and may exist nowhere else'],
				});
			return media.discard(req.params.mediaKey, {
				projectsDir: core.config.paths.projectsDir,
				// M3 (wp-m3-cachegc): derivatives go through the cache registry (crash-safe, pin-aware).
				cache: core.cache,
			});
		}),
	);

	app.post<K>(
		'/api/media/:mediaKey/derivatives',
		guarded<K>(async (req) => {
			const r = record(req.params.mediaKey);
			const { kinds } = parseOr400(DerivativesRequestSchema, req.body);
			return { jobs: derivatives.request(r, kinds, { priority: 'user', origin: { type: 'user' } }) };
		}),
	);

	const serveArtifact = async (
		req: FastifyRequest,
		reply: FastifyReply,
		file: string | null,
		type?: string,
	) => {
		if (!file) return fail(reply, 404, 'NOT_FOUND', 'Not ready');
		return serveFile(req, reply, file, { cache: 'immutable', ...(type ? { contentType: type } : {}) });
	};

	app.get<K>(
		'/media/:mediaKey',
		guarded<K>(async (req, reply) => {
			const r = record(req.params.mediaKey);
			const path = await registry.resolvePath(r.mediaKey);
			if (!path) return fail(reply, 404, 'ASSET_NOT_FOUND', 'Media is offline');
			const type = contentTypeFor(
				r.originalName,
				r.kind === 'audio' ? 'audio/mpeg' : 'application/octet-stream',
			);
			return serveFile(req, reply, path, { cache: 'revalidate', contentType: type });
		}),
	);

	app.get<{ Params: { mediaKey: string; tier: string } }>(
		'/media/:mediaKey/proxy/:tier',
		guarded<{ Params: { mediaKey: string; tier: string } }>(async (req, reply) => {
			const r = record(req.params.mediaKey);
			const tier = req.params.tier.replace(/\.(mp4|webm)$/, '');
			if (tier !== '720' && tier !== '540') return fail(reply, 404, 'NOT_FOUND', 'Unknown proxy tier');
			const kind = tier === '720' ? 'proxy-720' : 'proxy-540';
			const p = derivatives.paths(r.fingerprint, kind, r);
			// Alpha sources get a VP9 WebM proxy that keeps the alpha channel; everything else is MP4.
			const type = p.main.endsWith('.webm') ? 'video/webm' : 'video/mp4';
			return serveArtifact(req, reply, (await derivatives.isReady(r, kind)) ? p.main : null, type);
		}),
	);

	for (const [file, kind, contentType] of [
		['poster.jpg', 'poster', 'image/jpeg'],
		['keyframes.json', 'keyframes', 'application/json'],
		['sprite.json', 'sprite', 'application/json'],
		['peaks.json', 'peaks', 'application/json'],
		['playback-audio.json', 'playback-audio', 'application/json'],
	] as const) {
		app.get<K>(
			`/media/:mediaKey/${file}`,
			guarded<K>(async (req, reply) => {
				const r = record(req.params.mediaKey);
				return serveArtifact(
					req,
					reply,
					(await derivatives.isReady(r, kind)) ? derivatives.paths(r.fingerprint, kind).main : null,
					contentType,
				);
			}),
		);
	}

	app.get<{ Params: { mediaKey: string; sheet: string } }>(
		'/media/:mediaKey/sprite/:sheet',
		guarded<{ Params: { mediaKey: string; sheet: string } }>(async (req, reply) => {
			const r = record(req.params.mediaKey);
			const m = /^(\d{1,5})(\.jpg)?$/.exec(req.params.sheet);
			if (!m) return fail(reply, 404, 'NOT_FOUND', 'Unknown sprite sheet');
			const p = derivatives.paths(r.fingerprint, 'sprite');
			return serveArtifact(
				req,
				reply,
				(await derivatives.isReady(r, 'sprite')) ? join(p.dir!, `${Number(m[1])}.jpg`) : null,
				'image/jpeg',
			);
		}),
	);

	app.get<{ Params: { mediaKey: string; stream: string } }>(
		'/media/:mediaKey/peaks/:stream',
		guarded<{ Params: { mediaKey: string; stream: string } }>(async (req, reply) => {
			const r = record(req.params.mediaKey);
			const m = /^(\d{1,3})(\.bin)?$/.exec(req.params.stream);
			if (!m) return fail(reply, 404, 'NOT_FOUND', 'Unknown peaks stream');
			const p = derivatives.paths(r.fingerprint, 'peaks');
			return serveArtifact(
				req,
				reply,
				(await derivatives.isReady(r, 'peaks')) ? join(p.dir!, `${Number(m[1])}.bin`) : null,
				'application/octet-stream',
			);
		}),
	);

	// pp-wma-preview: one stream of the playback audio (32-bit float WAV), by container stream index.
	app.get<{ Params: { mediaKey: string; stream: string } }>(
		'/media/:mediaKey/playback-audio/:stream',
		guarded<{ Params: { mediaKey: string; stream: string } }>(async (req, reply) => {
			const r = record(req.params.mediaKey);
			const m = /^(\d{1,3})(\.wav)?$/.exec(req.params.stream);
			if (!m) return fail(reply, 404, 'NOT_FOUND', 'Unknown playback audio stream');
			const p = derivatives.paths(r.fingerprint, 'playback-audio');
			return serveArtifact(
				req,
				reply,
				(await derivatives.isReady(r, 'playback-audio')) ? join(p.dir!, `${Number(m[1])}.wav`) : null,
				'audio/wav',
			);
		}),
	);
}
