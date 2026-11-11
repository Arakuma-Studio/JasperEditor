import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import {
	LOCAL_ENGINE_ID,
	MgBundleImportRequestSchema,
	MgBundleRebuildRequestSchema,
	type MgBundleRebuiltEvent,
	MgBundleScaffoldRequestSchema,
	MgHtmlImportRequestSchema,
	MgPrerenderRequestSchema,
	MgTextMeasureRequestSchema,
} from '@jasper/api';
import { injectHostBootstrap, injectHtmlHostBootstrap, MG_HOST_QUERY } from '@jasper/compositions/mg-host';
import type { ProjectDocument } from '@jasper/project';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { allowedHosts, isLoopbackHost, MG_SANDBOX_PREFIX, mgSandboxScope } from '../context.ts';
import { mgHostCsp } from '../mg-bundles/csp.ts';
import { mgNativeExtension } from '../mg-bundles/native-ext.ts';
import { MgBundleError } from '../mg-bundles/project.ts';
import { scaffoldProject } from '../mg-bundles/scaffold.ts';
import { MgBundleService } from '../mg-bundles/service.ts';
import { serveFile } from '../tools/http.ts';
import { HttpError, parseOr400, sendServiceError } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

export { mgHostCsp } from '../mg-bundles/csp.ts';

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
	const svc = new MgBundleService({
		core,
		localMode,
		log: (m) => app.log.info(m),
		relinkHeadless: (projectId, ev) =>
			relinkClosedProject(app.jasper.services.agent as AgentService | undefined, projectId, ev),
	});
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

	app.post(
		'/api/mg-bundles/import-html',
		mgGuarded(async (req) => {
			const body = parseOr400(MgHtmlImportRequestSchema, req.body);
			return svc.importHtml(body, {
				...(body.projectId ? { projectId: body.projectId } : {}),
				...(body.watch ? { watch: true } : {}),
			});
		}),
	);

	app.post<KeyParams>(
		'/api/mg-bundles/:key/rebuild',
		mgGuarded<KeyParams>(async (req, reply) => {
			const body = parseOr400(MgBundleRebuildRequestSchema, req.body ?? undefined) ?? {};
			const job = svc.rebuild(req.params.key, { ...(body.projectId ? { projectId: body.projectId } : {}) });
			if (body.watch) {
				const dir = svc.record(req.params.key)?.mgBundle?.source.path;
				if (dir) await svc.startWatch(dir, req.params.key, true, body.projectId);
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

	//
	// Security review MG-1. A bundle is somebody's code; its page must not run with the editor's origin (the engine
	// API with the user's session, the editor's DOM, `window.jasper`, the desktop bridge). So:
	//  - `/mg/sandbox/<capability>/<key>/…` is where a bundle's page and everything it loads lives. The capability
	//    in the path authorises reading that bundle's files without a cookie (server.ts), because the page is a
	//    sandboxed iframe with an opaque origin. Every response carries a Content-Security-Policy that sandboxes the
	//    document again (also when somebody opens the URL in a tab), limits what it may load to its own files,
	//    `data:`, `blob:` and `https:`, and lets only the editor frame it.
	//  - `/mg/bundles/<key>/…` (authenticated like every engine route) is the address the editor knows. The host
	//    page (`index.html?jasper-host=1`) redirects to the capability path; every other file is served as inert
	//    data (`Content-Security-Policy: sandbox`, no scripts), like any other user content.
	type FileRoute = {
		Params: { key: string; '*': string };
		Querystring: Record<string, string | undefined>;
	};
	const bundleFile = (
		key: string,
		rest: string,
	): { dir: string; rel: string; file: string; entry: string; html: boolean } => {
		const dir = svc.bundleDir(key);
		if (!dir) throw new HttpError(404, 'NOT_FOUND', 'Unknown bundle');
		// The page: index.html of a Remotion bundle, the entry file of an HTML composition.
		const record = svc.record(key);
		const entry = record ? svc.entryOf(record) : 'index.html';
		let rel: string;
		try {
			rel = decodeURIComponent(rest || entry);
		} catch {
			throw new HttpError(404, 'NOT_FOUND', 'Not found');
		}
		const file = normalize(join(dir, rel));
		if (rel.includes('\0') || (file !== dir && !file.startsWith(dir + sep)))
			throw new HttpError(404, 'NOT_FOUND', 'Not found');
		return { dir, rel, file, entry, html: !!record?.mgBundle?.html };
	};
	/** The query string of a request without the host marker (an HTML page's own parameters). */
	const pageQuery = (url: string): string =>
		(url.split('?')[1] ?? '')
			.split('&')
			.filter((kv) => kv && kv.split('=')[0] !== MG_HOST_QUERY)
			.join('&');
	const bundleTypes = (file: string) => ({
		...(/\.html?$/.test(file) ? { contentType: 'text/html; charset=utf-8' } : {}),
		...(file.endsWith('.wasm') ? { contentType: 'application/wasm' } : {}),
		...(file.endsWith('.js') ? { contentType: 'text/javascript; charset=utf-8' } : {}),
		...(file.endsWith('.map') ? { contentType: 'application/json' } : {}),
		...(file.endsWith('.css') ? { contentType: 'text/css; charset=utf-8' } : {}),
		...(file.endsWith('.ico') ? { contentType: 'image/x-icon' } : {}),
	});

	app.get<FileRoute>(
		'/mg/bundles/:key/*',
		mgGuarded<FileRoute>(async (req, reply) => {
			const { rel, file, entry, html } = bundleFile(req.params.key, req.params['*']);
			if ((rel === entry || rel === '') && req.query[MG_HOST_QUERY] === '1') {
				const cap = core.signer.capability(mgSandboxScope(req.params.key));
				// HTML compositions keep their query string (the page reads it), host marker last.
				const q = html ? pageQuery(req.url) : '';
				return reply
					.code(302)
					.header('cache-control', 'no-store')
					.header('referrer-policy', 'no-referrer')
					.header(
						'location',
						`${MG_SANDBOX_PREFIX}${cap}/${encodeURIComponent(req.params.key)}/${encodeURIComponent(entry)}?${q ? `${q}&` : ''}${MG_HOST_QUERY}=1`,
					)
					.send();
			}
			return serveFile(req, reply, file, { cache: 'immutable', ...bundleTypes(file) });
		}),
	);

	type SandboxRoute = {
		Params: { cap: string; key: string; '*': string };
		Querystring: Record<string, string | undefined>;
	};
	app.get<SandboxRoute>(
		`${MG_SANDBOX_PREFIX}:cap/:key/*`,
		mgGuarded<SandboxRoute>(async (req, reply) => {
			// The capability was verified by the auth hook (server.ts); checked again here so the route is safe by itself.
			if (!core.signer.verifyCapability(mgSandboxScope(req.params.key), req.params.cap))
				throw new HttpError(403, 'FORBIDDEN', 'Invalid bundle capability');
			const { dir, rel, file, entry, html } = bundleFile(req.params.key, req.params['*']);
			const scheme = req.protocol === 'https' ? 'https' : 'http';
			const host = String(req.headers.host ?? '').toLowerCase();
			const csp = mgHostCsp({
				base: `${scheme}://${host}${MG_SANDBOX_PREFIX}${req.params.cap}/${encodeURIComponent(req.params.key)}/`,
				ancestors: [...allowedHosts(core.config)].map((h) => `${scheme}://${h}`),
				// HTML compositions: the policy of the engine's headless renders (html.ts), CDN scripts included.
				remoteScripts: html,
			});
			const headers = { 'content-security-policy': csp, 'referrer-policy': 'no-referrer' };
			if ((rel === entry || rel === '') && req.query[MG_HOST_QUERY] === '1') {
				const page = await readFile(join(dir, entry), 'utf8');
				return reply
					.code(200)
					.headers({ ...headers, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
					.type('text/html; charset=utf-8')
					.send(html ? injectHtmlHostBootstrap(page) : injectHostBootstrap(page));
			}
			return serveFile(req, reply, file, {
				cache: 'immutable',
				// Scripts run here, inside the sandbox the policy below imposes on any document of this path.
				allowScripts: true,
				extraHeaders: headers,
				...bundleTypes(file),
			});
		}),
	);
}

/**
 * Relinks the asset of a rebuilt bundle in a project no editor has open (watch + headless agents, e.g. an HTML page
 * saved while an agent works through MCP): one `media.relink` transaction, like the open editor's system relink.
 * False when an editor holds the project (it relinks on `mgBundle.rebuilt`), or the project does not use the bundle.
 */
async function relinkClosedProject(
	agent: AgentService | undefined,
	projectId: string,
	ev: MgBundleRebuiltEvent,
): Promise<boolean> {
	if (!agent || agent.isLive(projectId) || !(await agent.projectExists(projectId))) return false;
	const q = await agent.query({ projectId, query: 'doc.get', args: {} });
	const doc = q.result as ProjectDocument | undefined;
	const asset = Object.values(doc?.media ?? {}).find(
		(m) => m.kind === 'mg-bundle' && m.locators.some((l) => l.type === 'engine-store' && l.key === ev.oldKey),
	);
	if (!asset) return false;
	const loc = asset.locators.find((l) => l.type === 'engine-store');
	const res = await agent.transact(
		projectId,
		{
			protocol: 'jasper.tx/1',
			label: ev.mgBundle.html ? 'Reload HTML composition' : 'Rebuild Remotion bundle',
			origin: { agent: 'watch' },
			commands: [
				{
					type: 'media.relink',
					mediaId: asset.id,
					locator: {
						type: 'engine-store',
						engineId: loc?.type === 'engine-store' ? loc.engineId : LOCAL_ENGINE_ID,
						key: ev.newKey,
					},
					fingerprint: `q1:${ev.mgBundle.bundleHash}`,
					mgBundle: ev.mgBundle,
					...(ev.sizeBytes !== undefined ? { sizeBytes: ev.sizeBytes } : {}),
				},
			],
		} as never,
		{ fallbackAgent: 'watch' },
	);
	return res.result.ok;
}
