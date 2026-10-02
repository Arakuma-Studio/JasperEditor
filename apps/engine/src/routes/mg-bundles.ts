// Remotion bundles as clips (M2, S08, ARCHITECTURE §19.3). Owner: wp-m2-mg.
//   POST /api/mg-bundles/import                 {path | uploadId, watch?, projectId?} → RegisteredMedia (mg-bundle)
//   POST /api/mg-bundles/:key/rebuild           → EngineJob (mg-bundle)
//   POST /api/mg-bundles/prerender              MgPrerenderRequest → EngineJob (mg-prerender); `?wait=1` → result
//   GET  /api/mg-bundles/prerender/:renderKey   → MgPrerenderResult when cached (404 otherwise)
//   GET  /api/mg-bundles/:key/poster/:compositionId → PNG at the composition's thumbnailFrame
//   POST /api/mg-bundles/scaffold               (P1) {dir, name} → RegisteredMedia (template project, watched)
//   GET  /mg/bundles/:key/*                     the bundle's files; `index.html?jasper-host=1` = live frame host page
// Also registers the `mg` native extension, the `mg-bundle` / `mg-prerender` job runners and `features.mgBundles`.
import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import {
	MgBundleImportRequestSchema,
	MgBundleRebuildRequestSchema,
	MgBundleScaffoldRequestSchema,
	MgPrerenderRequestSchema,
	MgTextMeasureRequestSchema,
} from '@jasper/api';
import { injectHostBootstrap, MG_HOST_QUERY } from '@jasper/compositions/mg-host';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import { isLoopbackHost } from '../context.ts';
import { mgNativeExtension } from '../mg-bundles/native-ext.ts';
import { MgBundleError } from '../mg-bundles/project.ts';
import { scaffoldProject } from '../mg-bundles/scaffold.ts';
import { MgBundleService } from '../mg-bundles/service.ts';
import { serveFile } from '../tools/http.ts';
import { HttpError, parseOr400, sendServiceError } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

const MG_BUNDLES_SERVICE_KEY = 'mgBundles';

/** The service registered by this plugin (tests and other plugins). */
export function mgBundleService(app: FastifyInstance): MgBundleService | null {
	return (app.jasper.services[MG_BUNDLES_SERVICE_KEY] as MgBundleService | undefined) ?? null;
}

function mgGuarded<RG extends RouteGenericInterface = RouteGenericInterface>(
	fn: (req: FastifyRequest<RG>, reply: FastifyReply) => Promise<unknown>,
) {
	return async (req: FastifyRequest<RG>, reply: FastifyReply) => {
		try {
			return await fn(req, reply);
		} catch (e) {
			if (e instanceof MgBundleError) {
				return sendServiceError(
					reply,
					new HttpError(e.status, e.code, e.message, {
						...((e.detail as object | undefined) ?? {}),
						...(e.hint ? { hint: e.hint } : {}),
					}),
				);
			}
			return sendServiceError(reply, e);
		}
	};
}

type KeyParams = { Params: { key: string } };

export default async function mgBundleRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const localMode = core.config.dev || isLoopbackHost(core.config.host);
	const svc = new MgBundleService({ core, localMode, log: (m) => app.log.info(m) });
	app.jasper.services[MG_BUNDLES_SERVICE_KEY] = svc;
	svc.registerRunners();
	core.registerNativeExtension(mgNativeExtension(svc));
	core.registerCapabilityProvider(() => ({ features: { mgBundles: svc.capability() } }));
	app.addHook('onReady', async () => {
		await svc.start();
	});
	app.addHook('onClose', async () => {
		await svc.stop();
	});

	app.post(
		'/api/mg-bundles/import',
		mgGuarded(async (req) => {
			const body = parseOr400(MgBundleImportRequestSchema, req.body);
			if (body.path)
				return svc.importPath(body.path, {
					...(body.projectId ? { projectId: body.projectId } : {}),
					...(body.watch ? { watch: true } : {}),
				});
			return svc.importUpload(body.uploadId!, { ...(body.projectId ? { projectId: body.projectId } : {}) });
		}),
	);

	app.post<KeyParams>(
		'/api/mg-bundles/:key/rebuild',
		mgGuarded<KeyParams>(async (req, reply) => {
			const body = parseOr400(MgBundleRebuildRequestSchema, req.body ?? undefined) ?? {};
			const job = svc.rebuild(req.params.key, { ...(body.projectId ? { projectId: body.projectId } : {}) });
			if (body.watch) {
				const dir = svc.record(req.params.key)?.mgBundle?.source.path;
				if (dir) await svc.startWatch(dir, req.params.key, true);
			}
			return reply.code(202).send(job);
		}),
	);

	app.post<{ Querystring: { wait?: string } }>(
		'/api/mg-bundles/prerender',
		mgGuarded<{ Querystring: { wait?: string } }>(async (req, reply) => {
			const body = parseOr400(MgPrerenderRequestSchema, req.body);
			const job = svc.prerender(body, {
				...(body.projectId ? { projectId: body.projectId } : {}),
				origin: { type: 'user' },
			});
			if (req.query.wait === '1') {
				const done = await core.queue.wait(job.id);
				if (done.state !== 'succeeded')
					throw new HttpError(
						done.error?.code === 'INVALID_SPEC' ? 400 : 422,
						done.error?.code ?? 'MG_RENDER_FAILED',
						done.error?.message ?? done.state,
						{ jobId: done.id },
					);
				return done;
			}
			return reply.code(202).send(job);
		}),
	);

	// wp-m3-mgtext (S08:MGC-037): text layout in the engine's headless browser (agents' overflow warnings).
	app.post(
		'/api/mg-bundles/measure-texts',
		mgGuarded(async (req) => svc.measureTexts(parseOr400(MgTextMeasureRequestSchema, req.body))),
	);

	app.get<{ Params: { renderKey: string } }>(
		'/api/mg-bundles/prerender/:renderKey',
		mgGuarded<{ Params: { renderKey: string } }>(async (req) => {
			const hit = await svc.cached(req.params.renderKey);
			if (!hit) throw new HttpError(404, 'NOT_FOUND', 'No cached pre-render for this key');
			return hit;
		}),
	);

	app.get<{ Params: { key: string; compositionId: string } }>(
		'/api/mg-bundles/:key/poster/:compositionId',
		mgGuarded<{ Params: { key: string; compositionId: string } }>(async (req, reply) => {
			const file = await svc.poster(req.params.key, req.params.compositionId);
			return serveFile(req, reply, file, { cache: 'immutable', contentType: 'image/png' });
		}),
	);

	app.post(
		'/api/mg-bundles/scaffold',
		mgGuarded(async (req) => {
			if (!localMode)
				throw new HttpError(
					403,
					'LOCAL_MODE_ONLY',
					'Creating a project folder is only available in local mode',
				);
			const body = parseOr400(MgBundleScaffoldRequestSchema, req.body);
			const dir = await scaffoldProject(body.dir, body.name, { install: body.install !== false });
			return svc.importPath(dir, { ...(body.projectId ? { projectId: body.projectId } : {}), watch: true });
		}),
	);

	// The bundle's files (MGC-012). Content-addressed → immutable; the host page is generated (no-store).
	app.get<{ Params: { key: string; '*': string }; Querystring: Record<string, string | undefined> }>(
		'/mg/bundles/:key/*',
		mgGuarded<{ Params: { key: string; '*': string }; Querystring: Record<string, string | undefined> }>(
			async (req, reply) => {
				const dir = svc.bundleDir(req.params.key);
				if (!dir) throw new HttpError(404, 'NOT_FOUND', 'Unknown bundle');
				const rel = decodeURIComponent(req.params['*'] || 'index.html');
				const file = normalize(join(dir, rel));
				if (file !== dir && !file.startsWith(dir + sep)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
				if ((rel === 'index.html' || rel === '') && req.query[MG_HOST_QUERY] === '1') {
					const html = await readFile(join(dir, 'index.html'), 'utf8');
					return reply
						.code(200)
						.header('cache-control', 'no-store')
						.type('text/html; charset=utf-8')
						.send(injectHostBootstrap(html));
				}
				return serveFile(req, reply, file, {
					cache: 'immutable',
					...(file.endsWith('.html') ? { contentType: 'text/html; charset=utf-8' } : {}),
					...(file.endsWith('.js') ? { contentType: 'text/javascript; charset=utf-8' } : {}),
					...(file.endsWith('.map') ? { contentType: 'application/json' } : {}),
					...(file.endsWith('.css') ? { contentType: 'text/css; charset=utf-8' } : {}),
					...(file.endsWith('.ico') ? { contentType: 'image/x-icon' } : {}),
				});
			},
		),
	);
}
