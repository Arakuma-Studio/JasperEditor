// Layer bake (M2, S11 §6, ARCHITECTURE §20.5). Owner: wp-m2-layer-bake.
//   POST /api/layer-bake/preview   graded VP9-alpha preview of one DOM layer (S11:LBK-010) → 202 EngineJob
//                                  (`?wait=1` → the finished job, result LayerBakePreviewResult)
//   GET  /mg/layers/:key/:file     cached bake files (master.mov, still.png, preview.webm; graded.png?n=<frame>: frame
//                                  n of the graded PNG sequence), Range, signable (the Remotion path loads graded
//                                  masters through one signed URL per entry)
// Also registers the `layer-bake` native extension (text, shapes and anime templates exported through cached alpha
// masters), the `layer-bake` job runner, the `features.layerBake` capability block and the cache GC.
// Registered after `mg-bundles` and before `tracking` (extension order, ARCHITECTURE §19.6).
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { LayerBakePreviewRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { layerBakeExtension } from '../layer-bake/extension.ts';
import { hasColorEffects, isDomLayer } from '../layer-bake/layer.ts';
import { bakeParallelismFromEnv, LayerBakeService } from '../layer-bake/service.ts';
import { serveFile } from '../tools/http.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

const LAYER_BAKE_SERVICE_KEY = 'layerBake';

const CONTENT_TYPES: Record<string, string> = {
	'master.mov': 'video/quicktime',
	'graded.png': 'image/png',
	'still.png': 'image/png',
	'preview.webm': 'video/webm',
};

export default async function layerBakeRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new LayerBakeService({
		core,
		log: (m) => app.log.info(m),
		parallelism: bakeParallelismFromEnv(process.env),
	});
	app.jasper.services[LAYER_BAKE_SERVICE_KEY] = svc;
	svc.registerRunners();
	const unregisterExt = core.registerNativeExtension(layerBakeExtension(svc));
	const unregisterCap = core.registerCapabilityProvider(() => ({
		features: { layerBake: svc.capability() },
	}));
	app.addHook('onReady', async () => {
		await svc.start();
	});
	app.addHook('onClose', async () => {
		svc.stop();
		unregisterExt();
		unregisterCap();
	});

	app.post<{ Querystring: { wait?: string } }>(
		'/api/layer-bake/preview',
		guarded<{ Querystring: { wait?: string } }>(async (req, reply) => {
			const body = parseOr400(LayerBakePreviewRequestSchema, req.body);
			const reason = svc.unavailableReason();
			if (reason)
				throw new HttpError(
					503,
					'LAYER_BAKE_UNAVAILABLE',
					`Graphics previews need the Remotion renderer: ${reason}`,
				);
			// Planned like an export of the whole sequence (media resolution, fonts); PlanErrors map to their status.
			const planned = await core.exports.plan({
				envelope: body.envelope,
				sequenceId: body.sequenceId,
				settings: {
					sequenceId: body.sequenceId,
					range: { type: 'entire' },
					container: 'mp4',
					engine: 'auto',
					destination: { type: 'download' },
				},
			});
			const clip = planned.snapshot.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === body.clipId);
			if (!clip)
				throw new HttpError(
					404,
					'NOT_FOUND',
					`Clip ${body.clipId} is not drawn in sequence ${body.sequenceId}`,
				);
			if (!isDomLayer(clip))
				throw new HttpError(
					422,
					'NOT_A_GRAPHICS_LAYER',
					`Clip "${clip.name}" is not a text, shape or anime template`,
				);
			if (!hasColorEffects(clip))
				throw new HttpError(422, 'LAYER_NOT_GRADED', `Clip "${clip.name}" has no colour effects to preview`);
			const env = await svc.environment();
			const bake = await svc.planBake(planned, clip, { env });
			const ac = new AbortController();
			const grade = await svc.planGrade(planned, clip, bake, {
				extensions: core.exports.nativeExtensions.all(),
				signal: ac.signal,
				scratchDir: () => mkdtemp(join(core.config.paths.tmpDir, 'layer-preview-')),
				log: (t) => app.log.info(t),
				jobId: 'layer-bake-preview',
			});
			const projectId = body.projectId ?? planned.document.projectId;
			const job = svc.submitPreview(bake, grade, {
				...(projectId ? { projectId } : {}),
				origin: { type: 'user' },
			});
			// M3 (wp-m3-cachegc): the project's latest preview of this clip needs the bake and its graded entry
			// (replaced on the next preview of the clip; dropped when the project is deleted).
			if (projectId)
				core.cache.setRefs(`layer-preview:${projectId}:${body.clipId}`, projectId, [
					join(svc.dir, bake.key),
					join(svc.dir, grade.key),
				]);
			if (req.query.wait === '1') {
				const done = await core.queue.wait(job.id);
				if (done.state !== 'succeeded')
					throw new HttpError(
						422,
						done.error?.code ?? 'LAYER_BAKE_FAILED',
						done.error?.message ?? done.state,
						{
							jobId: done.id,
						},
					);
				return done;
			}
			return reply.code(202).send(job);
		}),
	);

	app.get<{ Params: { key: string; file: string }; Querystring: { n?: string } }>(
		'/mg/layers/:key/:file',
		guarded<{ Params: { key: string; file: string }; Querystring: { n?: string } }>(async (req, reply) => {
			const n = req.query.n === undefined ? 0 : Number(req.query.n);
			const path = svc.filePath(req.params.key, req.params.file, n);
			if (!path) throw new HttpError(404, 'NOT_FOUND', 'No such layer bake file');
			return serveFile(req, reply, path, {
				cache: 'immutable',
				contentType: CONTENT_TYPES[req.params.file] ?? 'application/octet-stream',
			});
		}),
	);
}
