import { readFile } from 'node:fs/promises';
import {
	ImageSequenceDetectRequestSchema,
	ImageSequenceRequestSchema,
	LayeredExtractRequestSchema,
	LottieExportRequestSchema,
	MediaVariantKindSchema,
	MediaVariantRequestSchema,
	type VectorPagesResponse,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { isLoopbackHost } from '../context.ts';
import { createImportsExtension } from '../imports/extension.ts';
import { LayeredService } from '../imports/layered.ts';
import { normalizedLottieFile } from '../imports/lottie.ts';
import { exportLottie } from '../imports/lottie-export.ts';
import { lottieProber, psdProber, vectorProber } from '../imports/probers.ts';
import { detectResponse, detectSequence, ImageSequenceService } from '../imports/sequence.ts';
import { VariantService } from '../imports/variants.ts';
import { pdfPages, svgText } from '../imports/vector.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { fingerprintHex, MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { probeWithFfprobe, registerAssetProber } from '../media/probe.ts';
import type { MediaRecord } from '../media/registry.ts';
import { serveFile } from '../tools/http.ts';
import { fail, guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type K = { Params: { mediaKey: string } };
type Wait = { Querystring: { wait?: string } };

type ImportsServices = {
	variants: VariantService;
	sequences: ImageSequenceService;
	layers: LayeredService;
};

export default async function importsRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const { registry, queue } = core;
	const cacheDir = core.config.paths.cacheDir;
	const unregister = [
		registerAssetProber(lottieProber),
		registerAssetProber(vectorProber),
		registerAssetProber(psdProber(core.ffmpeg, (file) => probeWithFfprobe(core.ffmpeg, file))),
	];
	const variants = new VariantService({
		cacheDir,
		ff: core.ffmpeg,
		encoders: core.encoders,
		queue,
		registry,
		broadcaster: core.broadcaster,
	});
	variants.registerRunners();
	const sequences = new ImageSequenceService({
		mediaDir: core.config.paths.mediaDir,
		ff: core.ffmpeg,
		queue,
		media: core.media,
		uploads: core.uploads,
	});
	sequences.registerRunners();
	const layers = new LayeredService({
		mediaDir: core.config.paths.mediaDir,
		ff: core.ffmpeg,
		queue,
		registry,
		media: core.media,
	});
	layers.registerRunners();
	const services: ImportsServices = { variants, sequences, layers };
	app.jasper.services.imports = services;
	unregister.push(core.registerNativeExtension(createImportsExtension({ variants, registry })));
	app.addHook('onClose', async () => {
		for (const u of unregister) u();
	});

	const record = (key: string): MediaRecord => {
		const r = MEDIA_KEY_RE.test(key) ? registry.get(key) : null;
		if (!r) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
		return r;
	};
	const sourcePath = async (r: MediaRecord): Promise<string> => {
		const p = await registry.resolvePath(r.mediaKey);
		if (!p) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Media is offline');
		return p;
	};

	app.post<K>(
		'/api/media/:mediaKey/variants',
		guarded<K>(async (req) => {
			const r = record(req.params.mediaKey);
			const body = parseOr400(MediaVariantRequestSchema, req.body);
			try {
				await variants.ensure(r, body.kind, body.variant, { priority: 'interactive', retry: true });
				return await variants.status(r, body.kind, body.variant);
			} catch (e) {
				if ((e as { name?: string }).name === 'VariantError')
					throw new HttpError(400, (e as { code: string }).code, (e as Error).message);
				throw e;
			}
		}),
	);

	app.get<{ Params: { mediaKey: string; kind: string }; Querystring: { v?: string } }>(
		'/media/:mediaKey/variant/:kind',
		guarded<{ Params: { mediaKey: string; kind: string }; Querystring: { v?: string } }>(
			async (req, reply) => {
				const r = record(req.params.mediaKey);
				const kind = MediaVariantKindSchema.safeParse(req.params.kind.replace(/\.(png|mp4|webm|mov)$/, ''));
				if (!kind.success) return fail(reply, 404, 'NOT_FOUND', 'Unknown picture kind');
				const variant = typeof req.query.v === 'string' ? req.query.v : '';
				try {
					variants.check(r, kind.data, variant);
				} catch (e) {
					return fail(reply, 400, 'BAD_REQUEST', (e as Error).message);
				}
				if (!(await variants.isReady(r, kind.data, variant)))
					return fail(reply, 404, 'NOT_FOUND', 'Not ready');
				const p = variants.path(r, kind.data, variant);
				const type = p.endsWith('.png')
					? 'image/png'
					: p.endsWith('.webm')
						? 'video/webm'
						: p.endsWith('.mov')
							? 'video/quicktime'
							: 'video/mp4';
				return serveFile(req, reply, p, { cache: 'immutable', contentType: type });
			},
		),
	);

	app.get<K>(
		'/media/:mediaKey/lottie.json',
		guarded<K>(async (req, reply) => {
			const r = record(req.params.mediaKey);
			if (!r.lottie) return fail(reply, 404, 'NOT_FOUND', 'Not a Lottie animation');
			const file = await normalizedLottieFile(await sourcePath(r), cacheDir, fingerprintHex(r.fingerprint));
			return serveFile(req, reply, file, { cache: 'immutable', contentType: 'application/json' });
		}),
	);

	app.get<K>(
		'/media/:mediaKey/vector',
		guarded<K>(async (req, reply) => {
			const r = record(req.params.mediaKey);
			if (!r.vector) return fail(reply, 404, 'NOT_FOUND', 'Not a vector picture');
			const p = await sourcePath(r);
			if (r.vector.format === 'pdf')
				return serveFile(req, reply, p, { cache: 'immutable', contentType: 'application/pdf' });
			const text = svgText(await readFile(p), p);
			return reply
				.header('cache-control', 'public, max-age=31536000, immutable')
				.header('access-control-allow-origin', '*')
				.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
				.type('image/svg+xml; charset=utf-8')
				.send(text);
		}),
	);

	app.get<K>(
		'/api/imports/vector/:mediaKey',
		guarded<K>(async (req) => {
			const r = record(req.params.mediaKey);
			if (!r.vector) throw new HttpError(400, 'BAD_REQUEST', 'Not a vector picture');
			if (r.vector.format === 'svg') {
				const out: VectorPagesResponse = {
					mediaKey: r.mediaKey,
					vector: r.vector,
					pages: [{ page: 1, width: r.vector.width, height: r.vector.height }],
				};
				return out;
			}
			const buf = await readFile(await sourcePath(r));
			const pages = await pdfPages(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
			const out: VectorPagesResponse = { mediaKey: r.mediaKey, vector: r.vector, pages };
			return out;
		}),
	);

	const localOnly = () => {
		if (!core.config.dev && !isLoopbackHost(core.config.host))
			throw new HttpError(403, 'LOCAL_MODE_ONLY', 'Paths are only accepted in local mode');
	};

	app.post(
		'/api/imports/image-sequence/detect',
		guarded(async (req) => {
			localOnly();
			const { path } = parseOr400(ImageSequenceDetectRequestSchema, req.body);
			const d = await detectSequence(path);
			return detectResponse(d.group, d.directory);
		}),
	);

	app.post<Wait>(
		'/api/imports/image-sequence',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(ImageSequenceRequestSchema, req.body);
			if (body.path || body.paths) localOnly();
			const job = await sequences.submit(body);
			return replyWithJob(queue, job, req.query.wait, reply, 'IMAGE_SEQUENCE_FAILED');
		}),
	);

	app.post<Wait>(
		'/api/imports/layers',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(LayeredExtractRequestSchema, req.body);
			record(body.mediaKey);
			const job = layers.submit(body.mediaKey, body.projectId, body.merge);
			return replyWithJob(queue, job, req.query.wait, reply, 'LAYERS_FAILED');
		}),
	);

	app.post(
		'/api/imports/lottie/export',
		guarded(async (req) => {
			const body = parseOr400(LottieExportRequestSchema, req.body);
			if (body.outputPath) localOnly();
			return exportLottie(body, {
				registry,
				readMedia: async (key: string) => {
					const p = await registry.resolvePath(key);
					return p ? readFile(p) : null;
				},
				lottieJson: async (r: MediaRecord) =>
					JSON.parse(
						await readFile(
							await normalizedLottieFile(await sourcePath(r), cacheDir, fingerprintHex(r.fingerprint)),
							'utf8',
						),
					),
				displayPng: async (r: MediaRecord, variant: string) =>
					readFile(await variants.ensureAndWait(r, 'display', variant)),
			});
		}),
	);
}
